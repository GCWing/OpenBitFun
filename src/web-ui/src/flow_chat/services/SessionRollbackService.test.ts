import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostQueueMock = vi.hoisted(() => ({ supported: vi.fn(() => false), refresh: vi.fn() }));
vi.mock('./hostDialogQueue', () => ({
  hostQueueSupported: hostQueueMock.supported,
  hostDialogQueue: () => ({ refresh: hostQueueMock.refresh }),
}));

const agentApiMock = vi.hoisted(() => ({ rollbackSessionToTurn: vi.fn() }));
const eventBusMock = vi.hoisted(() => ({ emit: vi.fn() }));
const loadSessionHistory = vi.hoisted(() => vi.fn(async () => undefined));
const retireRelaySessionTurns = vi.hoisted(() => vi.fn());
const resyncRelaySessionFromHost = vi.hoisted(() => vi.fn(async () => undefined));
const sessions = vi.hoisted(() => new Map<string, any>());
const historyViews = vi.hoisted(() => new Map<string, any>());

vi.mock('@/infrastructure/api', () => ({ agentAPI: agentApiMock }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: eventBusMock }));
vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions }),
    getSessionHistoryViewState: (sessionId: string) => historyViews.get(sessionId),
    loadSessionHistory,
    retireRelaySessionTurns,
    resyncRelaySessionFromHost,
  },
}));

