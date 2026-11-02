/** Locale-neutral duration policy; each surface supplies its own number formatter. */
export type DurationPrecision = 'live' | 'precise';
export type DurationNumberFormatter = (value: number, options?: Intl.NumberFormatOptions) => string;

export function formatDuration(
  milliseconds: number,
  formatNumber: DurationNumberFormatter,
  precision: DurationPrecision = 'precise',
): string {
  const safeMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const unit = (value: number, name: string, decimals = 0) => formatNumber(value, {
    style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: decimals,
  });
  if (safeMs < 1000) return unit(Math.round(safeMs), 'millisecond');
  const seconds = precision === 'live' ? Math.floor(safeMs / 1000) : Math.round(safeMs / 100) / 10;
  if (seconds < 60) return unit(seconds, 'second', precision === 'live' ? 0 : 1);
  const wholeSeconds = precision === 'live' ? Math.floor(seconds) : Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (minutes < 60) return [unit(minutes, 'minute'), remainingSeconds ? unit(remainingSeconds, 'second') : ''].filter(Boolean).join(' ');
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return [unit(days, 'day'), remainingHours ? unit(remainingHours, 'hour') : ''].filter(Boolean).join(' ');
  }
  return [unit(hours, 'hour'), remainingMinutes ? unit(remainingMinutes, 'minute') : ''].filter(Boolean).join(' ');
}
