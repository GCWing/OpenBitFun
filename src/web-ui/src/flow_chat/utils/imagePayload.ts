import type { ImageContext } from '@/shared/types/context';
import type { ImageContextData as ImageInputContextData } from '@/infrastructure/api/service-api/ImageContextTypes';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { createLogger } from '@/shared/utils/logger';
import { getMimeTypeFromFilename } from './imageUtils';

const log = createLogger('imagePayload');

// Above this the inline copy costs more than it is worth: the pixels would be
// duplicated into durable turn storage for every client that cannot read the
// path itself. Such images keep their path and render as a named placeholder.
const MAX_INLINE_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ImageDisplayData {
  id: string;
  name: string;
  dataUrl?: string;
  imagePath?: string;
  mimeType?: string;
}

export interface ImagePayload {
  imageContexts: ImageInputContextData[];
  imageDisplayData: ImageDisplayData[];
}

export async function buildImagePayload(imageContexts: ImageContext[]): Promise<ImagePayload | undefined> {
  if (imageContexts.length === 0) {
    return undefined;
  }

  const scope = getActiveSurfaceScope();
  const acceptsInline = isLocalSurface(scope.surfaceId)
    || peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.inlineImageAttachmentsV1 === true;
  const clipboardImages = imageContexts.filter(ctx => !ctx.isLocal && ctx.dataUrl);
  const uploadedImagePaths = new Map<string, string>();

  if (!acceptsInline && clipboardImages.length > 0) {
    const uploadResults = await api.invoke<Array<{ id: string; image_path?: string | null }>>(
      'upload_image_contexts',
      {
        request: {
          images: clipboardImages.map(ctx => ({
            id: ctx.id,
            image_path: ctx.imagePath || null,
            data_url: ctx.dataUrl || null,
            mime_type: ctx.mimeType,
            image_name: ctx.imageName,
            file_size: ctx.fileSize,
            width: ctx.width || null,
            height: ctx.height || null,
            source: ctx.source,
          })),
        },
      }
    );

    scope.assertCurrent('prepare image attachments');
    for (const result of uploadResults) {
      if (result.image_path) {
        uploadedImagePaths.set(result.id, result.image_path);
      }
    }
  }

  // A dropped local file arrives as a path only, so clients that cannot reach
  // this host's filesystem (mobile) would receive an attachment with nothing to
  // draw. Read the pixels here, where the path is still resolvable, exactly the
  // way the desktop renderer resolves them for display.
  const inlinedLocalPixels = await inlineLocalImagePixels(imageContexts);
  if (inlinedLocalPixels.size > 0) {
    scope.assertCurrent('inline local image attachments');
  }
  const pixelsFor = (ctx: ImageContext): string | undefined =>
    ctx.dataUrl || inlinedLocalPixels.get(ctx.id);

  return {
    imageContexts: imageContexts.map(ctx => ({
      id: ctx.id,
      image_path: ctx.isLocal ? ctx.imagePath : uploadedImagePaths.get(ctx.id),
      // Retain pixels for durable host storage and Detached Dispatch. Older
      // peer hosts still receive their upload path through the legacy branch.
      data_url: pixelsFor(ctx),
      mime_type: ctx.mimeType,
      metadata: {
        name: ctx.imageName,
        width: ctx.width,
        height: ctx.height,
        file_size: ctx.fileSize,
        source: ctx.source,
      },
    })),
    imageDisplayData: imageContexts.map(ctx => ({
      id: ctx.id,
      name: ctx.imageName || 'Image',
      dataUrl: pixelsFor(ctx),
      imagePath: ctx.isLocal ? ctx.imagePath : uploadedImagePaths.get(ctx.id),
      mimeType: ctx.mimeType,
    })),
  };
}

async function inlineLocalImagePixels(imageContexts: ImageContext[]): Promise<Map<string, string>> {
  const inlined = new Map<string, string>();
  const pending = imageContexts.filter(ctx =>
    ctx.isLocal
    && ctx.imagePath
    && !ctx.dataUrl
    && !(typeof ctx.fileSize === 'number' && ctx.fileSize > MAX_INLINE_LOCAL_IMAGE_BYTES)
  );

  await Promise.all(pending.map(async ctx => {
    const imagePath = ctx.imagePath as string;
    try {
      // Attachment paths belong to the runtime host; the transport routes this
      // read there, so never build a local asset URL from the path.
      const base64 = await workspaceAPI.readFileContent(imagePath, 'base64');
      if (base64) {
        inlined.set(ctx.id, `data:${ctx.mimeType || getMimeTypeFromFilename(imagePath)};base64,${base64}`);
      }
    } catch (cause) {
      // The path still travels with the attachment, so hosts that can read it
      // keep working. Only pixel-only clients lose the preview.
      log.warn('Failed to inline local image pixels', { imagePath, error: cause });
    }
  }));

  return inlined;
}
