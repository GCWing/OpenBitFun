import { i18nService } from '@/infrastructure/i18n/core/I18nService';
import type {
  SessionCustomMetadata,
  SessionRelationship,
  SessionKind,
  SessionMetadata,
} from '@/shared/types/session-history';
import type { Session } from '../types/flow-chat';
import { resolveSessionTitle } from './sessionTitle';
import { canonicalSessionTurns, lastUserDialogTurn, projectedSessionTurnCount } from './flowChatTurnIdentity';
import { isTurnAwaitingRecovery } from './interruptedTurnRecovery';

const CHILD_SESSION_KIND_TAGS = new Set<SessionKind>(['btw', 'review', 'deep_review', 'miniapp', 'subagent']);
const RELATIONSHIP_METADATA_KEYS = new Set([
  'kind',
  'parentSessionId',
  'parentRequestId',
  'parentDialogTurnId',
  'parentTurnIndex',
  'parentToolCallId',
  'subagentType',
]);
const TITLE_METADATA_KEYS = new Set([
  'titleSource',
  'titleKey',
  'titleParams',
]);
const TOP_LEVEL_METADATA_KEYS = new Set([
  'lastFinishedAt',
]);

type SessionRelationshipInput = Pick<
  Session,
  'sessionKind' | 'parentSessionId' | 'btwOrigin' | 'parentToolCallId' | 'subagentType'
>;

