import { beforeEach, describe, expect, it } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

import { shouldOpenMiniAppAgentRunInMainScene } from './miniAppAgentVisibility';

describe('shouldOpenMiniAppAgentRunInMainScene', () => {
  beforeEach(() => { activateSurface('local'); });
  it('keeps compatibility-profile sessions on their existing surface', () => {
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        false,
        undefined,
        'app#1',
        'session-1',
      ),
    ).toBe(false);
  });

  it('opens a strict session in the main scene when no runner owns the composer', () => {
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        undefined,
        'app#1',
        'session-1',
      ),
    ).toBe(true);
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        { token: 'app#2', sessionId: 'session-1' },
        'app#1',
        'session-1',
      ),
    ).toBe(true);
  });

  it('keeps a strict run in the bubble only after that session is bound', () => {
    const claim = { surfaceId: 'local', token: 'app#1', sessionId: 'session-1' };
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        claim,
        'app#1',
        'session-1',
      ),
    ).toBe(false);
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        claim,
        'app#1',
        'session-2',
      ),
    ).toBe(true);
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        { token: 'app#1' },
        'app#1',
        'session-1',
      ),
    ).toBe(true);
  });

  it('keeps a bound background or hidden conversation recoverable through its app', () => {
    expect(
      shouldOpenMiniAppAgentRunInMainScene(
        true,
        { surfaceId: 'local', token: 'app#1', sessionId: 'session-1' },
        'app#1',
        'session-1',
      ),
    ).toBe(false);
  });

  it('does not reuse a claim from another device with the same session id', () => {
    activateSurface('peer');
    expect(shouldOpenMiniAppAgentRunInMainScene(true,
      { surfaceId: 'local', token: 'app#1', sessionId: 'session-1' }, 'app#1', 'session-1')).toBe(true);
  });
});
