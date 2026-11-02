export type DesignLabLocale = "en-US" | "zh-CN" | "zh-TW";
export type TranslateParams = Readonly<Record<string, string | number>>;

export const DESIGN_LAB_LOCALES: readonly DesignLabLocale[];

export function resolveDesignLabLocale(candidate: unknown): DesignLabLocale | null;
export function resolveFirstDesignLabLocale(
  candidates: readonly unknown[],
  fallback?: DesignLabLocale,
): DesignLabLocale;
export function interpolateMessage(template: string, params?: TranslateParams): string;
export function formatDesignLabNumber(value: number, locale: unknown): string;
export function translateFromCatalog<Key extends string>(
  catalog: Readonly<Record<DesignLabLocale, Readonly<Record<Key, string>>>>,
  locale: unknown,
  key: Key,
  params?: TranslateParams,
): string;
