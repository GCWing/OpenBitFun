import type { ContentResourceScope } from '@/shared/types/contentResource';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatState, FlowToolItem, Session } from '../types/flow-chat';
import {
  effectiveToolInvocation,
  getEffectiveToolName,
  projectEffectiveToolItem,
} from './toolInvocationIdentity';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { isGenUIAppEnvelope, type GenUIAppEnvelope, type GenUIAppState } from '@/tools/generative-ui/genUITypes';
import { genUICatalog } from '@/tools/generative-ui/genUIContract';
import { resolveGenUIInteractionState, type GenUIInteractionState } from '@/tools/generative-ui/genUIInteractionState';

export const GENERATIVE_WIDGET_TOOL_NAME = 'GenerativeUI';
export interface GenerativeWidgetOrigin {
  type: 'tool-call';
  toolName: typeof GENERATIVE_WIDGET_TOOL_NAME;
  surfaceId: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  toolItemId?: string;
  scope: ContentResourceScope;
}

export interface GenerativeWidgetProjection {
  origin: GenerativeWidgetOrigin;
  widgetId: string;
  title: string;
  app?: GenUIAppEnvelope;
  appState?: GenUIAppState;
  ownerRevision?: string;
  deliveryEvidence?: Record<string, unknown>;
  /** OpenUI is transient by default; Harmony is the explicit delivery mode. */
  deliveryMode: 'transient' | 'delivery';
  status: FlowToolItem['status'];
  isStreaming: boolean;
  isComplete: boolean;
  isFailed: boolean;
  sourceAvailable: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
  /** User-facing lifecycle, independent from the tool's terminal status. */
  interactionState?: GenUIInteractionState;
}

type WidgetPayload = {
  widget_id?: unknown;
  title?: unknown;
  app?: unknown;
  app_state?: unknown;
  owner_revision?: unknown;
  verification?: unknown;
};

