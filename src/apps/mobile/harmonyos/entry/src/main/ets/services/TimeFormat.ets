import { RemoteI18n } from '../i18n/RemoteI18n';

export class TimeFormat {
  static message(value: string): string {
    const timestamp = TimeFormat.timestampMs(value);
    return Number.isFinite(new Date(timestamp).getTime()) ? RemoteI18n.formatMessageTime(timestamp) : '';
  }

  static relative(value: string, nowMs: number = Date.now()): string {
    const timestamp = TimeFormat.timestampMs(value);
    if (Number.isNaN(timestamp)) {
      return RemoteI18n.t('time.unknown');
    }
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const rawDiffMs = nowMs - timestamp;
    if (rawDiffMs < -minute) {
      return RemoteI18n.formatAbsoluteDate(timestamp);
    }
    const diffMs = Math.max(0, rawDiffMs);
    if (diffMs < minute) {
      return RemoteI18n.t('time.justNow');
    }
    if (diffMs < hour) {
      return RemoteI18n.f('time.minutesAgo', `${Math.max(1, Math.floor(diffMs / minute))}`);
    }
    if (diffMs < day) {
      return RemoteI18n.f('time.hoursAgo', `${Math.floor(diffMs / hour)}`);
    }
    if (diffMs < 7 * day) {
      return RemoteI18n.f('time.daysAgo', `${Math.floor(diffMs / day)}`);
    }
    return RemoteI18n.formatAbsoluteDate(timestamp);
  }

  static timestampMs(value: string): number {
    const text = (value || '').trim();
    if (text.length === 0) {
      return Number.NaN;
    }

    if (/^\d+(\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      if (!Number.isNaN(numeric)) {
        if (numeric < 100000000000) {
          return numeric * 1000;
        }
        if (numeric < 100000000000000) {
          return numeric;
        }
        if (numeric < 100000000000000000) {
          return numeric / 1000;
        }
        return numeric / 1000000;
      }
    }

    const direct = Date.parse(text);
    if (!Number.isNaN(direct)) {
      return direct;
    }

    const normalized = text.replace(' ', 'T');
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

}
