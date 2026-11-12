import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Copy } from 'lucide-react';
import { Icon } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';
import { contextMenuController } from '@/shared/context-menu-system/core/ContextMenuController';
import { ContextType, type CustomContext, type MenuItem } from '@/shared/context-menu-system/types';
import { notificationService } from '@/shared/notification-system';
import { copyImageToClipboard } from '@/shared/utils/imageClipboard';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ImageLightboxCopy');
const COPIED_FEEDBACK_MS = 1500;

/**
 * Copy-to-clipboard for an expanded image: a button in the lightbox chrome and
 * a right-click menu on the image. Both report the outcome with a toast.
 */
export function useImageLightboxCopy(source: string | null | undefined) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

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
      notificationService.success(i18nService.t('components:imageLightbox.copySuccess'), { duration: 2000 });
    } catch (error) {
      log.warn('Failed to copy image to clipboard', { error });
      notificationService.error(i18nService.t('components:imageLightbox.copyFailed'), { duration: 4000 });
    }
  }, [source]);

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    const position = { x: event.clientX, y: event.clientY };
    const items: MenuItem[] = [{
      id: 'image-lightbox-copy',
      label: i18nService.t('components:imageLightbox.copy'),
      icon: <Icon glyph={Copy} size="sm" />,
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
  }, [copy, source]);

  return { copied, copy, onContextMenu };
}
