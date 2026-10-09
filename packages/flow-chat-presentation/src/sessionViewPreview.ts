const LEGACY_SESSION_VIEW_TRUNCATED_MARKER = '[truncated for session view]';
const LEGACY_SESSION_VIEW_TRUNCATED_SUFFIX = '...[truncated for session view]';
const SESSION_VIEW_TRUNCATED_MESSAGE = 'Output truncated for session preview';
const SESSION_VIEW_OMITTED_MESSAGE = 'Output omitted from session preview';

export function isSessionViewPreviewText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.includes(LEGACY_SESSION_VIEW_TRUNCATED_MARKER) ||
    value.includes(SESSION_VIEW_TRUNCATED_MESSAGE) ||
    value.includes(SESSION_VIEW_OMITTED_MESSAGE);
}

export function isOnlySessionViewPreviewText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized === LEGACY_SESSION_VIEW_TRUNCATED_MARKER ||
    normalized === LEGACY_SESSION_VIEW_TRUNCATED_SUFFIX ||
    normalized === SESSION_VIEW_TRUNCATED_MESSAGE ||
    normalized === SESSION_VIEW_OMITTED_MESSAGE ||
    normalized === `... ${SESSION_VIEW_TRUNCATED_MESSAGE}`;
}

export function formatSessionViewPreviewText(value: string): string {
  return value
    .replace(/\n\.\.\.\[truncated for session view\]/g, `\n... ${SESSION_VIEW_TRUNCATED_MESSAGE}`)
    .replace(/\.\.\.\[truncated for session view\]/g, `... ${SESSION_VIEW_TRUNCATED_MESSAGE}`)
    .replace(/\[truncated for session view\]/g, SESSION_VIEW_OMITTED_MESSAGE);
}
