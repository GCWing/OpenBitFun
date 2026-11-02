import { Dialog, DialogClose, Icon } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { i18nService } from '@/infrastructure/i18n';
import './ImageLightbox.scss';

export interface ImageLightboxState {
  /** Image bytes or URL already resolved by the owning surface. */
  source: string;
  alt?: string;
}

/**
 * Full-size preview for an image rendered by any product surface.
 *
 * The caller owns the state: an inline image, a tool-result image and a
 * composer attachment all resolve their own bytes, so the surface that
 * resolved them owns the overlay as well. Only the previewed image is declared
 * as an Appearance part here; the scrim and the close control are
 * design-system `dialog` chrome that this component restyles.
 */
export function ImageLightbox({ image, onClose }: {
  image: ImageLightboxState | null;
  onClose: () => void;
}) {
  if (!image) return null;
  const label = image.alt || i18nService.t('components:imageLightbox.label');
  return (
    <Dialog
      open
      aria-label={label}
      onOpenChange={onClose}
      portalTarget={getAppearanceOverlayHost()}
      className="image-lightbox-surface"
      overlayProps={{
        className: 'image-lightbox',
        'data-openbitfun-native-webview-occlusion': true,
      }}
      autoFocus={false}
      restoreFocus={false}
      trapFocus={false}
      preventScroll={false}
      closeOnPointerOutside={false}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <DialogClose className="image-lightbox-close" icon={<Icon name="xmark" size="lg" style={{ width: 20, height: 20 }} />} />
      <img
        src={image.source}
        alt={image.alt ?? ''}
        data-openbitfun-component="image-lightbox"
        data-openbitfun-part="image"
      />
    </Dialog>
  );
}
