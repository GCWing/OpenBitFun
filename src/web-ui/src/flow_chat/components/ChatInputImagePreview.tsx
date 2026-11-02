import { useEffect, useState } from 'react';
import { Icon } from '@openbitfun/ui';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { ImageLightbox } from '@/shared/ui/ImageLightbox';
import type { ImageContext } from '@/types/context';
import { getMimeTypeFromFilename } from '../utils/imageUtils';

export function ChatInputImagePreview({ image, surfaceEpoch }: {
  image: ImageContext;
  surfaceEpoch: number;
}) {
  const { t } = useI18n('tools');
  const embedded = image.dataUrl;
  const path = image.imagePath;
  const [loaded, setLoaded] = useState<{ imageId: string; path: string; epoch: number; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ imageId: string; path: string; epoch: number } | null>(null);
  const previewRequested = previewRequest?.imageId === image.id
    && previewRequest.path === path && previewRequest.epoch === surfaceEpoch;
  const originalSource = embedded || (loaded?.imageId === image.id && loaded.path === path
    && loaded.epoch === surfaceEpoch ? loaded.source : undefined);
  const source = image.thumbnailUrl || originalSource;
  // Legacy attachments may carry only a thumbnail. Prefer original bytes or a
  // host read whenever available; the chip's 200px JPEG is not a full preview.
  const previewSource = originalSource || (!path ? image.thumbnailUrl : undefined);

  useEffect(() => {
    setError(null);
    setPreviewRequest(null);
  }, [embedded, path, image.id, surfaceEpoch]);

  useEffect(() => {
    let cancelled = false;
    if (!originalSource && path && (!image.thumbnailUrl || previewRequested)) {
      // Paths belong to the runtime host, just like sent-message attachments.
      // Read through the transport; never turn them into controller asset URLs.
      void workspaceAPI.readFileContent(path, 'base64').then(content => {
        if (!cancelled && getActiveSurfaceScope().epoch === surfaceEpoch) {
          setLoaded({ imageId: image.id, path, epoch: surfaceEpoch,
            source: `data:${image.mimeType || getMimeTypeFromFilename(path)};base64,${content}` });
        }
      }).catch(cause => {
        if (!cancelled && getActiveSurfaceScope().epoch === surfaceEpoch) setError(String(cause));
      });
    }
    return () => { cancelled = true; };
  }, [originalSource, path, image.id, image.mimeType, image.thumbnailUrl, previewRequested, surfaceEpoch]);

  return source && !error ? (
    <>
      <button
        type="button"
        className="openbitfun-chat-input__image-chip-preview"
        aria-label={i18nService.t('components:imageLightbox.label')}
        onClick={() => setPreviewRequest({ imageId: image.id, path, epoch: surfaceEpoch })}
      >
        <img className="openbitfun-chat-input__image-chip-thumb"
          data-openbitfun-component="chat-input" data-openbitfun-part="imagePreview"
          src={source} alt={image.imageName} onError={() => setError(image.imageName)} />
      </button>
      <ImageLightbox
        image={previewRequested && previewSource ? { source: previewSource, alt: image.imageName } : null}
        onClose={() => setPreviewRequest(null)}
      />
    </>
  ) : (
    <div className="openbitfun-chat-input__image-chip-thumb openbitfun-chat-input__image-chip-thumb--placeholder"
      data-openbitfun-component="chat-input" data-openbitfun-part="imagePreview"
      role={error ? 'img' : undefined}
      aria-label={error ? t('editor.imageViewer.loadImageFailedWithMessage', { message: error }) : undefined}
      title={error ? t('editor.imageViewer.loadImageFailedWithMessage', { message: error }) : image.imageName}>
      <Icon name="image" size="sm" />
    </div>
  );
}