export interface ResolvedSessionRelationship {
  kind: SessionKind;
  isBtw: boolean;
  isSubagent: boolean;
  isReview: boolean;
  isDeepReview: boolean;
  parentSessionId?: string;
  displayAsChild: boolean;
  canOpenInAuxPane: boolean;
  origin?: Session['btwOrigin'];
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeTurnIndex(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function normalizeSessionKind(value: unknown): SessionKind {
  if (
    value === 'btw' ||
    value === 'review' ||
    value === 'deep_review' ||
    value === 'miniapp' ||
    value === 'subagent'
  ) {
    return value;
  }

  return 'normal';
}

export function normalizeSessionRelationship(
  input?: Partial<SessionRelationshipInput> | null
): Pick<
  Session,
  'sessionKind' | 'parentSessionId' | 'btwOrigin' | 'parentToolCallId' | 'subagentType'
> {
  const sessionKind = normalizeSessionKind(input?.sessionKind);
  const parentSessionId = normalizeString(
    input?.btwOrigin?.parentSessionId ?? input?.parentSessionId
  );
  const parentToolCallId =
    sessionKind === 'subagent'
      ? normalizeString(input?.parentToolCallId)
      : undefined;
  const subagentType =
    sessionKind === 'subagent'
      ? normalizeString(input?.subagentType)
      : undefined;

  if (sessionKind === 'normal' || sessionKind === 'miniapp') {
    return {
      sessionKind,
      parentSessionId: undefined,
      btwOrigin: undefined,
      parentToolCallId: undefined,
      subagentType: undefined,
    };
  }

  const origin: Session['btwOrigin'] = {
    requestId: normalizeString(input?.btwOrigin?.requestId),
    parentSessionId,
    parentDialogTurnId: normalizeString(input?.btwOrigin?.parentDialogTurnId),
    parentTurnIndex: normalizeTurnIndex(input?.btwOrigin?.parentTurnIndex),
  };

  return {
    sessionKind,
    parentSessionId,
    btwOrigin: origin,
    parentToolCallId,
    subagentType,
  };
}

export function resolveSessionRelationship(
  input?: Partial<SessionRelationshipInput> | null
): ResolvedSessionRelationship {
  const normalized = normalizeSessionRelationship(input);
  const isBtw = normalized.sessionKind === 'btw';
  const isSubagent = normalized.sessionKind === 'subagent';
  const isReview =
    normalized.sessionKind === 'review' ||
    normalized.sessionKind === 'deep_review';

  return {
    kind: normalized.sessionKind,
    isBtw,
    isSubagent,
    isReview,
    isDeepReview: normalized.sessionKind === 'deep_review',
    parentSessionId: normalized.parentSessionId,
    displayAsChild: Boolean(normalized.parentSessionId),
    canOpenInAuxPane: Boolean(
      normalized.sessionKind !== 'normal' && normalized.parentSessionId
    ),
    origin: normalized.btwOrigin,
  };
}

export function deriveSessionRelationshipFromMetadata(
  metadata?: Pick<SessionMetadata, 'customMetadata' | 'relationship'> | null
): Pick<
  Session,
  'sessionKind' | 'parentSessionId' | 'btwOrigin' | 'parentToolCallId' | 'subagentType'
> {
  const relationship = metadata?.relationship;
  const relationshipKind = normalizeSessionKind(relationship?.kind);
  if (relationshipKind !== 'normal') {
    return normalizeSessionRelationship({
      sessionKind: relationshipKind,
      parentSessionId: normalizeString(relationship?.parentSessionId) ?? undefined,
      parentToolCallId: normalizeString(relationship?.parentToolCallId),
      subagentType: normalizeString(relationship?.subagentType),
      btwOrigin: {
        requestId: normalizeString(relationship?.parentRequestId),
        parentSessionId: normalizeString(relationship?.parentSessionId),
        parentDialogTurnId: normalizeString(relationship?.parentDialogTurnId),
        parentTurnIndex: normalizeTurnIndex(relationship?.parentTurnIndex),
      },
    });
  }

  const customMetadata = metadata?.customMetadata;
  const rawSessionKind = normalizeSessionKind(customMetadata?.kind);
  const sessionKind = rawSessionKind === 'btw' ? 'normal' : rawSessionKind;

  return normalizeSessionRelationship({
    sessionKind,
    parentSessionId: customMetadata?.parentSessionId ?? undefined,
    parentToolCallId: normalizeString(customMetadata?.parentToolCallId),
    subagentType: normalizeString(customMetadata?.subagentType),
    btwOrigin:
      sessionKind !== 'normal'
        ? {
            requestId: normalizeString(customMetadata?.parentRequestId),
            parentSessionId: normalizeString(customMetadata?.parentSessionId),
            parentDialogTurnId: normalizeString(customMetadata?.parentDialogTurnId),
            parentTurnIndex: normalizeTurnIndex(customMetadata?.parentTurnIndex),
          }
        : undefined,
  });
}

export function deriveLastFinishedAtFromMetadata(
  metadata?: Pick<SessionMetadata, 'lastFinishedAt' | 'customMetadata'> | null
): number | undefined {
  const value = metadata?.lastFinishedAt ?? metadata?.customMetadata?.lastFinishedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function calculateSessionStats(
  session: Pick<
    Session,
    'sessionId' | 'dialogTurns' | 'isPartial' | 'totalTurnCount' | 'turnCatalog'
  >
): Pick<SessionMetadata, 'turnCount' | 'messageCount' | 'toolCallCount'> {
  const loadedPersistedTurns = canonicalSessionTurns(session);
  const turnCount = projectedSessionTurnCount(session);
  const messageCount = loadedPersistedTurns.reduce((sum, turn) => {
    return (
      sum +
      1 +
      turn.modelRounds.reduce((roundSum, round) => {
        return roundSum + round.items.filter(item => item.type === 'text').length;
      }, 0)
    );
  }, 0);
  const toolCallCount = loadedPersistedTurns.reduce((sum, turn) => {
    return sum + turn.modelRounds.reduce((roundSum, round) => {
      return roundSum + round.items.filter(item => item.type === 'tool').length;
    }, 0);
  }, 0);

  return { turnCount, messageCount, toolCallCount };
}

function buildSessionCustomMetadata(
  session: Pick<
    Session,
    | 'lastFinishedAt'
    | 'titleSource'
    | 'titleI18nKey'
    | 'titleI18nParams'
  >,
  existingCustomMetadata?: SessionCustomMetadata
): SessionCustomMetadata {
  const nextCustomMetadata: SessionCustomMetadata = {};

  for (const [key, value] of Object.entries(existingCustomMetadata || {})) {
    if (
      !RELATIONSHIP_METADATA_KEYS.has(key) &&
      !TITLE_METADATA_KEYS.has(key) &&
      !TOP_LEVEL_METADATA_KEYS.has(key)
    ) {
      nextCustomMetadata[key] = value;
    }
  }

  // Default untitled sessions persist their title template so locale changes can
  // re-render them until the first real title is generated or the user renames it.
  if (session.titleSource === 'i18n' && normalizeString(session.titleI18nKey)) {
    nextCustomMetadata.titleSource = 'i18n';
    nextCustomMetadata.titleKey = session.titleI18nKey;
    nextCustomMetadata.titleParams = {
      ...session.titleI18nParams,
      defaultTitleText: resolveSessionTitle(session, (key, options) => i18nService.t(key, options)),
    };
  }

  return nextCustomMetadata;
}

function buildSessionRelationshipMetadata(
  session: Pick<
    Session,
    'sessionKind' | 'parentSessionId' | 'btwOrigin' | 'parentToolCallId' | 'subagentType'
  >,
  existingRelationship?: SessionRelationship | null
): SessionRelationship | undefined {
  const normalized = normalizeSessionRelationship(session);

  if (normalized.sessionKind === 'normal') {
    return existingRelationship ?? undefined;
  }

  return {
    kind: normalized.sessionKind,
    parentSessionId: normalized.parentSessionId ?? null,
    parentRequestId: normalized.btwOrigin?.requestId ?? null,
    parentDialogTurnId: normalized.btwOrigin?.parentDialogTurnId ?? null,
    parentTurnIndex: normalized.btwOrigin?.parentTurnIndex ?? null,
    parentToolCallId:
      normalized.sessionKind === 'subagent'
        ? normalized.parentToolCallId ?? null
        : null,
    subagentType:
      normalized.sessionKind === 'subagent'
        ? normalized.subagentType ?? null
        : null,
  };
}

export function buildCreateSessionRelationship(
  session: Pick<
    Session,
    | 'sessionKind'
    | 'parentSessionId'
    | 'btwOrigin'
    | 'parentToolCallId'
    | 'subagentType'
  >
): SessionRelationship | undefined {
  const normalized = normalizeSessionRelationship(session);

  if (normalized.sessionKind === 'normal') {
    return undefined;
  }

  return buildSessionRelationshipMetadata(
    {
      sessionKind: normalized.sessionKind,
      parentSessionId: normalized.parentSessionId,
      btwOrigin: normalized.btwOrigin,
      parentToolCallId: normalized.parentToolCallId,
      subagentType: normalized.subagentType,
    },
    null
  );
}

function buildSessionTags(
  sessionKind: SessionKind,
  existingTags?: string[]
): string[] {
  const baseTags = Array.isArray(existingTags)
    ? existingTags.filter(
        (tag) =>
          !CHILD_SESSION_KIND_TAGS.has(tag as SessionKind) || tag === sessionKind
      )
    : [];

  if (sessionKind !== 'normal' && !baseTags.includes(sessionKind)) {
    baseTags.push(sessionKind);
  }

  return baseTags;
}

export function buildSessionMetadata(
  session: Pick<
    Session,
    | 'sessionId'
    | 'title'
    | 'mode'
    | 'config'
    | 'createdAt'
    | 'workspaceId'
    | 'projectWorkspaceId'
    | 'workspacePath'
    | 'projectWorkspacePath'
    | 'remoteConnectionId'
    | 'remoteSshHost'
    | 'todos'
    | 'dialogTurns'
    | 'isPartial'
    | 'totalTurnCount'
    | 'turnCatalog'
    | 'sessionKind'
    | 'parentSessionId'
    | 'btwOrigin'
    | 'parentToolCallId'
    | 'subagentType'
    | 'lastFinishedAt'
    | 'titleSource'
    | 'titleI18nKey'
    | 'titleI18nParams'
    | 'hasUnreadCompletion'
    | 'needsUserAttention'
    | 'deepReviewRunManifest'
    | 'reviewTargetEvidence'
  >,
  existingMetadata?: SessionMetadata | null
): SessionMetadata {
  const stats = calculateSessionStats(session);
  const sessionKind = normalizeSessionKind(session.sessionKind);
  const persistedSessionKind = sessionKind === 'subagent' ? 'subagent' : 'standard';
  const visibleLastTurn = lastUserDialogTurn(session);

  return {
    ...existingMetadata,
    sessionId: session.sessionId,
    sessionName: resolveSessionTitle(session, (key, options) =>
      i18nService.t(key, options)
    ),
    agentType:
      session.mode ||
      session.config.agentType ||
      existingMetadata?.agentType ||
      'Standard',
    modelName:
      session.config.modelName || existingMetadata?.modelName || 'primary',
    createdAt: existingMetadata?.createdAt ?? session.createdAt,
    lastActiveAt: Date.now(),
    lastFinishedAt: session.lastFinishedAt ?? null,
    // The acknowledgement belongs to the rendered result, not a newer metadata
    // record that happened to arrive while its persistence request was waiting.
    lastTurn: visibleLastTurn ? {
      turnId: visibleLastTurn.id,
      turnIndex: visibleLastTurn.storageTurnIndex ?? visibleLastTurn.backendTurnIndex ?? 0,
      status: visibleLastTurn.status === 'completed' ? 'completed'
        : visibleLastTurn.status === 'error' ? 'error' : visibleLastTurn.status === 'cancelled' ? 'cancelled' : 'inprogress',
      endTime: visibleLastTurn.endTime,
      executionGeneration: visibleLastTurn.recovery?.executionGeneration ?? visibleLastTurn.recoveryEpoch,
      recoveryPending: isTurnAwaitingRecovery(visibleLastTurn),
    } : undefined,
    turnCount: Math.max(stats.turnCount, existingMetadata?.turnCount ?? 0),
    messageCount: Math.max(
      stats.messageCount,
      existingMetadata?.messageCount ?? 0
    ),
    toolCallCount: Math.max(
      stats.toolCallCount,
      existingMetadata?.toolCallCount ?? 0
    ),
    sessionKind: persistedSessionKind,
    status: 'active',
    snapshotSessionId: existingMetadata?.snapshotSessionId,
    tags: buildSessionTags(sessionKind, existingMetadata?.tags),
    customMetadata: buildSessionCustomMetadata(
      {
        lastFinishedAt: session.lastFinishedAt,
        titleSource: session.titleSource,
        titleI18nKey: session.titleI18nKey,
        titleI18nParams: session.titleI18nParams,
      },
      existingMetadata?.customMetadata
    ),
    relationship: buildSessionRelationshipMetadata(
      {
        sessionKind,
        parentSessionId: session.parentSessionId,
        btwOrigin: session.btwOrigin,
        parentToolCallId: session.parentToolCallId,
        subagentType: session.subagentType,
      },
      existingMetadata?.relationship
    ),
    todos: session.todos || existingMetadata?.todos || [],
    workspaceId: session.workspaceId || session.config?.workspaceId || existingMetadata?.workspaceId,
    projectWorkspaceId: session.projectWorkspaceId || session.config?.projectWorkspaceId || existingMetadata?.projectWorkspaceId,
    workspacePath: session.workspacePath || existingMetadata?.workspacePath,
    projectWorkspacePath:
      session.projectWorkspacePath
      || session.config.projectWorkspacePath
      || session.workspacePath
      || existingMetadata?.projectWorkspacePath,
    executionTarget:
      session.config.executionTarget ?? existingMetadata?.executionTarget,
    remoteConnectionId:
      session.remoteConnectionId ?? existingMetadata?.remoteConnectionId,
    remoteSshHost: session.remoteSshHost ?? existingMetadata?.remoteSshHost,
    // Always use the in-memory session value as the source of truth.
    // Previously this used `??` to fall back to existingMetadata, which prevented
    // clears from reaching disk: when the store sets `hasUnreadCompletion: undefined`,
    // `undefined ?? existingMetadata.unreadCompletion` would restore the old value.
    unreadCompletion: session.hasUnreadCompletion,
    needsUserAttention: session.needsUserAttention,
    deepReviewRunManifest:
      session.deepReviewRunManifest ?? existingMetadata?.deepReviewRunManifest,
    reviewTargetEvidence:
      session.reviewTargetEvidence ?? existingMetadata?.reviewTargetEvidence,
  };
}
