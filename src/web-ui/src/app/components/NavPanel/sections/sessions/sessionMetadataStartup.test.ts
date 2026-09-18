import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_METADATA_DEFERRED_FALLBACK_MS,
  SESSION_METADATA_DEFERRED_FRAME_COUNT,
  SESSION_METADATA_DEFERRED_SIGNAL,
  getDeferredSessionMetadataDelayMs,
  getInitialSessionMetadataLoadMode,
  hasStartupOverlayHandedOff,
} from './sessionMetadataStartup';

describe('session metadata startup scheduling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chooses the startup gate for each initial metadata load path', () => {
    expect(getInitialSessionMetadataLoadMode({
      hasWorkspace: false,
      isActiveWorkspace: true,
      isVisible: true,
      startupOverlayHandedOff: false,
    })).toBe('skip');

    expect(getInitialSessionMetadataLoadMode({
      hasWorkspace: true,
      isActiveWorkspace: true,
      isVisible: true,
      startupOverlayHandedOff: false,
    })).toBe('immediate');

    expect(getInitialSessionMetadataLoadMode({
      hasWorkspace: true,
      isActiveWorkspace: false,
      isVisible: true,
      startupOverlayHandedOff: false,
    })).toBe('after-startup-signal');

    expect(getInitialSessionMetadataLoadMode({
      hasWorkspace: true,
      isActiveWorkspace: false,
      isVisible: true,
      startupOverlayHandedOff: true,
    })).toBe('after-startup-paint');

    expect(getInitialSessionMetadataLoadMode({
      hasWorkspace: true,
      isActiveWorkspace: false,
      isVisible: false,
      startupOverlayHandedOff: true,
    })).toBe('skip');
  });

  it('keeps deferred metadata tied to the startup overlay handoff', () => {
    expect(SESSION_METADATA_DEFERRED_SIGNAL).toBe('openbitfun:startup-overlay-hidden');
    expect(SESSION_METADATA_DEFERRED_FALLBACK_MS).toBe(10000);
    expect(SESSION_METADATA_DEFERRED_FRAME_COUNT).toBe(1);
  });

  it('uses a stable bounded stagger for background workspace metadata', () => {
    const first = getDeferredSessionMetadataDelayMs('D:\\workspace\\OpenBitFun');
    const second = getDeferredSessionMetadataDelayMs('D:\\workspace\\OpenBitFun');
    const other = getDeferredSessionMetadataDelayMs('D:\\workspace\\Other');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(120);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(other).toBeLessThanOrEqual(120);
    expect(getDeferredSessionMetadataDelayMs()).toBe(0);
  });

  it('detects when a late-mounted section has already missed the overlay handoff event', () => {
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => ({})),
    });
    expect(hasStartupOverlayHandedOff()).toBe(false);

    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
    });
    expect(hasStartupOverlayHandedOff()).toBe(true);
  });
});
