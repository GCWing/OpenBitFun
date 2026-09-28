import React, { useRef, useEffect } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, Menu, MenuItem, Icon } from '@openbitfun/ui';
import { Infinity as InfinityIcon } from 'lucide-react';
import { ToolDuration, formatDurationPrecise } from '@openbitfun/ui/flow-chat';
import { useTranslation } from 'react-i18next';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { useLiveElapsedTime } from '../hooks/useLiveElapsedTime';
import { useSubagentTimeoutControl } from '../hooks/useSubagentTimeoutControl';
import './ToolTimeoutIndicator.scss';

export interface ToolTimeoutIndicatorProps {
  startTime?: number;
  isRunning: boolean;
  showIcon?: boolean;
  timeoutMs?: number;
  showControls?: boolean;
  subagentSessionId?: string;
  completedDurationMs?: number;
  completedStatus?: 'success' | 'error' | 'cancelled';
  completedTooltip?: string;
  completedFailureReason?: string;
  defaultTimeoutDisabled?: boolean;
  showCompletedDuration?: boolean;
}

export const ToolTimeoutIndicator: React.FC<ToolTimeoutIndicatorProps> = ({
  startTime,
  isRunning,
  showIcon = true,
  timeoutMs,
  showControls = false,
  subagentSessionId,
  completedDurationMs,
  completedStatus,
  completedTooltip,
  completedFailureReason,
  defaultTimeoutDisabled = false,
  showCompletedDuration = true,
}) => {
  const { t } = useTranslation('flow-chat');
  const remainingMsRef = useRef<number | null>(null);

  const {
    isTimeoutDisabled,
    isToggling,
    isPopoverOpen,
    toggleTimeout,
    extendTimeout,
    closePopover,
    remainingAtDisable,
  } = useSubagentTimeoutControl(
    subagentSessionId,
    isRunning,
    timeoutMs,
    remainingMsRef.current,
    defaultTimeoutDisabled,
  );

  const { elapsedMs, remainingMs } = useLiveElapsedTime(
    startTime,
    isRunning,
    timeoutMs,
    isTimeoutDisabled,
  );
  remainingMsRef.current = remainingMs;

  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverLayout = useAnchoredPopoverPosition({
    open: isPopoverOpen,
    anchorRef: triggerRef,
    popoverRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 4,
    layoutRevision: remainingAtDisable,
  });

  // Close popover on outside click.
  useEffect(() => {
    if (!isPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !controlRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) {
        closePopover();
      }
    };
    const removeOverlayMousedown0 = subscribeOverlayInteraction(popoverRef, 'mousedown', handleClick);
    return () => removeOverlayMousedown0?.();
  }, [isPopoverOpen, closePopover]);

  // Close popover on Escape.
  useEffect(() => {
    if (!isPopoverOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover();
    };
    const removeOverlayKeydown1 = subscribeOverlayInteraction(popoverRef, 'keydown', handleKey);
    return () => removeOverlayKeydown1?.();
  }, [isPopoverOpen, closePopover]);

  // Completed state: show precise duration when the card is expanded.
  if (!isRunning && completedDurationMs != null && showCompletedDuration) {
    const durationLabel = formatDurationPrecise(completedDurationMs);
    const completionLabel = completedTooltip || (
      completedStatus === 'success'
        ? t('toolCards.timeout.completedDurationTooltip', {
          duration: durationLabel,
        })
        : completedStatus === 'error'
          ? completedFailureReason
            ? t('toolCards.timeout.failedDurationTooltipWithReason', {
              duration: durationLabel,
              reason: completedFailureReason,
            })
            : t('toolCards.timeout.failedDurationTooltip', {
              duration: durationLabel,
            })
          : completedStatus === 'cancelled'
            ? t('toolCards.timeout.cancelledDurationTooltip', {
              duration: durationLabel,
            })
            : t('toolCards.timeout.durationTooltip', {
              duration: durationLabel,
            })
    );

    return <ToolDuration isRunning={false} showIcon={showIcon} completedDurationMs={completedDurationMs}
      completedStatus={completedStatus} completionLabel={completionLabel} />;
  }

  // Not running and no completed duration: nothing to show.
  if (!isRunning) return null;

  const hasTimeout = Boolean(timeoutMs && timeoutMs > 0);
  const canControlTimeout = showControls && hasTimeout && Boolean(subagentSessionId);
  return (
    <ToolDuration isRunning showIcon={showIcon} elapsedMs={elapsedMs} remainingMs={remainingMs} timeoutMs={timeoutMs}
      timeoutDisabled={isTimeoutDisabled} open={isPopoverOpen}>
      {canControlTimeout && (
        <div data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="controls" className="timeout-control-wrapper" ref={controlRef}>
          <button
            ref={triggerRef}
            type="button"
            data-openbitfun-component="tool-timeout-indicator"
            data-openbitfun-part="toggle"
            className={`timeout-ignore-btn ${isTimeoutDisabled ? 'is-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleTimeout();
            }}
            disabled={isToggling}
            title={
              isTimeoutDisabled
                ? t('toolCards.timeout.enableTooltip')
                : t('toolCards.timeout.disableTooltip')
            }
          >
            <Icon glyph={InfinityIcon} size="xs" />
            <span className="timeout-ignore-btn__label">
              {isTimeoutDisabled
                ? t('toolCards.timeout.enableLabel')
                : t('toolCards.timeout.disableLabel')}
            </span>
          </button>

          {isPopoverOpen && createOverlayPortal(
            <Menu
              ref={popoverRef}
              data-openbitfun-component="tool-timeout-indicator"
              data-openbitfun-part="popover"
              data-openbitfun-placement={popoverLayout?.placement ?? 'bottom'}
              className="timeout-extend-popover"
              style={{
                top: `${popoverLayout?.top ?? 0}px`,
                left: `${popoverLayout?.left ?? 0}px`,
                visibility: popoverLayout ? 'visible' : 'hidden',
              }}
              aria-label={t('toolCards.timeout.disableTooltip')}
              autoFocusFirstItem
            >
              {remainingAtDisable > 0 ? (
                <MenuItem
                  data-openbitfun-component="tool-timeout-indicator"
                  data-openbitfun-part="option"
                  onClick={(e) => {
                    e.stopPropagation();
                    extendTimeout(remainingAtDisable);
                  }}
                >
                  {t('toolCards.timeout.restoreShort', { seconds: remainingAtDisable })}
                </MenuItem>
              ) : null}
              <MenuItem
                data-openbitfun-component="tool-timeout-indicator"
                data-openbitfun-part="option"
                onClick={(e) => {
                  e.stopPropagation();
                  extendTimeout(60);
                }}
              >
                +1m
              </MenuItem>
              <MenuItem
                data-openbitfun-component="tool-timeout-indicator"
                data-openbitfun-part="option"
                onClick={(e) => {
                  e.stopPropagation();
                  extendTimeout(300);
                }}
              >
                +5m
              </MenuItem>
              <MenuItem
                data-openbitfun-component="tool-timeout-indicator"
                data-openbitfun-part="option"
                onClick={(e) => {
                  e.stopPropagation();
                  extendTimeout(600);
                }}
              >
                +10m
              </MenuItem>
            </Menu>,
            getAppearanceOverlayHost(),
          )}
        </div>
      )}
    </ToolDuration>
  );
};
