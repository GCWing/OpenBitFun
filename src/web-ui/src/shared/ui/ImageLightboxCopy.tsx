import { Check, Copy } from 'lucide-react';
import { Icon, IconButton } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';

/** Lightbox chrome button; the owning lightbox positions it beside its close control. */
export function ImageLightboxCopyButton({ className, copied, onCopy }: {
  className?: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const label = i18nService.t('components:imageLightbox.copy');
  return (
    <IconButton
      className={className}
      aria-label={label}
      title={label}
      icon={<Icon glyph={copied ? Check : Copy} size="md" />}
      size="sm"
      variant="quiet"
      onClick={event => {
        event.stopPropagation();
        onCopy();
      }}
    />
  );
}
