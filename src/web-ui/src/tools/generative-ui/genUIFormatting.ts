import { i18nService } from '@/infrastructure/i18n/core/I18nService';
export function formatGenUINumber(value: number, decimals = 2): string {
  return i18nService.formatNumber(value, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
}
