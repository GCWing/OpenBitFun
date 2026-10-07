const STORAGE_PREFIX = 'openbitfun.model-selection.manual.v1:';

/** Presentation preference only; the existing host model API owns actual selection. */
export function getRecentManualModel(scopeKey: string): string | undefined {
  try {
    const value = window.localStorage.getItem(`${STORAGE_PREFIX}${scopeKey}`)?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function setRecentManualModel(scopeKey: string, modelId: string): void {
  if (!modelId.trim()) return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${scopeKey}`, modelId.trim());
  } catch {
    // The mounted selector also retains the choice when storage is unavailable.
  }
}
