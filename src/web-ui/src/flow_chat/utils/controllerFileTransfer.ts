/**
 * Composer attachments from the controller device.
 *
 * When the session executes on another host (Peer Device Mode), on a remote
 * workspace, or as a detached job, a path dropped or pasted into the composer
 * belongs to this controller. Images are read here and sent as pixels; other
 * files are staged in the execution host's runtime `attachments/` directory,
 * which its agent tools resolve, when that host supports it.
 */
import {
  readControllerFileBytes,
  randomHex,
  uploadBytesToHost,
} from '@/infrastructure/files/controllerFiles';
import {
  isLocalSurface,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import type { ImageContext } from '@/shared/types/context';
import { controllerAttachmentFileName } from './externalFileIntake';
import { createImageContextFromFile, getMimeTypeFromFilename } from './imageUtils';

export {
  getControllerClipboardFiles,
  getControllerClipboardImage,
  getControllerFileMetadata,
} from '@/infrastructure/files/controllerFiles';

/** Bounded so an accidental large drop cannot stall the relay or the host. */
export const MAX_CONTROLLER_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Read a controller image into an inline (pixel-carrying) image context. */
export async function readControllerImageContext(
  path: string,
  name: string,
): Promise<ImageContext> {
  const bytes = await readControllerFileBytes(path);
  const file = new File([bytes as BlobPart], name, { type: getMimeTypeFromFilename(name) });
  const context = await createImageContextFromFile(file);
  if (!context.dataUrl) {
    throw new Error('Image pixels could not be read');
  }
  return { ...context, isLocal: false, imagePath: '' };
}

/**
 * Whether the execution host of the given surface accepts controller files.
 * The local surface is this build; a peer must have negotiated the capability.
 */
export function canUploadControllerFiles(scope: SurfaceScope): boolean {
  if (isLocalSurface(scope.surfaceId)) return true;
  return peerConnectionManager.get(scope.surfaceId)?.getState()
    .capabilities.runtimeAttachmentUploadV1 === true;
}

export interface UploadControllerFileOptions {
  path: string;
  name: string;
  /** Workspace record the session executes in; scopes the runtime URI. */
  workspaceId: string;
  scope: SurfaceScope;
  isCurrent: () => boolean;
}

/**
 * Stage a controller file on the execution host and return the runtime URI
 * its agent tools resolve. Every host call is checked against the surface
 * scope captured by the caller so a device switch never redirects the bytes.
 */
export async function uploadControllerFileToRuntime(
  options: UploadControllerFileOptions,
): Promise<string> {
  const bytes = await readControllerFileBytes(options.path);
  if (bytes.byteLength > MAX_CONTROLLER_ATTACHMENT_BYTES) {
    throw new Error('File is too large to send');
  }
  const hostPath = buildRuntimeAttachmentUri(
    options.workspaceId,
    randomHex(8),
    controllerAttachmentFileName(options.name),
  );
  await uploadBytesToHost({
    bytes,
    path: hostPath,
    workspaceId: options.workspaceId,
    assertCurrent: () => {
      options.scope.assertCurrent('upload composer attachment');
      if (!options.isCurrent()) throw new Error('Composer target changed');
    },
  });
  return hostPath;
}

export function buildRuntimeAttachmentUri(
  workspaceId: string,
  uploadId: string,
  fileName: string,
): string {
  return `openbitfun://runtime/${workspaceId}/attachments/${uploadId}/${fileName}`;
}
