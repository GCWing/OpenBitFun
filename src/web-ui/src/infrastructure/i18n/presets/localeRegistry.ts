/**
 * Public Web UI locale registry.
 *
 * Locale identity, aliases, and fallback chains are generated from
 * `src/shared/i18n/contract/locales.json`.
 */
export {
  CONTRACT_LOCALE_IDS,
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  LOCALE_IDS,
  builtinLocales,
  getLocaleFallbackChain,
  getLocaleMetadata,
  getSupportedLocaleIds,
  isLocaleSupported,
  resolveLocaleId,
  SHARED_TERMS_BY_LOCALE,
} from './generatedLocaleContract';
export type { ContractLocaleId, LocaleId, LocaleMetadata } from './generatedLocaleContract';
