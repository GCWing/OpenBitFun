/** Generate a portable ID even in WebViews without randomUUID. */
export function createSuggestedAgentId(): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `agent-${suffix}`;
}
