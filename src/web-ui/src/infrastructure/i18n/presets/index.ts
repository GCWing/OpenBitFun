 

import type { ContractLocaleId, LocaleId } from './localeRegistry';
import {
  CONTRACT_LOCALE_IDS,
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  builtinLocales,
  getLocaleFallbackChain,
  getLocaleMetadata,
  getSupportedLocaleIds,
  isLocaleSupported,
  resolveLocaleId,
  SHARED_TERMS_BY_LOCALE,
} from './localeRegistry';
export { ALL_NAMESPACES, WEB_UI_BOOTSTRAP_NAMESPACES } from './namespaceRegistry';
export {
  CONTRACT_LOCALE_IDS,
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  builtinLocales,
  getLocaleFallbackChain,
  getLocaleMetadata,
  getSupportedLocaleIds,
  isLocaleSupported,
  resolveLocaleId,
  SHARED_TERMS_BY_LOCALE,
};
export type { ContractLocaleId, LocaleId };

export const DEFAULT_NAMESPACE = 'common';
