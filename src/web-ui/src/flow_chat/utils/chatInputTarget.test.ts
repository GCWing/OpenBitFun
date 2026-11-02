import { describe, expect, it } from 'vitest';
import { resolveComposerTargets, type ComposerTargetCandidate, type ComposerTargetSelection } from './chatInputTarget';

const main: ComposerTargetCandidate = { sessionId: 'main', role: 'main', conversation: { access: 'available', canSubmit: true } };
const child: ComposerTargetCandidate = { ...main, sessionId: 'child-a', role: 'btw' };
const requested: ComposerTargetSelection = { surfaceId: 'local', parentSessionId: 'main', sessionId: 'child-a' };
const resolve = (candidates: ComposerTargetCandidate[], selection: ComposerTargetSelection | null = requested) =>
  resolveComposerTargets({ surfaceId: 'local', currentSessionId: 'main', requested: selection, candidates });

describe('composer target admission and identity', () => {
  it.each(['read-only', 'unknown'] as const)('excludes %s targets before showing a switcher', access => {
    const result = resolve([main, { ...child, conversation: { access, canSubmit: false } }]);
    expect(result.targets).toEqual([main]);
    expect(result.showSwitcher).toBe(false);
    expect(result.effectiveSessionId).toBe('main');
  });

  it('excludes detail-only views even when the underlying session supports conversations', () => {
    expect(resolve([main, { ...child, readOnly: true }]).showSwitcher).toBe(false);
  });

  it('selects an eligible child by its exact session ID', () => {
    expect(resolve([main, child])).toMatchObject({ showSwitcher: true, effectiveSessionId: 'child-a', canSubmit: true });
  });

  it('returns to the parent when a pane closes or opens a different child', () => {
    expect(resolve([main]).effectiveSessionId).toBe('main');
    expect(resolve([main, { ...child, sessionId: 'child-b' }]).effectiveSessionId).toBe('main');
  });

  it.each([{ ...requested, surfaceId: 'peer' }, { ...requested, parentSessionId: 'other' }])(
    'does not reuse selection across a surface or parent change', selection => {
      expect(resolve([main, child], selection).effectiveSessionId).toBe('main');
    },
  );

  it('keeps a temporarily loading target selected and editable, with send blocked', () => {
    expect(resolve([main, { ...child, conversation: { access: 'available', canSubmit: false, reason: 'history_loading' } }]))
      .toMatchObject({ showSwitcher: true, effectiveSessionId: 'child-a', canCompose: true, canSubmit: false });
  });

  it('preserves the identity of a read-only main view without offering new-session send', () => {
    expect(resolve([{ ...main, conversation: { access: 'read-only', canSubmit: false } }]))
      .toMatchObject({ effectiveSessionId: 'main', canCompose: false, canSubmit: false, showSwitcher: false });
  });

  it('allows an empty primary composer to create its first session', () => {
    expect(resolveComposerTargets({ surfaceId: 'local', currentSessionId: null, requested: null, candidates: [] }))
      .toMatchObject({ effectiveSessionId: null, canCompose: true, canSubmit: true, showSwitcher: false });
  });
});
