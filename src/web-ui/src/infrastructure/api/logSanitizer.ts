const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERNS = [
  'api-key',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'password',
  'private-token',
  'secret',
  'set-cookie',
  'token',
];
const OPAQUE_VALUE_KEYS = new Set(['body', 'pdfbase64']);
const MAX_LOG_STRING_LENGTH = 500;
const MAX_LOG_ARRAY_ITEMS = 10;
const MAX_LOG_OBJECT_KEYS = 30;
const MAX_LOG_DEPTH = 4;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some(pattern => normalized.includes(pattern));
}

function isOpaqueValueKey(key: string): boolean {
  return OPAQUE_VALUE_KEYS.has(key.toLowerCase());
}

export function sanitizeTextForLog(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, REDACTED)
    .replace(
      /\b(api[_-]?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*["']?[^"',\s&}]+/gi,
      (_match, key) => `${key}: ${REDACTED}`,
    );
}

export function sanitizeLogValue(value: unknown, parentKey?: string, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (parentKey && (isSensitiveKey(parentKey) || isOpaqueValueKey(parentKey))) {
    return REDACTED;
  }

  if (depth >= MAX_LOG_DEPTH) {
    if (Array.isArray(value)) {
      return { type: 'array', length: value.length };
    }
    if (typeof value === 'object') {
      return { type: 'object' };
    }
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map(item => sanitizeLogValue(item, parentKey, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      return {
        type: 'array',
        length: value.length,
        items,
        omittedItems: value.length - MAX_LOG_ARRAY_ITEMS,
      };
    }
    return items;
  }

  if (typeof value !== 'object') {
    if (typeof value === 'string') {
      const sanitized = sanitizeTextForLog(value);
      if (sanitized.length > MAX_LOG_STRING_LENGTH) {
        return {
          type: 'string',
          length: sanitized.length,
          preview: sanitized.slice(0, MAX_LOG_STRING_LENGTH),
        };
      }
      return sanitized;
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(obj);

  for (const [key, rawVal] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    if (isSensitiveKey(key) || isOpaqueValueKey(key)) {
      sanitized[key] = REDACTED;
      continue;
    }

    if ((key === 'headers' || key === 'custom_headers') && rawVal && typeof rawVal === 'object') {
      const headerObj = rawVal as Record<string, unknown>;
      const maskedHeaders: Record<string, unknown> = {};
      for (const [hKey, hVal] of Object.entries(headerObj)) {
        maskedHeaders[hKey] = isSensitiveKey(hKey) ? REDACTED : sanitizeLogValue(hVal, hKey, depth + 1);
      }
      sanitized[key] = maskedHeaders;
      continue;
    }

    sanitized[key] = sanitizeLogValue(rawVal, key, depth + 1);
  }

  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    sanitized.__omittedKeys = entries.length - MAX_LOG_OBJECT_KEYS;
  }

  return sanitized;
}

export function sanitizeErrorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeTextForLog(error.message),
    };
  }
  return sanitizeLogValue(error);
}
