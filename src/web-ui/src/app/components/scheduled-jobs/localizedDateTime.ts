/**
 * Text <-> timestamp helpers for `LocalizedDateTimeField`.
 *
 * The field shows and accepts a plain localized string (`2026/08/12 04:48` in
 * Chinese, `08/12/2026 04:48` in English) while callers keep the native
 * `YYYY-MM-DDTHH:mm` value contract.
 *
 * Kept apart from the component so the parsing rules can be tested directly.
 */

/** Locales that read year-first. Everything else falls back to month-first. */
const YEAR_FIRST_LOCALE_PREFIXES = ['zh', 'ja', 'ko'];

export type DateFieldOrder = 'year-first' | 'month-first';

/**
 * Field order for a locale, driven by the app's language rather than the
 * browser's — which is the whole reason this control exists.
 */
export function resolveDateFieldOrder(locale: string | null | undefined): DateFieldOrder {
  const language = String(locale ?? '').toLowerCase();
  return YEAR_FIRST_LOCALE_PREFIXES.some(prefix => language.startsWith(prefix))
    ? 'year-first'
    : 'month-first';
}

/** Days in the given month, so 31 February clamps instead of rolling over. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

const FORMAT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const DIGIT_PATTERN = /\d+/g;
const formatCache = new Map<string, string>();
const parseCache = new Map<string, string | null>();

/** Renders a native datetime-local value as localized display text. */
export function formatDateTimeText(value: string, order: DateFieldOrder): string {
  const cacheKey = `${order}:${value}`;
  const cached = formatCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const match = FORMAT_PATTERN.exec(value.trim());
  if (!match) {
    if (formatCache.size > 256) formatCache.clear();
    formatCache.set(cacheKey, '');
    return '';
  }

  const [, year, month, day, hour, minute] = match;
  const date = order === 'year-first'
    ? `${year}/${month}/${day}`
    : `${month}/${day}/${year}`;
  const result = `${date} ${hour}:${minute}`;
  if (formatCache.size > 256) formatCache.clear();
  formatCache.set(cacheKey, result);
  return result;
}

/**
 * Reads localized display text back into a native datetime-local value.
 *
 * Deliberately forgiving about separators, so `2026-08-12 04:48`,
 * `2026/8/12 4:8` and `2026.08.12 04:48` all work. The four-digit group
 * identifies the year wherever it sits, which keeps a value pasted in the other
 * locale's order readable instead of silently landing on the wrong date.
 * Returns null when the text cannot be read as a complete date and time.
 */
export function parseDateTimeText(text: string, order: DateFieldOrder): string | null {
  const cacheKey = `${order}:${text}`;
  const cached = parseCache.get(cacheKey);
  if (cached !== undefined) return cached;

  DIGIT_PATTERN.lastIndex = 0;
  const groups = text.match(DIGIT_PATTERN);
  if (!groups || groups.length < 5) {
    if (parseCache.size > 256) parseCache.clear();
    parseCache.set(cacheKey, null);
    return null;
  }

  const [a, b, c, hourText, minuteText] = groups;

  let yearText: string;
  let monthText: string;
  let dayText: string;

  if (a.length === 4) {
    [yearText, monthText, dayText] = [a, b, c];
  } else if (c.length === 4) {
    [monthText, dayText, yearText] = [a, b, c];
  } else if (order === 'year-first') {
    [yearText, monthText, dayText] = [a, b, c];
  } else {
    [monthText, dayText, yearText] = [a, b, c];
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (![year, month, day, hour, minute].every(Number.isFinite) || year < 1970 || year > 9999) {
    if (parseCache.size > 256) parseCache.clear();
    parseCache.set(cacheKey, null);
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) {
    if (parseCache.size > 256) parseCache.clear();
    parseCache.set(cacheKey, null);
    return null;
  }

  // Clamp rather than reject: someone typing 31 in a 30-day month means the end
  // of that month, and rolling into the next one would be a silent wrong date.
  const clampedDay = Math.min(day, daysInMonth(year, month));

  const result = `${pad(year, 4)}-${pad(month)}-${pad(clampedDay)}T${pad(hour)}:${pad(minute)}`;
  if (parseCache.size > 256) parseCache.clear();
  parseCache.set(cacheKey, result);
  return result;
}

/** Example string used as the field placeholder, in the locale's own order. */
export function dateTimeFormatHint(order: DateFieldOrder): string {
  return order === 'year-first' ? 'YYYY/MM/DD HH:mm' : 'MM/DD/YYYY HH:mm';
}
