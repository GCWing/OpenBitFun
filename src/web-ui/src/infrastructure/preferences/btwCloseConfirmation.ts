export const BTW_CLOSE_CONFIRMATION_STORAGE_KEY = 'openbitfun:preferences:skip-btw-close-confirmation:v1';

export function shouldConfirmBtwClose(): boolean {
  try {
    return globalThis.localStorage?.getItem(BTW_CLOSE_CONFIRMATION_STORAGE_KEY) !== 'true';
  } catch {
    return true;
  }
}

export function setConfirmBtwClose(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.removeItem(BTW_CLOSE_CONFIRMATION_STORAGE_KEY);
    else globalThis.localStorage?.setItem(BTW_CLOSE_CONFIRMATION_STORAGE_KEY, 'true');
  } catch {
    // A storage failure must not block the settings interaction.
  }
}
