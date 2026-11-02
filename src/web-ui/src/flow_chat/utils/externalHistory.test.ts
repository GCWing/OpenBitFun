import { describe, expect, it, vi } from 'vitest';
import { externalHistoryFromMetadata, readComposerPermissionMode, viewedExternalForkTurn } from './externalHistory';
import type { Session } from '../types/flow-chat';

describe('external history views', () => {
  it.each([null, 'ask', 'auto_approve', 'full_access'] as const)('reads source permission selection %s without restoring a runtime', async mode => {
    const nativeRead = vi.fn().mockRejectedValue(new Error('Source history is read-only'));
    expect(await readComposerPermissionMode({ externalHistory: { mode: 'follow' }, externalContinuationPermissionMode: mode }, nativeRead))
      .toEqual({ mode });
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it('reads the native branch mode and preserves actual read failures', async () => {
    const nativeRead = vi.fn().mockResolvedValueOnce({ mode: 'ask' }).mockRejectedValueOnce(new Error('Host offline'));
    expect(await readComposerPermissionMode({}, nativeRead)).toEqual({ mode: 'ask' });
    await expect(readComposerPermissionMode({}, nativeRead)).rejects.toThrow('Host offline');
  });
  it('keeps legacy imports independent unless following is explicit', () => {
    expect(externalHistoryFromMetadata({ importedFrom: 'codex' })).toBeUndefined();
    expect(externalHistoryFromMetadata({ externalHistoryMode: 'follow', externalHistoryPending: false })).toBeUndefined();
    expect(externalHistoryFromMetadata({ externalHistoryMode: 'follow', externalHistoryPending: true, externalContentVersion: 'new' }))
      .toMatchObject({ mode: 'follow', contentVersion: 'new' });
  });

  it('pins continuation to the viewed turn even when newer metadata arrives', () => {
    const session = {
      historyState: 'ready', externalHistory: { mode: 'follow', contentVersion: 'new' },
      dialogTurns: [{ id: 'old-turn', userMessage: { metadata: { externalContentVersion: 'old' } } }],
      turnCatalog: { entries: [{ turnId: 'old-turn' }] },
    } as Session;
    expect(viewedExternalForkTurn(session)).toBe('old-turn');
    session.historyState = 'hydrating';
    expect(viewedExternalForkTurn(session)).toBeUndefined();
    session.historyState = 'ready';
    session.turnCatalog!.entries[0].turnId = 'unloaded-tail';
    expect(viewedExternalForkTurn(session)).toBeUndefined();
  });
});
