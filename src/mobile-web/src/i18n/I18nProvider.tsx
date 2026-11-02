import { formatDuration as formatLocalizedDuration, type DurationPrecision } from '../../../shared/i18n/formatDuration';
import React, { createContext, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { DEFAULT_LANGUAGE, messages, type MobileLanguage } from './messages';
import {
  getMobileFallbackChain,
  getNextMobileLanguage,
  isMobileLanguage,
  resolveMobileLanguage,
} from './localeRegistry';

interface TranslateParams {
  [key: string]: string | number;
}

interface I18nContextValue {
  language: MobileLanguage;
  setLanguage: (language: MobileLanguage) => void;
  toggleLanguage: () => void;
  t: (key: string, params?: TranslateParams) => string;
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (date: Date | number) => string;
  formatDuration: (milliseconds: number, precision?: DurationPrecision) => string;
}

const STORAGE_KEY = 'openbitfun-mobile-language';

function getByPath(source: unknown, path: string): string | null {
  const segments = path.split('.');
  let current: unknown = source;

  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' ? current : null;
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value == null ? '' : String(value);
  });
}

export function translate(language: MobileLanguage, key: string, params?: TranslateParams): string {
  const template = getMobileFallbackChain(language, true)
    .map(locale => getByPath(messages[locale], key))
    .find((value): value is string => value !== null)
    ?? key;
  return interpolate(template, params);
}

function detectInitialLanguage(): MobileLanguage {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isMobileLanguage(stored)) return stored;
  } catch {
    // ignore storage failures
  }

  const urlLanguage = detectLanguageFromUrl();
  if (urlLanguage) return urlLanguage;

  return resolveMobileLanguage(navigator.language) ?? DEFAULT_LANGUAGE;
}

function detectLanguageFromUrl(): MobileLanguage | null {
  const candidates: Array<string | null | undefined> = [];

  try {
    candidates.push(new URLSearchParams(window.location.search).get('lang'));
  } catch {
    // ignore malformed search params
  }

  const hash = window.location.hash || '';
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    try {
      const hashQuery = hash.slice(hashQueryIndex + 1);
      candidates.push(new URLSearchParams(hashQuery).get('lang'));
    } catch {
      // ignore malformed hash params
    }
  }

  for (const candidate of candidates) {
    const language = resolveMobileLanguage(candidate);
    if (language) return language;
  }

  return null;
}

export const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  toggleLanguage: () => {},
  t: (key) => key,
  formatDate: (date, options) => new Intl.DateTimeFormat(DEFAULT_LANGUAGE, options).format(date),
  formatRelativeTime: (date) => formatRelativeTime(DEFAULT_LANGUAGE, date),
  formatDuration: (ms, precision) => formatLocalizedDuration(ms, (value, options) => new Intl.NumberFormat(DEFAULT_LANGUAGE, options).format(value), precision),
});

function formatRelativeTime(language: MobileLanguage, date: Date | number): string {
  const timestamp = date instanceof Date ? date.getTime() : date;
  const diffSeconds = (timestamp - Date.now()) / 1000;
  const absoluteSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });

  if (absoluteSeconds < 60) return formatter.format(Math.round(diffSeconds), 'second');
  if (absoluteSeconds < 3600) return formatter.format(Math.round(diffSeconds / 60), 'minute');
  if (absoluteSeconds < 86_400) return formatter.format(Math.round(diffSeconds / 3600), 'hour');
  if (absoluteSeconds < 2_592_000) return formatter.format(Math.round(diffSeconds / 86_400), 'day');
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<MobileLanguage>(detectInitialLanguage);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // ignore storage failures
    }
  }, [language]);

  const setLanguage = useCallback((nextLanguage: MobileLanguage) => {
    setLanguageState(nextLanguage);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguageState(getNextMobileLanguage);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage,
    toggleLanguage,
    t: (key, params) => translate(language, key, params),
    formatDate: (date, options) => new Intl.DateTimeFormat(language, options).format(date),
    formatRelativeTime: (date) => formatRelativeTime(language, date),
    formatDuration: (ms, precision) => formatLocalizedDuration(ms, (value, options) => new Intl.NumberFormat(language, options).format(value), precision),
  }), [language, setLanguage, toggleLanguage]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
};

export type { MobileLanguage, TranslateParams };
