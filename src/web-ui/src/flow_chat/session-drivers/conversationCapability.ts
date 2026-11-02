import type { Session } from '../types/flow-chat';
import { resolveSessionDriverId, type SessionDriverId } from './resolve';

export type ConversationUnavailableReason =
  | 'metadata_pending'
  | 'fresh_only'
  | 'archived'
  | 'unsupported_route'
  | 'history_loading';

export interface SessionConversationCapability {
  access: 'available' | 'read-only' | 'unknown';
  canSubmit: boolean;
  reason?: ConversationUnavailableReason;
}

type ConversationSession = Pick<Session,
  'sessionKind' | 'continuationPolicy' | 'persistedStatus' | 'historyState' | 'config'
  | 'isTransient' | 'agentBackedTransient'>;

/** Execution completion is deliberately not a conversation-lifetime signal. */
export function deriveSessionConversationCapability(
  session: ConversationSession | undefined,
  driverId: SessionDriverId,
): SessionConversationCapability {
  if (!session) return { access: 'unknown', canSubmit: false, reason: 'metadata_pending' };
  if (session.persistedStatus === 'archived') {
    return { access: 'read-only', canSubmit: false, reason: 'archived' };
  }
  if (session.isTransient && !session.agentBackedTransient) {
    return { access: 'read-only', canSubmit: false, reason: 'unsupported_route' };
  }
  if (driverId === 'dispatch') {
    const { dispatchJobId, dispatchTargetRequest, dispatchApprovalPolicy } = session.config;
    // Inheriting a parent's driver grants read ownership, not a child send route.
    if (!dispatchJobId || !dispatchTargetRequest || dispatchTargetRequest.kind === 'local'
      || !dispatchApprovalPolicy) {
      return { access: 'read-only', canSubmit: false, reason: 'unsupported_route' };
    }
  }
  if (session.sessionKind === 'subagent') {
    if (session.continuationPolicy === 'fresh_only') {
      // Current drivers expose no independent steering route for fresh-only children.
      return { access: 'read-only', canSubmit: false, reason: 'fresh_only' };
    }
    if (!session.continuationPolicy) {
      return { access: 'unknown', canSubmit: false, reason: 'metadata_pending' };
    }
  }
  if (session.historyState === 'hydrating') {
    return { access: 'available', canSubmit: false, reason: 'history_loading' };
  }
  return { access: 'available', canSubmit: true };
}

export function getSessionConversationCapability(
  sessionId: string,
  session: Session | undefined,
): SessionConversationCapability {
  return deriveSessionConversationCapability(session, resolveSessionDriverId(sessionId, session));
}

/** Shared preflight for programmatic sends and queued/retried submissions. */
export class SessionConversationUnavailableError extends Error {
  constructor(readonly reason: ConversationUnavailableReason, message?: string) {
    super(message ?? `Session conversation unavailable: ${reason}`);
    this.name = 'SessionConversationUnavailableError';
  }
}

export function assertSessionConversationCanSubmit(
  sessionId: string, session: Session | undefined, message?: string,
): void {
  const capability = getSessionConversationCapability(sessionId, session);
  if (!capability.canSubmit) {
    throw new SessionConversationUnavailableError(capability.reason ?? 'metadata_pending', message);
  }
}
