import { ChevronDown as LucideChevronDown } from 'lucide-react';
/**
 * Scroll-to-bottom button.
 * Shows when the user scrolls up; click to return to latest messages.
 */

import React, { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RetainedMountBoundary } from '@/shared/presence';
import { Tooltip } from '@openbitfun/ui';
import './ScrollToBottomButton.scss';

interface ScrollToBottomButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  visible: boolean;
  onClick: () => void;
  unreadCount?: number; // Optional: show unread message count.
  className?: string;
  focusReturnRef?: React.RefObject<HTMLElement | null>;
}

export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  visible,
  onClick,
  unreadCount,
  className = '',
  focusReturnRef,
  ...buttonProps
}) => {
  const { t } = useTranslation('flow-chat');
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!visible && buttonRef.current?.contains(document.activeElement)) {
      const focusTarget = focusReturnRef?.current;
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
      } else {
        buttonRef.current.blur();
      }
    }
  }, [focusReturnRef, visible]);

  return (
    <RetainedMountBoundary present={visible}>
      <Tooltip content={t('scroll.toBottom')} disabled={!visible}>
        <button data-openbitfun-icon-slot="true" data-openbitfun-component="scroll-to-bottom-button" data-openbitfun-part="root"
          ref={buttonRef}
          {...buttonProps}
          data-visible={visible ? 'true' : 'false'}
          className={`scroll-to-bottom-button ${className}`}
          onClick={visible ? onClick : undefined}
          aria-hidden={!visible}
          aria-label={unreadCount ? t('scroll.toBottomWithCount', { count: unreadCount }) : t('scroll.toBottom')}
          tabIndex={visible ? buttonProps.tabIndex : -1}
          {...(!visible ? { inert: '' } : {})}
        >
          <LucideChevronDown data-openbitfun-component="scroll-to-bottom-button" data-openbitfun-part="icon" className="scroll-icon" size="var(--openbitfun-control-icon-size-md)" aria-hidden="true" />
          {unreadCount !== undefined && unreadCount > 0 && (
            <span data-openbitfun-component="scroll-to-bottom-button" data-openbitfun-part="badge" className="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
        </button>
      </Tooltip>
    </RetainedMountBoundary>
  );
};