function recordPayload(raw: unknown): WidgetPayload | null {
  if (typeof raw === 'string') {
    try {
      return recordPayload(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as WidgetPayload
    : null;
}

function widgetPayload(raw: unknown): WidgetPayload | null {
  const payload = recordPayload(raw);
  if (!payload || typeof (payload as Record<string, unknown>).tool_name !== 'string') {
    return payload;
  }

  const deferred = effectiveToolInvocation('CallDeferredTool', payload);
  return recordPayload(deferred.input);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstTemplateForLibrary(libraryId: string): string {
  const template = Object.entries(genUICatalog.templates).find(([, value]) => value.library === libraryId)?.[0];
  return template ?? 'openui.app';
}

function defaultDesignSpecForLibrary(libraryId: string): { id: string; revision: number } {
  if (libraryId.includes('harmony')) return { id: 'harmony.phone.v1', revision: 1 };
  return { id: 'openbitfun.desktop.v1', revision: 1 };
}

function libraryRevisionFor(libraryId: string): number {
  const adapter = (genUICatalog.libraryAdapters as Record<string, { revision?: unknown }>)[libraryId];
  const revision = adapter?.revision;
  if (!Number.isInteger(revision)) throw new Error(`Unknown GenUI library revision: ${libraryId}`);
  return revision as number;
}

function buildStreamingApp(
  candidate: Record<string, unknown> | undefined,
  stream: {
    content: string;
    messageId: string;
    appId?: string;
    title?: string;
    template?: string;
    libraryId?: string;
    libraryRevision?: number;
  },
  fallbackId: string,
): Record<string, unknown> {
  const app = candidate ?? {};
  const libraryId = typeof app.libraryId === 'string' && app.libraryId
    ? app.libraryId
    : stream.libraryId ?? 'openbitfun.composable.v1';
  const content = stream.content;
  return {
    schemaVersion: 2,
    id: typeof app.id === 'string' && app.id ? app.id : (stream.appId ?? stream.messageId) || fallbackId,
    title: typeof app.title === 'string' && app.title ? app.title : stream.title ?? 'Generative UI',
    template: typeof app.template === 'string' && app.template ? app.template : stream.template ?? firstTemplateForLibrary(libraryId),
    libraryId,
    libraryRevision: typeof app.libraryRevision === 'number' ? app.libraryRevision : stream.libraryRevision ?? libraryRevisionFor(libraryId),
    designSpec: app.designSpec && typeof app.designSpec === 'object' ? app.designSpec : defaultDesignSpecForLibrary(libraryId),
    source: { kind: 'openui-lang', content },
    state: app.state && typeof app.state === 'object' && !Array.isArray(app.state) ? app.state : {},
    ...(typeof app.description === 'string' ? { description: app.description } : {}),
  };
}

function sessionScope(session: Session, surfaceId: string): ContentResourceScope {
  return {
    surfaceId,
    workspaceId: session.workspaceId ?? session.config?.workspaceId,
    workspacePath: session.workspacePath ?? session.config?.workspacePath,
    remoteConnectionId: session.remoteConnectionId ?? session.config?.remoteConnectionId,
  };
}

export function createGenerativeWidgetOrigin(
  session: Session,
  ids: Pick<GenerativeWidgetOrigin, 'turnId' | 'toolCallId' | 'toolItemId'>,
  surfaceId = getActiveSurfaceId(),
): GenerativeWidgetOrigin {
  return {
    type: 'tool-call',
    toolName: GENERATIVE_WIDGET_TOOL_NAME,
    surfaceId,
    sessionId: session.sessionId,
    ...ids,
    scope: sessionScope(session, surfaceId),
  };
}

export function projectGenerativeWidgetTool(
  session: Session,
  toolItem: FlowToolItem,
  ids: Pick<GenerativeWidgetOrigin, 'turnId'> = {},
  surfaceId = getActiveSurfaceId(),
): GenerativeWidgetProjection | null {
  const projected = projectEffectiveToolItem(toolItem);
  if (getEffectiveToolName(toolItem) !== GENERATIVE_WIDGET_TOOL_NAME) return null;

  const isFailed = projected.status === 'error'
    || (projected.status === 'completed' && projected.toolResult?.success === false);
  const isCancelled = projected.status === 'cancelled';
  const isRejected = projected.status === 'rejected';
  const isComplete = projected.status === 'completed' || isFailed
    || projected.status === 'cancelled' || projected.status === 'rejected';

  const input = projected.toolCall?.input as Record<string, unknown> | undefined;
  const result = widgetPayload(projected.toolResult?.result);
  // A terminal result is authoritative. During streaming, the native source
  // event is the only renderable representation and is replaced by the final
  // result later.
  let appCandidate = parseObject(result?.app ?? input?.app);
  const streamedOpenUI = !isComplete && projected._genUIStream?.content
    ? projected._genUIStream
    : undefined;
  // The source program is allowed to become visible before the enclosing tool
  // arguments form a complete JSON document. OpenUI owns parsing of the
  // program; this projection only supplies the application identity needed by
  // the trusted renderer.
  if (streamedOpenUI?.content) {
    appCandidate = buildStreamingApp(appCandidate, streamedOpenUI, projected.toolCall?.id ?? projected.id);
  }
  const app = isGenUIAppEnvelope(appCandidate) ? appCandidate : undefined;
  const appStateCandidate = isComplete ? parseObject(result?.app_state ?? input?.app_state) : undefined;
  const appState = appStateCandidate as GenUIAppState | undefined;
  const title = app?.title ?? firstString(result?.title, input?.title) ?? 'Generative UI';
  const widgetId = firstString(result?.widget_id, input?.widget_id, projected.toolCall?.id, projected.id) ?? projected.id;
  const deliveryEvidence = parseObject(result?.verification);
  const appIdentity = app as unknown as Record<string, unknown> | undefined;
  const deliveryMode: GenerativeWidgetProjection['deliveryMode'] = deliveryEvidence?.mode === 'delivery'
    || (typeof appIdentity?.libraryId === 'string' && appIdentity.libraryId.includes('.harmony.'))
    || (typeof appIdentity?.template === 'string' && appIdentity.template.includes('.harmony.'))
    ? 'delivery'
    : 'transient';
  const readOnlyReason = resolveSessionDriverId(session.sessionId, session) === 'dispatch' ? 'GenUI state updates are unsupported for target-owned dispatch sessions' : undefined;

  return {
    origin: createGenerativeWidgetOrigin(session, {
      ...ids,
      toolCallId: projected.toolCall?.id,
      toolItemId: projected.id,
    }, surfaceId),
    widgetId,
    title,
    app,
    appState,
    ownerRevision: typeof result?.owner_revision === 'string' ? result.owner_revision : undefined,
    deliveryEvidence,
    deliveryMode,
    status: projected.status,
    isStreaming: !isComplete,
    isComplete,
    isFailed,
    sourceAvailable: Boolean(app),
    // Streaming UI remains locally interactive. Durable edits are enabled only
    // after the owner has accepted the completed source; the surface decides
    // when to call the persistence bridge.
    readOnly: !app || isFailed || isCancelled || isRejected || session.isTransient === true || session.draft?.phase === 'editing' || session.draft?.phase === 'creating' || Boolean(session.dialogTurns.find(turn => turn.id === ids.turnId)?.recovery) || resolveSessionDriverId(session.sessionId, session) === 'dispatch',
    readOnlyReason,
    interactionState: resolveGenUIInteractionState({
      app,
      toolStatus: projected.status,
      isStreaming: !isComplete,
      isFailed,
      isCancelled,
      isRejected,
      dataPending: false,
      deliveryAccepted: Boolean(deliveryEvidence && deliveryEvidence.persistence === 'saved' && deliveryEvidence.reopen === 'passed'),
      requiresDelivery: deliveryMode === 'delivery',
      deliveryUnavailable: Boolean(readOnlyReason),
    }),
  };
}

export function collectGenerativeWidgetProjections(
  session: Session,
  surfaceId = getActiveSurfaceId(),
): GenerativeWidgetProjection[] {
  const projections: GenerativeWidgetProjection[] = [];
  for (const turn of session.dialogTurns) {
    for (const round of turn.modelRounds) {
      for (const item of round.items) {
        if (item.type !== 'tool') continue;
        const projection = projectGenerativeWidgetTool(session, item, { turnId: turn.id }, surfaceId);
        if (projection) projections.push(projection);
      }
    }
  }
  return projections;
}

export function findGenerativeWidgetProjection(
  state: FlowChatState,
  origin: Pick<GenerativeWidgetOrigin, 'surfaceId' | 'sessionId' | 'toolCallId' | 'toolItemId' | 'turnId'>,
  followRepairs = false,
): GenerativeWidgetProjection | null {
  if (origin.surfaceId !== getActiveSurfaceId()) return null;
  const session = state.sessions.get(origin.sessionId);
  if (!session) return null;
  const candidates = collectGenerativeWidgetProjections(session, origin.surfaceId);
  const original = candidates.find(candidate => {
    const source = candidate.origin;
    return (!origin.toolCallId || source.toolCallId === origin.toolCallId)
      && (!origin.toolItemId || source.toolItemId === origin.toolItemId)
      && (!origin.turnId || source.turnId === origin.turnId);
  }) ?? null;
  // Presentation may follow a failed candidate's retry in the same turn. An
  // accepted/saved app stays bound to its owner; persistence always uses exact
  // source identity, never this presentation-only opt-in.
  if (!followRepairs || !original?.isFailed || !original.app || original.appState) return original;
  const later = candidates.slice(candidates.indexOf(original) + 1).filter(candidate => candidate.origin.turnId === original.origin.turnId && candidate.app?.id === original.app!.id);
  // Stop at the first successful or running replacement. A later candidate
  // must not displace an accepted replacement's state merely because this
  // panel was originally opened from a failed call.
  return later.find(candidate => !candidate.isFailed || candidate.appState) ?? later.at(-1) ?? original;
}

