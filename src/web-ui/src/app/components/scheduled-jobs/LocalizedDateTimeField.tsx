/**
 * Date-time entry whose field order follows the app locale.
 *
 * A native `<input type="datetime-local">` renders in the *browser's* locale,
 * which Chromium takes from the OS and does not read from the `lang`
 * attribute. Running the UI in Chinese on an English system therefore shows
 * `08/12/2026, 04:48 AM` inside an otherwise Chinese form.
 *
 * This is an ordinary text input so it looks and behaves like every other field
 * in the form, showing `2026/08/12 04:48` in Chinese and `08/12/2026 04:48` in
 * English, with an in-app day picker on the calendar button. Callers keep the
 * native `YYYY-MM-DDTHH:mm` value contract.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconButton, Input, Tooltip } from '@openbitfun/ui';
import { CalendarDays } from 'lucide-react';

import { useI18n } from '@/infrastructure/i18n';
import DateTimePickerPopover from './DateTimePickerPopover';
import {
  dateTimeFormatHint,
  formatDateTimeText,
  parseDateTimeText,
  resolveDateFieldOrder,
} from './localizedDateTime';

/** Time a picked day falls back to when the field has no time yet. */
const DEFAULT_TIME = { hour: 9, minute: 0 };

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export interface LocalizedDateTimeFieldProps {
  id?: string;
  /** `YYYY-MM-DDTHH:mm`, matching the native datetime-local value. */
  value: string;
  onChange: (value: string) => void;
  error?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const LocalizedDateTimeField: React.FC<LocalizedDateTimeFieldProps> = ({
  id,
  value,
  onChange,
  error = false,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}) => {
  const { t, currentLanguage } = useI18n('common');
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editingRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const order = useMemo(() => resolveDateFieldOrder(currentLanguage), [currentLanguage]);

  // Local text so partial input survives; a fully controlled field would reject
  // every keystroke until the whole date parsed, which makes it untypable.
  const [text, setText] = useState(() => formatDateTimeText(value, order));

  // Adopt external changes (loading a job, switching locale) unless the user is
  // mid-edit, where overwriting their keystrokes would fight them.
  useEffect(() => {
    if (editingRef.current) return;
    setText(formatDateTimeText(value, order));
  }, [order, value]);

  const commitText = useCallback((nextText: string) => {
    setText(nextText);

    if (!nextText.trim()) {
      onChange('');
      return;
    }

    const parsed = parseDateTimeText(nextText, order);
    if (parsed) onChange(parsed);
  }, [onChange, order]);

  const handleBlur = useCallback(() => {
    editingRef.current = false;

    // Normalize whatever parsed into the canonical rendering, so `2026/8/2 4:8`
    // settles as `2026/08/02 04:08` instead of staying half-typed.
    const parsed = text.trim() ? parseDateTimeText(text, order) : null;
    setText(parsed ? formatDateTimeText(parsed, order) : text);
  }, [order, text]);

  /** Day currently represented by the field, for highlighting in the picker. */
  const selectedDay = useMemo(() => {
    const parsed = parseDateTimeText(text, order) ?? (value.trim() || null);
    if (!parsed) return null;
    const timestamp = new Date(parsed).getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }, [order, text, value]);

  const handlePickDay = useCallback((day: Date) => {
    // Keep whatever time is already set; picking a day should not silently
    // rewind the clock to midnight.
    const existing = selectedDay;
    const hour = existing ? existing.getHours() : DEFAULT_TIME.hour;
    const minute = existing ? existing.getMinutes() : DEFAULT_TIME.minute;

    const next = [
      String(day.getFullYear()).padStart(4, '0'),
      pad(day.getMonth() + 1),
      pad(day.getDate()),
    ].join('-') + `T${pad(hour)}:${pad(minute)}`;

    editingRef.current = false;
    setText(formatDateTimeText(next, order));
    onChange(next);
    setPickerOpen(false);
  }, [onChange, order, selectedDay]);

  return (
    <div
      ref={anchorRef}
      className={['openbitfun-datetime-field', className ?? ''].filter(Boolean).join(' ')}
      data-openbitfun-component="localized-datetime-field"
      data-openbitfun-part="root"
      data-openbitfun-state={error ? 'error' : undefined}
    >
      <Input
        id={id}
        value={text}
        invalid={error}
        disabled={disabled}
        inputMode="numeric"
        placeholder={dateTimeFormatHint(order)}
        aria-label={ariaLabel ?? t('dateTimeField.label')}
        aria-describedby={ariaDescribedBy}
        className="openbitfun-datetime-field__input"
        onFocus={() => { editingRef.current = true; }}
        onChange={event => commitText(event.currentTarget.value)}
        onBlur={handleBlur}
        size="sm"
      />

      <Tooltip content={t('dateTimeField.openPicker')} disabled={disabled}>
        <IconButton
          ref={pickerTriggerRef}
          type="button"
          size="sm"
          disabled={disabled}
          aria-label={t('dateTimeField.openPicker')}
          aria-expanded={pickerOpen}
          icon={<CalendarDays />}
          onClick={() => setPickerOpen(open => !open)}
        />
      </Tooltip>

      {pickerOpen && !disabled ? (
        <DateTimePickerPopover
          anchorRef={anchorRef}
          triggerRef={pickerTriggerRef}
          selected={selectedDay}
          onSelect={handlePickDay}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
};

export default LocalizedDateTimeField;
