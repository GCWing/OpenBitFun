import type { FlowChatState, Session } from '../../../../../flow_chat/types/flow-chat';

type DispatchTargetKind = 'local' | 'ssh' | 'device';

interface SessionNavSignature {
  sessionId: string;
  isTransient: boolean | undefined;
  sessionKind: Session['sessionKind'];
  parentSessionId: string | undefined;
  parentToolCallId: string | undefined;
  subagentType: string | undefined;
  workspacePath: string | undefined;
  mode: string | undefined;
  needsUserAttention: Session['needsUserAttention'];
  hasUnreadCompletion: Session['hasUnreadCompletion'];
  latestTurnStatus: string | undefined;
  title: string | undefined;
  dispatchTargetKind: DispatchTargetKind;
  dispatchConnectionId: string | undefined;
  dispatchDeviceId: string | undefined;
  dispatchWorkspacePath: string | undefined;
  dispatchDisplayName: string | undefined;
  dispatchJobState: Session['config']['dispatchJobState'];
}

function readSessionNavSignature(session: Session): SessionNavSignature {
  const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];
  const dispatchTarget = session.config.dispatchTarget;

  return {
    sessionId: session.sessionId,
    isTransient: session.isTransient,
    sessionKind: session.sessionKind,
    parentSessionId: session.parentSessionId,
    parentToolCallId: session.parentToolCallId,
    subagentType: session.subagentType,
    workspacePath: session.workspacePath,
    mode: session.mode,
    needsUserAttention: session.needsUserAttention,
    hasUnreadCompletion: session.hasUnreadCompletion,
    latestTurnStatus: latestTurn?.status,
    title: session.title,
    dispatchTargetKind: dispatchTarget?.kind ?? 'local',
    dispatchConnectionId: dispatchTarget?.kind === 'ssh' ? dispatchTarget.connectionId : undefined,
    dispatchDeviceId: dispatchTarget?.kind === 'device' ? dispatchTarget.deviceId : undefined,
    dispatchWorkspacePath: dispatchTarget?.kind === 'local' ? undefined : dispatchTarget?.workspacePath,
    dispatchDisplayName: dispatchTarget?.kind === 'local' ? undefined : dispatchTarget?.displayName,
    dispatchJobState: session.config.dispatchJobState,
  };
}

function sameSessionNavSignature(previous: SessionNavSignature, session: Session): boolean {
  const dispatchTarget = session.config.dispatchTarget;
  const dispatchTargetKind = dispatchTarget?.kind ?? 'local';
  const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];

  return previous.sessionId === session.sessionId
    && previous.isTransient === session.isTransient
    && previous.sessionKind === session.sessionKind
    && previous.parentSessionId === session.parentSessionId
    && previous.parentToolCallId === session.parentToolCallId
    && previous.subagentType === session.subagentType
    && previous.workspacePath === session.workspacePath
    && previous.mode === session.mode
    && previous.needsUserAttention === session.needsUserAttention
    && previous.hasUnreadCompletion === session.hasUnreadCompletion
    && previous.latestTurnStatus === latestTurn?.status
    && previous.title === session.title
    && previous.dispatchTargetKind === dispatchTargetKind
    && previous.dispatchConnectionId === (dispatchTarget?.kind === 'ssh' ? dispatchTarget.connectionId : undefined)
    && previous.dispatchDeviceId === (dispatchTarget?.kind === 'device' ? dispatchTarget.deviceId : undefined)
    && previous.dispatchWorkspacePath === (dispatchTarget?.kind === 'local' ? undefined : dispatchTarget?.workspacePath)
    && previous.dispatchDisplayName === (dispatchTarget?.kind === 'local' ? undefined : dispatchTarget?.displayName)
    && previous.dispatchJobState === session.config.dispatchJobState;
}

/**
 * Selects only the fields rendered by the sessions navigation.
 *
 * The selector is called for every FlowChatStore notification. It keeps a
 * primitive revision as its result, so stream updates do not rebuild a large
 * joined string merely to discover that the navigation did not change.
 */
export function createSessionsNavSelector(): (state: FlowChatState) => number {
  let activeSessionId: string | null | undefined;
  let orderedSessionIds: string[] = [];
  const signatures = new Map<string, SessionNavSignature>();
  let revision = 0;

  return (state: FlowChatState): number => {
    let changed = activeSessionId !== state.activeSessionId
      || orderedSessionIds.length !== state.sessions.size;
    let orderChanged = orderedSessionIds.length !== state.sessions.size;
    let index = 0;

    for (const session of state.sessions.values()) {
      if (orderedSessionIds[index] !== session.sessionId) {
        changed = true;
        orderChanged = true;
      }

      const previous = signatures.get(session.sessionId);
      if (!previous || !sameSessionNavSignature(previous, session)) {
        signatures.set(session.sessionId, readSessionNavSignature(session));
        changed = true;
      }
      index += 1;
    }

    if (index !== orderedSessionIds.length) {
      changed = true;
      orderChanged = true;
    }

    if (changed) {
      revision += 1;
      activeSessionId = state.activeSessionId;
      if (orderChanged) {
        orderedSessionIds = Array.from(state.sessions.keys());
        for (const sessionId of signatures.keys()) {
          if (!state.sessions.has(sessionId)) {
            signatures.delete(sessionId);
          }
        }
      }
    }

    return revision;
  };
}