import { RollbackOutcomeUnknownError, rollbackSessionToTurn } from './SessionRollbackService';
import {
  isSessionTurnRetired,
  useSessionMutationStore,
} from '../store/sessionMutationStore';
import {
  SessionExecutionEvent,
  stateMachineManager,
} from '../state-machine';
import { pendingQueueManager } from './flow-chat-manager/PendingQueueModule';
import { activateSurface, getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import {
  beginSubmittedMessagePreview,
  getSubmittedMessagePreviews,
} from './submittedMessagePresentation';
import { localTurnCatalogRevision } from '../utils/flowChatTurnIdentity';

describe('SessionRollbackService', () => {
  afterEach(() => activateSurface(LOCAL_SURFACE_ID));
  it('rejects detached history mutation before any local backend call', async () => {
    sessions.set('dispatch-session', { config: { dispatchJobId: 'job-remote' } });
    await expect(rollbackSessionToTurn({ sessionId: 'dispatch-session', targetTurnId: 'turn-1', kind: 'rollback' }))
      .rejects.toThrow('detached remote session');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
    expect(useSessionMutationStore.getState().mutations.size).toBe(0);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    hostQueueMock.supported.mockReturnValue(false);
    hostQueueMock.refresh.mockResolvedValue({ items: [] });
    loadSessionHistory.mockResolvedValue(undefined);
    sessions.clear();
    historyViews.clear();
    stateMachineManager.clear();
    pendingQueueManager.clear('session-1');
    useSessionMutationStore.setState({ mutations: new Map(), retiredTurnIds: new Map() });
    sessions.set('session-1', {
      sessionId: 'session-1',
      workspacePath: 'E:/workspace',
      workspaceId: 'local_workspace-1',
      workspaceHostname: 'localhost',
      config: {},
      isPartial: true,
      dialogTurns: [{ id: 'turn-7', storageTurnIndex: 7 }],
      turnCatalog: {
        sessionId: 'session-1',
        revision: 'catalog-3',
        entries: [{ ordinal: 2, storageTurnIndex: 7, turnId: 'turn-7' }],
      },
    });
  });

  it('refuses host-owned queued work before invoking rollback', async () => {
    hostQueueMock.supported.mockReturnValue(true);
    hostQueueMock.refresh.mockResolvedValue({ items: [{ turnId: 'queued-turn', status: 'blocked' }] });
    await expect(rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback' }))
      .rejects.toThrow('Clear the host message queue');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
  });

  it('refuses path-only mutations until legacy identity has been hydrated', async () => {
    const session = sessions.get('session-1');
    delete session.workspaceId;
    await expect(rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback' }))
      .rejects.toThrow('workspace ID is unavailable');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
  });

  it('submits stable persisted identity and reloads only after completion', async () => {
    const scope = getActiveSurfaceScope();
    beginSubmittedMessagePreview(scope, 'session-1', 'turn-8', { id: 'user_local', content: 'later', timestamp: 1 });
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: ['src/lib.rs'],
      composer: { kind: 'replace', text: 'prompt' },
      retiredTurnIds: ['turn-7', 'turn-8'],
    });

    const result = await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-7',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      workspaceId: 'local_workspace-1',
      targetTurnId: 'turn-7',
      expectedStorageTurnIndex: 7,
      expectedCatalogRevision: 'catalog-3',
    }));
    expect(loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fromTurnIndex: 2, composerText: 'prompt' });
    expect(isSessionTurnRetired('session-1', 'turn-7')).toBe(true);
    expect(isSessionTurnRetired('session-1', 'turn-8')).toBe(true);
    expect(retireRelaySessionTurns).toHaveBeenCalledWith('session-1', ['turn-7', 'turn-8']);
    // A preview renders whenever its Turn is absent; a retired Turn's must go.
    expect(getSubmittedMessagePreviews(scope, 'session-1')).toEqual([]);
  });

  it('omits a stale catalog revision when the current Turn is not represented', async () => {
    const session = sessions.get('session-1');
    session.turnCatalog.entries[0].turnId = 'retired-turn-7';
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-7'],
      composer: { kind: 'preserve' },
    });

    await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-7',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      targetTurnId: 'turn-7',
      expectedStorageTurnIndex: 7,
      expectedCatalogRevision: undefined,
    }));
  });

  it('includes sparse cached and catalog-only history in a legacy peer rollback', async () => {
    const session = sessions.get('session-1');
    session.dialogTurns.push({ id: 'turn-9', storageTurnIndex: 9 });
    const catalog = {
      sessionId: 'session-1', revision: 'catalog-history',
      entries: [
        { ordinal: 0, storageTurnIndex: 1, turnId: 'turn-1' },
        { ordinal: 1, storageTurnIndex: 2, turnId: 'turn-2' },
        { ordinal: 2, storageTurnIndex: 5, turnId: 'turn-5' },
        { ordinal: 3, storageTurnIndex: 7, turnId: 'turn-7' },
        { ordinal: 4, storageTurnIndex: 9, turnId: 'turn-9' },
      ],
    };
    session.turnCatalog = catalog;
    historyViews.set('session-1', {
      catalog,
      loadedRanges: [{ startOrdinal: 0, endOrdinalExclusive: 2, turns: [
        { id: 'turn-1', storageTurnIndex: 1 }, { id: 'turn-2', storageTurnIndex: 2 },
      ] }],
    });
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed', retiredTurnIds: [], restoredFiles: [],
      composer: { kind: 'replace', text: 'test2' },
    });

    await rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-2', kind: 'rollback' });

    const retired = retireRelaySessionTurns.mock.calls[0][1] as string[];
    expect(new Set(retired)).toEqual(new Set(['turn-2', 'turn-5', 'turn-7', 'turn-9']));
    expect(isSessionTurnRetired('session-1', 'turn-1')).toBe(false);
  });

  it('captures retired identities before awaiting the host, preserving a new Turn in the same slot', async () => {
    agentApiMock.rollbackSessionToTurn.mockImplementationOnce(async () => {
      sessions.get('session-1').dialogTurns = [{ id: 'new-turn', storageTurnIndex: 7 }];
      return { status: 'completed', retiredTurnIds: [], restoredFiles: [], composer: { kind: 'preserve' } };
    });

    await rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback' });

    expect(retireRelaySessionTurns).toHaveBeenCalledWith('session-1', ['turn-7']);
    expect(isSessionTurnRetired('session-1', 'new-turn')).toBe(false);
  });

  it('abandons a rollback when the device changes during the host queue check', async () => {
    activateSurface('peer-a');
    hostQueueMock.supported.mockReturnValue(true);
    hostQueueMock.refresh.mockImplementationOnce(async () => {
      activateSurface('peer-b');
      return { items: [] };
    });

    await expect(rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback' }))
      .rejects.toThrow('Device surface changed');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
    expect(retireRelaySessionTurns).not.toHaveBeenCalled();
  });

  it('does not apply a rollback receipt to another device with the same Session ID', async () => {
    activateSurface('peer-a');
    agentApiMock.rollbackSessionToTurn.mockImplementationOnce(async () => {
      activateSurface('peer-b');
      return { status: 'completed', retiredTurnIds: ['turn-7'], restoredFiles: [], composer: { kind: 'preserve' } };
    });

    await expect(rollbackSessionToTurn({ sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback' }))
      .rejects.toThrow('Device surface changed');
    expect(retireRelaySessionTurns).not.toHaveBeenCalled();
    expect(loadSessionHistory).not.toHaveBeenCalled();
    expect(eventBusMock.emit).not.toHaveBeenCalled();
  });

  it('omits a controller-minted catalog revision the host never issued', async () => {
    // Peer Device sessions build their catalog from replicated records; the
    // host computes its own revision, so a local one would always look stale.
    const session = sessions.get('session-1');
    session.turnCatalog.revision = localTurnCatalogRevision('relay:turn-7');
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-7'],
      composer: { kind: 'preserve' },
    });

    await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-7',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      targetTurnId: 'turn-7',
      expectedStorageTurnIndex: 7,
      expectedCatalogRevision: undefined,
    }));
  });

  it('rolls back an older Turn materialized only in a history window', async () => {
    const session = sessions.get('session-1');
    const olderTurn = { id: 'turn-2', storageTurnIndex: 2 };
    const catalog = {
      sessionId: 'session-1',
      revision: 'catalog-history',
      entries: [
        { ordinal: 0, storageTurnIndex: 2, turnId: 'turn-2' },
        { ordinal: 2, storageTurnIndex: 7, turnId: 'turn-7' },
      ],
    };
    session.turnCatalog = catalog;
    historyViews.set('session-1', {
      catalog,
      loadedRanges: [{ startOrdinal: 0, endOrdinalExclusive: 1, turns: [olderTurn] }],
    });
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-2', 'turn-7'],
      composer: { kind: 'preserve' },
    });

    const result = await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-2',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      targetTurnId: 'turn-2',
      expectedStorageTurnIndex: 2,
      expectedCatalogRevision: 'catalog-history',
    }));
    expect(result.fromTurnIndex).toBe(0);
  });

  it('derives the ordinal from a materialized range when its catalog is unavailable', async () => {
    const olderTurn = { id: 'turn-12', storageTurnIndex: 12 };
    sessions.get('session-1').turnCatalog = undefined;
    historyViews.set('session-1', {
      catalog: null,
      loadedRanges: [{
        startOrdinal: 10,
        endOrdinalExclusive: 13,
        turns: [
          { id: 'turn-10', storageTurnIndex: 10 },
          { id: 'turn-11', storageTurnIndex: 11 },
          olderTurn,
        ],
      }],
    });
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-12'],
      composer: { kind: 'preserve' },
    });

    const result = await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-12',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      targetTurnId: 'turn-12',
      expectedStorageTurnIndex: 12,
      expectedCatalogRevision: undefined,
    }));
    expect(result.fromTurnIndex).toBe(12);
  });

  it('keeps a catalog-only target valid after its history window is pruned', async () => {
    const session = sessions.get('session-1');
    const catalog = {
      sessionId: 'session-1',
      revision: 'catalog-history',
      entries: [
        { ordinal: 0, storageTurnIndex: 2, turnId: 'turn-2' },
        { ordinal: 2, storageTurnIndex: 7, turnId: 'turn-7' },
      ],
    };
    session.turnCatalog = catalog;
    historyViews.set('session-1', { catalog, loadedRanges: [] });
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-2', 'turn-7'],
      composer: { kind: 'preserve' },
    });

    const result = await rollbackSessionToTurn({
      sessionId: 'session-1',
      targetTurnId: 'turn-2',
      kind: 'rollback',
    });

    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({
      targetTurnId: 'turn-2',
      expectedStorageTurnIndex: 2,
      expectedCatalogRevision: 'catalog-history',
    }));
    expect(result.fromTurnIndex).toBe(0);
  });

  it('admits only one mutation per Session', async () => {
    let settle!: (value: any) => void;
    agentApiMock.rollbackSessionToTurn.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const first = rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    });
    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'edit-rerun',
    })).rejects.toThrow('already in progress');
    settle({
      status: 'completed',
      restoredFiles: [],
      retiredTurnIds: ['turn-7'],
      composer: { kind: 'preserve' },
    });
    await first;
    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects history mutation unless the Session is idle', async () => {
    await stateMachineManager.transition('session-1', SessionExecutionEvent.START);

    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('Session is idle');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
    expect(useSessionMutationStore.getState().mutations.has('session-1')).toBe(false);
  });

  it('rejects history mutation while a message is pending', async () => {
    pendingQueueManager.enqueue({
      sessionId: 'session-1',
      content: 'queued follow-up',
    });

    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'edit-rerun',
    })).rejects.toThrow('pending message queue');
    expect(agentApiMock.rollbackSessionToTurn).not.toHaveBeenCalled();
    expect(useSessionMutationStore.getState().mutations.has('session-1')).toBe(false);
  });

  it('refreshes affected state and reloads on recovery-required outcome', async () => {
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'recovery_required',
      affectedFiles: ['src/recovery.rs'],
      reason: 'staged marker remains',
    });
    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('requires recovery');
    expect(eventBusMock.emit).toHaveBeenCalledWith('editor:file-changed', {
      filePath: 'src/recovery.rs',
    });
    expect(loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(useSessionMutationStore.getState().mutations.has('session-1')).toBe(false);
  });

  it('keeps the Session blocked when recovery reload fails', async () => {
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'recovery_required',
      affectedFiles: ['src/recovery.rs'],
      reason: 'staged marker remains',
    });
    loadSessionHistory.mockRejectedValueOnce(new Error('recovery reload failed'));

    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('recovery reload failed');

    expect(useSessionMutationStore.getState().mutations.get('session-1')).toMatchObject({
      phase: 'reconciliation_required',
      reconciliationReason: 'staged marker remains',
    });
    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('already in progress');
    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps the Session blocked when authoritative reload fails after commit', async () => {
    agentApiMock.rollbackSessionToTurn.mockResolvedValue({
      status: 'completed',
      restoredFiles: ['src/committed.rs'],
      retiredTurnIds: ['turn-7'],
      composer: { kind: 'replace', text: 'prompt' },
      hiddenTurnCount: 1,
      boundaryStorageTurnIndex: 7,
      targetTurnId: 'turn-7',
      reloadRequired: true,
      reloadReason: 'transcript read failed',
    });
    loadSessionHistory.mockRejectedValueOnce(new Error('reload failed'));

    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('reload failed');

    expect(useSessionMutationStore.getState().mutations.get('session-1')).toMatchObject({
      phase: 'reconciliation_required',
      reconciliationReason: 'reload failed',
    });
    await expect(rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    })).rejects.toThrow('already in progress');
    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['local', LOCAL_SURFACE_ID, 0],
    ['device', 'peer-a', 1],
  ])('resyncs the authoritative session when a rollback reply is lost (%s)', async (_label, surface, relayReloads) => {
    activateSurface(surface);
    agentApiMock.rollbackSessionToTurn.mockRejectedValue(new Error('outcome_unknown: reply lost'));

    const failure = await rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    }).catch(error => error);

    expect(failure).toBeInstanceOf(RollbackOutcomeUnknownError);
    expect(failure.reloaded).toBe(true);
    expect(failure.message).not.toContain('outcome_unknown');
    expect(resyncRelaySessionFromHost).toHaveBeenCalledTimes(relayReloads);
    expect(loadSessionHistory).toHaveBeenCalledTimes(1);
    // The reload reconciled the history; the session accepts new work again.
    expect(useSessionMutationStore.getState().mutations.has('session-1')).toBe(false);
    expect(agentApiMock.rollbackSessionToTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps the Session blocked when the reload after a lost rollback reply fails', async () => {
    agentApiMock.rollbackSessionToTurn.mockRejectedValue(new Error('outcome_unknown: reply lost'));
    loadSessionHistory.mockRejectedValueOnce(new Error('reload failed'));

    const failure = await rollbackSessionToTurn({
      sessionId: 'session-1', targetTurnId: 'turn-7', kind: 'rollback',
    }).catch(error => error);

    expect(failure).toBeInstanceOf(RollbackOutcomeUnknownError);
    expect(failure.reloaded).toBe(false);
    expect(useSessionMutationStore.getState().mutations.get('session-1')).toMatchObject({
      phase: 'reconciliation_required',
    });
  });
});
