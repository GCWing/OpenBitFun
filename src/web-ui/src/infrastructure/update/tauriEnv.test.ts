import { afterEach, describe, expect, it, vi } from 'vitest';

import { canAutoCheckForAppUpdates, canCheckForAppUpdates } from './tauriEnv';

describe('app update runtime availability', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps manual update actions available while disabling automatic checks in desktop development', () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('window', { __TAURI__: {} });

    expect(canCheckForAppUpdates()).toBe(true);
    expect(canAutoCheckForAppUpdates()).toBe(false);
  });

  it('enables manual and automatic checks in a packaged Tauri runtime', () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('window', { __TAURI__: {} });

    expect(canCheckForAppUpdates()).toBe(true);
    expect(canAutoCheckForAppUpdates()).toBe(true);
  });

  it.each([true, false])('omits desktop update actions in a plain browser with DEV=%s', development => {
    vi.stubEnv('DEV', development);
    vi.stubGlobal('window', {});

    expect(canCheckForAppUpdates()).toBe(false);
    expect(canAutoCheckForAppUpdates()).toBe(false);
  });
});
