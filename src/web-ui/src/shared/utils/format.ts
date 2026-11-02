/**
 * Formatting utilities for tool display
 */

import { formatDuration as formatLocalizedDuration, type DurationPrecision } from '../../../../shared/i18n/formatDuration';
import { i18nService } from '@/infrastructure/i18n/core/I18nService';

export const formatDuration = (durationMs: number, precision: DurationPrecision = 'precise'): string =>
  formatLocalizedDuration(durationMs, (value, options) => i18nService.formatNumber(value, options), precision);

export const formatCost = (costUSD: number): string => {
  if (costUSD < 0.001) {
    return `<$0.001`;
  }
  
  if (costUSD < 0.01) {
    return `$${costUSD.toFixed(4)}`;
  }
  
  if (costUSD < 1) {
    return `$${costUSD.toFixed(3)}`;
  }
  
  return `$${costUSD.toFixed(2)}`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
};

export const formatFilePath = (filePath: string, maxLength: number = 50): string => {
  if (filePath.length <= maxLength) return filePath;
  
  const parts = filePath.split('/');
  if (parts.length <= 2) return truncateText(filePath, maxLength);
  
  const fileName = parts[parts.length - 1];
  const dirPath = parts.slice(0, -1).join('/');
  
  if (fileName.length > maxLength - 3) {
    return `.../${truncateText(fileName, maxLength - 4)}`;
  }
  
  const availableLength = maxLength - fileName.length - 4; // 4 for ".../"
  if (dirPath.length > availableLength) {
    return `.../${truncateText(dirPath, availableLength)}/${fileName}`;
  }
  
  return filePath;
};
