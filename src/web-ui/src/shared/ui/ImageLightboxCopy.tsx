import { Icon, IconButton } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';

/** Lightbox chrome button; the owning lightbox positions it beside its close control. */
export function ImageLightboxCopyButton({ className, copied, onCopy }: {
  className?: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n('components');
  const label = t('imageLightbox.copy');
  return (
    <IconButton
      className={className}
      aria-label={label}
      title={label}
      icon={<Icon name={copied ? 'check-line' : 'duplicate'} size="md" />}
      size="sm"
      variant="quiet"
      onClick={event => {
        event.stopPropagation();
        onCopy();
      }}
    />
  );
}
