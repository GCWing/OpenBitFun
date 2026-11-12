import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Icon } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { contextMenuController } from '@/shared/context-menu-system/core/ContextMenuController';
import { ContextType, type CustomContext, type MenuItem } from '@/shared/context-menu-system/types';
import { notificationService } from '@/shared/notification-system';
import {
  canCopyImageSource,
  copyImageToClipboard,
  CrossOriginImageError,
} from '@/shared/utils/imageClipboard';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ImageLightboxCopy');
const COPIED_FEEDBACK_MS = 1500;

/**
 * Copy-to-clipboard for an expanded image: a button in the lightbox chrome and
 * a right-click menu on the image. Both report the outcome with a toast.
 * `canCopy` is false for images that cannot be read back (a remote image on
 * another origin); owners hide the button and the menu stays native.
 */
export function useImageLightboxCopy(source: string | null | undefined) {
  const { t } = useI18n('components');
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const canCopy = canCopyImageSource(source);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copy = useCallback(async () => {
    if (!source) return;
    try {
      await copyImageToClipboard(source);
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      notificationService.success(t('imageLightbox.copySuccess'), { duration: 2000 });
    } catch (error) {
      log.warn('Failed to copy image to clipboard', { error });
      const message = error instanceof CrossOriginImageError
        ? t('imageLightbox.copyCrossOrigin')
        : t('imageLightbox.copyFailed');
      notificationService.error(message, { duration: 4000 });
    }
  }, [source, t]);

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!canCopy) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    const position = { x: event.clientX, y: event.clientY };
    const items: MenuItem[] = [{
      id: 'image-lightbox-copy',
      label: t('imageLightbox.copy'),
      icon: <Icon name="duplicate" size="sm" />,
      onClick: () => { void copy(); },
    }];
    const context: CustomContext = {
      type: ContextType.CUSTOM,
      customType: 'image-lightbox',
      data: {},
      event: event.nativeEvent,
      targetElement: event.currentTarget,
      position,
      timestamp: Date.now(),
    };
    void contextMenuController.show(position, items, context);
  }, [canCopy, copy, t]);

  return { canCopy, copied, copy, onContextMenu };
}
