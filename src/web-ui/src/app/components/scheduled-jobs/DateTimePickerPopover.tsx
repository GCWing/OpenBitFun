/**
 * Day picker for `LocalizedDateTimeField`.
 *
 * Replaces the browser's own picker, which was driven through `showPicker()` on
 * a hidden anchor input and would not dismiss after a selection — its
 * open/close lifecycle assumes a real, hit-testable anchor. Rendering the grid
 * in-app puts that lifecycle under our control, and keeps the calendar in the
 * app's own locale and theme.
 *
 * Scope is deliberately the date only: the time is easier to type than to click,
 * and the text field already accepts it.
 */

import { subscribeOverlayInteraction, createOverlayPortal, Button, Icon, IconButton } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { computeFixedPopoverPosition } from '@/shared/utils/fixedPopoverViewport';

const POPOVER_WIDTH = 268;
const POPOVER_HEIGHT = 300;

/** Six-week grid (42 local days) covering the month `monthAnchorMs` falls in. */
function buildMonthGrid(monthAnchorMs: number): Date[] {
  const anchor = new Date(monthAnchorMs);
  const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export interface DateTimePickerPopoverProps {
  /** Element the popover is positioned against. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Currently selected day, or null when the field is empty. */
  selected: Date | null;
  onSelect: (day: Date) => void;
  onClose: () => void;
}

const DateTimePickerPopover: React.FC<DateTimePickerPopoverProps> = ({
  anchorRef,
  selected,
  onSelect,
  onClose,
}) => {
  const { t, formatDate } = useI18n('common');
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const [monthAnchorMs, setMonthAnchorMs] = useState(() => {
    const base = selected ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1).getTime();
  });
  const [position, setPosition] = useState(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    return rect
      ? computeFixedPopoverPosition(rect, POPOVER_WIDTH, POPOVER_HEIGHT)
      : { top: 0, left: 0 };
  });

  // Reposition against the live popover size once it has painted, and keep it
  // anchored while the surrounding form scrolls.
  useEffect(() => {
    const reposition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const element = popoverRef.current;
      setPosition(computeFixedPopoverPosition(
        rect,
        element?.offsetWidth ?? POPOVER_WIDTH,
        element?.offsetHeight ?? POPOVER_HEIGHT,
      ));
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const removeOverlayMousedown0 = subscribeOverlayInteraction(popoverRef, 'mousedown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(popoverRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [anchorRef, onClose]);

  const grid = useMemo(() => buildMonthGrid(monthAnchorMs), [monthAnchorMs]);
  const anchorDate = useMemo(() => new Date(monthAnchorMs), [monthAnchorMs]);
  const today = useMemo(() => new Date(), []);

  const weekdayLabels = useMemo(
    () => grid.slice(0, 7).map(day => formatDate(day, { weekday: 'narrow' })),
    [formatDate, grid],
  );

  const shiftMonth = useCallback((delta: number) => {
    setMonthAnchorMs(current => {
      const date = new Date(current);
      return new Date(date.getFullYear(), date.getMonth() + delta, 1).getTime();
    });
  }, []);

  return createOverlayPortal(
    <div
      ref={popoverRef}
      className="openbitfun-datetime-picker"
      data-openbitfun-component="datetime-picker"
      data-openbitfun-part="root"
      data-testid="datetime-picker"
      role="dialog"
      aria-label={t('dateTimeField.pickerLabel')}
      style={{ top: position.top, left: position.left }}
    >
      <header className="openbitfun-datetime-picker__head" data-openbitfun-component="datetime-picker" data-openbitfun-part="head">
        <IconButton
          type="button"
          size="sm"
          aria-label={t('dateTimeField.previousMonth')}
          icon={<Icon name="chevron-left" size="lg" />}
          onClick={() => shiftMonth(-1)}
        />
        <span className="openbitfun-datetime-picker__month">
          {formatDate(anchorDate, { year: 'numeric', month: 'long' })}
        </span>
        <IconButton
          type="button"
          size="sm"
          aria-label={t('dateTimeField.nextMonth')}
          icon={<Icon name="chevron-right" size="lg" />}
          onClick={() => shiftMonth(1)}
        />
      </header>

      <div className="openbitfun-datetime-picker__weekdays" aria-hidden="true">
        {weekdayLabels.map((label, index) => (
          <span key={index} className="openbitfun-datetime-picker__weekday">{label}</span>
        ))}
      </div>

      <div className="openbitfun-datetime-picker__grid" role="grid" data-openbitfun-component="datetime-picker" data-openbitfun-part="grid">
        {grid.map(day => {
          const isCurrentMonth = day.getMonth() === anchorDate.getMonth();
          const isSelected = selected != null && isSameDay(day, selected);
          const isToday = isSameDay(day, today);

          return (
            <button
              key={day.getTime()}
              type="button"
              role="gridcell"
              className={[
                'openbitfun-datetime-picker__day',
                isCurrentMonth ? '' : 'openbitfun-datetime-picker__day--outside',
                isToday ? 'openbitfun-datetime-picker__day--today' : '',
                isSelected ? 'openbitfun-datetime-picker__day--selected' : '',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="datetime-picker"
              data-openbitfun-part="day"
              data-openbitfun-state={isSelected ? 'selected' : isToday ? 'today' : undefined}
              aria-pressed={isSelected}
              aria-label={formatDate(day, { year: 'numeric', month: 'long', day: 'numeric' })}
              onClick={() => onSelect(day)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>

      <footer className="openbitfun-datetime-picker__foot" data-openbitfun-component="datetime-picker" data-openbitfun-part="foot">
        <Button size="sm" variant="outline" onClick={() => onSelect(new Date())}>
          {t('dateTimeField.now')}
        </Button>
        <Button size="sm" variant="fill" onClick={onClose}>
          {t('dateTimeField.close')}
        </Button>
      </footer>
    </div>,
    getAppearanceOverlayHost(),
  );
};

export default DateTimePickerPopover;
