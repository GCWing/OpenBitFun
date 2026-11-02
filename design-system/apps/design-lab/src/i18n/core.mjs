export const DESIGN_LAB_LOCALES = ["en-US", "zh-CN", "zh-TW"];

const localeAliases = new Map([
  ["en", "en-US"],
  ["en-us", "en-US"],
  ["zh", "zh-CN"],
  ["zh-cn", "zh-CN"],
  ["zh-hans", "zh-CN"],
  ["zh-tw", "zh-TW"],
  ["zh-hant", "zh-TW"],
  ["zh-hk", "zh-TW"],
  ["zh-mo", "zh-TW"],
]);

export function resolveDesignLabLocale(candidate) {
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) {
    return null;
  }

  const directMatch = localeAliases.get(normalized);
  if (directMatch) {
    return directMatch;
  }

  if (
    normalized.startsWith("zh-hant") ||
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hk") ||
    normalized.startsWith("zh-mo")
  ) {
    return "zh-TW";
  }
  if (normalized.startsWith("zh")) {
    return "zh-CN";
  }
  if (normalized.startsWith("en")) {
    return "en-US";
  }

  return null;
}

export function resolveFirstDesignLabLocale(candidates, fallback = "en-US") {
  for (const candidate of candidates) {
    const locale = resolveDesignLabLocale(candidate);
    if (locale) {
      return locale;
    }
  }
  return resolveDesignLabLocale(fallback) ?? "en-US";
}

export function interpolateMessage(template, params) {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value == null ? match : String(value);
  });
}

export function formatDesignLabNumber(value, locale) {
  return new Intl.NumberFormat(resolveDesignLabLocale(locale) ?? 'en-US').format(value);
}

export function translateFromCatalog(catalog, locale, key, params) {
  const resolvedLocale = resolveDesignLabLocale(locale) ?? "en-US";
  const template = catalog[resolvedLocale]?.[key] ?? catalog["en-US"]?.[key] ?? key;
  return interpolateMessage(template, params);
}
