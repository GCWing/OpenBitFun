import { useToolCardDisclosure } from '../timeline/readerState';
import React, { Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  GoalToolCard, AgentRosterToolCard, SessionHistoryToolCard, ImageAnalysisToolCard, TimeToolCard,
  McpResourceToolCard, WorktreeToolCard, PortForwardToolCard, ReviewPlatformToolCard,
  FrontendWorkbenchToolCard, MiniAppFinalizeToolCard, MarketplacePublishToolCard, PlaybookToolCard,
  type SemanticToolCardAction, type SemanticToolCardProps, type SemanticToolCardRecord,
} from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useSceneStore } from '@/app/stores/sceneStore';
import { notificationService } from '@/shared/notification-system';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { getActiveSurfaceScope, isLocalSurface, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { openMainSession } from '../services/sessionActivation';
import { sessionProjectWorkspaceId } from '../utils/sessionWorkspace';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { resolveSubagentNameKey, SubagentAvatar } from '../subagent-identity';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { getToolCardStatusDescription } from './toolCardStatus';
import { formatRuntimeToolValue, runtimeToolNeedsConfirmation } from './runtimeToolCardModel';
import { subscribeToToolSessions } from './useToolSessionParticipant';
import { isSemanticBuiltinTool } from './builtinToolCardPolicy';
import { buildBuiltinToolCardModel, type BuiltinCardFamily, type BuiltinCardLink, type BuiltinCardField } from './builtinToolCardModel';
import { resolveBuiltinAgentSessions } from './builtinAgentSessions';

const BuiltinMarketDialog = lazyWithRecovery(() => import('./BuiltinMarketDialog'));
const BuiltinImagePreview = lazyWithRecovery(() => import('./BuiltinImagePreview'));
function subscribeToBuiltinOwner(listener: () => void): () => void {
  const unsubscribeSessions = subscribeToToolSessions(listener);
  const unsubscribeSurface = onSurfaceActivated(listener);
  return () => { unsubscribeSessions(); unsubscribeSurface(); };
}
const views: Record<BuiltinCardFamily, React.ComponentType<SemanticToolCardProps>> = {
  goal: GoalToolCard, 'agent-roster': AgentRosterToolCard, 'session-history': SessionHistoryToolCard,
  'image-analysis': ImageAnalysisToolCard, time: TimeToolCard, 'mcp-resource': McpResourceToolCard,
  worktree: WorktreeToolCard, 'port-forward': PortForwardToolCard, 'review-platform': ReviewPlatformToolCard,
  'frontend-workbench': FrontendWorkbenchToolCard, 'miniapp-finalize': MiniAppFinalizeToolCard,
  'marketplace-publish': MarketplacePublishToolCard, playbook: PlaybookToolCard,
};

export const BuiltinToolCard: React.FC<ToolCardProps> = ({ toolItem, sessionId, onExpand, onOpenInEditor }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setExpanded] = useToolCardDisclosure('isExpanded');
  const [market, setMarket] = useState<'miniapps' | 'appearance'>();
  const [marketOpen, setMarketOpen] = useState(false);
  const name = toolItem.toolName;
  const model = useMemo(() => isSemanticBuiltinTool(name) ? buildBuiltinToolCardModel(toolItem, name, t, formatNumber) : undefined,
    [toolItem, name, t, formatNumber]);
  const { cardRootRef, applyExpandedState, dispatchToolCardToggle } = useToolCardHeightContract({ toolId: toolItem.id, toolName: name });
  const readAgentLinks = useCallback(() => JSON.stringify(model?.family === 'agent-roster'
    ? resolveBuiltinAgentSessions(toolItem, flowChatStore.getState().sessions, sessionId) : {}),
    [model?.family, toolItem, sessionId]);
  const agentSnapshot = useSyncExternalStore(subscribeToBuiltinOwner, readAgentLinks, readAgentLinks);
  const agentLinks = useMemo(() => JSON.parse(agentSnapshot) as Record<string, string>, [agentSnapshot]);
  const readOwner = useCallback(() => {
    const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
    return JSON.stringify([session?.workspaceId ?? session?.config?.workspaceId,
      Boolean(session?.config?.dispatchTarget || session?.config?.dispatchJobId), getActiveSurfaceScope().epoch]);
  }, [sessionId]);
  const ownerSnapshot = useSyncExternalStore(subscribeToBuiltinOwner, readOwner, readOwner);
  const [workspaceId, detached, surfaceEpoch] = JSON.parse(ownerSnapshot) as [string | undefined, boolean, number];
  useEffect(() => { setMarketOpen(false); setMarket(undefined); }, [surfaceEpoch]);
  if (!model) return null;
  const needsConfirmation = runtimeToolNeedsConfirmation(toolItem, model.status);
  const allLinks = [...model.links, ...model.fields.flatMap(field => field.links ?? []),
    ...model.records.flatMap(record => [
      ...(record.links ?? []), ...(record.fields?.flatMap(field => field.links ?? []) ?? []),
    ])];
  const remoteLoopback = name === 'PortForward' && !isLocalSurface(getActiveSurfaceScope().surfaceId)
    && allLinks.some(link => link.kind === 'url' && /^(?:localhost$|127\.|\[::1\]$)/.test(new URL(link.value).hostname));
  const reportFailure = () => notificationService.error(t('toolCards.builtin.actionFailed'));
  const run = (action: () => void | Promise<unknown>) => {
    const scope = getActiveSurfaceScope();
    void Promise.resolve().then(() => { if (scope.isCurrent()) return action(); })
      .catch(() => { if (scope.isCurrent()) reportFailure(); });
  };
  const toActions = (links: readonly BuiltinCardLink[]): SemanticToolCardAction[] => links.flatMap((link, index) => {
    const actions: SemanticToolCardAction[] = [];
    const key = `${link.kind}:${index}:${link.value}`;
    if (link.kind === 'url') actions.push({ key, label: link.label, intent: link.intent, icon: 'arrow-up-right', disabled: remoteLoopback,
      onPress: () => run(() => systemAPI.openExternal(link.value)) });
    if (link.kind === 'file' && onOpenInEditor) actions.push({ key, label: link.label, icon: 'arrow-up-right', disabled: detached, onPress: () => run(() => onOpenInEditor(link.value)) });
    if (link.kind === 'session') actions.push({ key, label: link.label, icon: 'session', disabled: detached, onPress: () => run(async () => {
      const scope = getActiveSurfaceScope();
      if (!flowChatStore.getState().sessions.has(link.value)) {
        const owner = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
        const ownerId = owner && sessionProjectWorkspaceId(owner);
        const { flowChatManager } = await import('../services/FlowChatManager');
        if (!scope.isCurrent()) return;
        if (ownerId) await flowChatManager.refreshWorkspaceSessions({ id: ownerId });
      }
      if (!scope.isCurrent()) return;
      if (!flowChatStore.getState().sessions.has(link.value)) throw new Error('Session is no longer available');
      return openMainSession(link.value);
    }) });
    if (link.kind === 'miniapp') actions.push({ key, label: link.label, icon: 'mini-app', disabled: detached || !workspaceId, onPress: () => run(async () => {
      const scope = getActiveSurfaceScope();
      const { workspaceManager } = await import('@/infrastructure/services/business/workspaceManager');
      if (!scope.isCurrent() || !workspaceId) return;
      await workspaceManager.setActiveWorkspace(workspaceId);
      if (scope.isCurrent()) useSceneStore.getState().openScene(`miniapp:${link.value}`);
    }) });
    if (link.kind === 'market') actions.push({ key, label: link.label, icon: 'store', disabled: detached,
      onPress: () => { setMarket(link.value === 'appearance' ? 'appearance' : 'miniapps'); setMarketOpen(true); } });
    if (link.kind === 'review') actions.push({ key, label: link.label, icon: 'git-pull-request', disabled: detached || !workspaceId,
      onPress: () => run(async () => {
        const scope = getActiveSurfaceScope();
        const { createReviewPlatformTab } = await import('@/shared/utils/tabUtils');
        if (scope.isCurrent() && workspaceId) createReviewPlatformTab(workspaceId, link.value);
      }) });
    if (link.intent !== 'primary' && (link.kind === 'url' || link.kind === 'file' || link.kind === 'copy-path')) actions.push({ key: `${key}:copy`,
      label: t(link.kind === 'url' ? 'toolCards.builtin.links.copyAddress' : 'toolCards.builtin.links.copyPath'), icon: 'duplicate',
      onPress: () => run(async () => {
        if (!await copyTextToClipboard(link.value)) throw new Error('Copy failed');
        notificationService.success(t('toolCards.builtin.copied'));
      }) });
    return actions;
  });
  const toFields = (fields: readonly BuiltinCardField[]) => fields.map(({ links, ...field }) => ({
    ...field, controls: links ? toActions(links) : undefined,
  }));
  const records: SemanticToolCardRecord[] = model.records.map(record => {
    const target = record.agentId ? agentLinks[record.agentId] : undefined;
    const label = target ? t(resolveSubagentNameKey(target)) : record.title;
    const actions = toActions(record.links ?? []);
    if (target && sessionId && name !== 'AgentDelete') actions.push({ key: 'open-agent', label: t('toolCards.builtin.links.openSession'), icon: 'session',
      onPress: () => run(() => {
        const parent = flowChatStore.getState().sessions.get(sessionId);
        const child = flowChatStore.getState().sessions.get(target);
        return openBtwSessionInAuxPane({ childSessionId: target, parentSessionId: sessionId, sessionKind: 'subagent',
          sessionTitle: label, workspaceId: child?.workspaceId, workspacePath: parent?.workspacePath,
          parentToolCallId: child?.parentToolCallId, agentType: child?.mode || child?.config?.agentType || undefined,
          subagentType: child?.subagentType, remoteConnectionId: parent?.remoteConnectionId, remoteSshHost: parent?.remoteSshHost, includeInternal: true });
      }) });
    return { ...record, fields: record.fields ? toFields(record.fields) : undefined, title: label, actions, leading: target
      ? <SubagentAvatar sessionId={target} name={label} size={16} motion={false} showStatus={false} /> : undefined };
  });
  const View = views[model.family];
  const common: SemanticToolCardProps = {
    status: model.status, action: model.action, attention: model.attention, summary: model.summary,
    resultSummary: model.resultSummary, outcome: model.outcome, fields: toFields(model.fields), records, recordsLabel: model.recordsLabel,
    sections: model.sections, emptyContent: model.emptyContent, error: model.error,
    notice: detached && allLinks.some(link => ['file', 'session', 'miniapp', 'review', 'market'].includes(link.kind))
      ? [model.notice, t('toolCards.builtin.hostUnavailable')].filter(Boolean).join('\n')
      : remoteLoopback ? [model.notice, t('toolCards.builtin.remoteLoopback')].filter(Boolean).join('\n') : model.notice,
    connection: model.connection, ordered: model.ordered, actions: toActions(model.links),
    media: isExpanded && model.family === 'image-analysis' ? model.imageSources.length > 0
      ? model.imageSources.map((src, index) => <img src={src} key={index} alt={model.summary ?? model.action} loading="lazy" onLoad={dispatchToolCardToggle} />)
      : model.sourcePath && <Suspense fallback={t('toolCards.builtin.imageLoading')}>
        <BuiltinImagePreview key={`${surfaceEpoch}:${workspaceId}:${model.sourcePath}`} path={model.sourcePath} workspaceId={detached ? undefined : workspaceId} onResize={dispatchToolCardToggle} />
      </Suspense> : undefined,
    paramsText: isExpanded ? formatRuntimeToolValue(model.input) : undefined,
    resultText: isExpanded ? formatRuntimeToolValue(model.rawResult) : undefined,
    detailsAvailable: model.rawResult !== undefined || Object.keys(model.input).some(key => model.input[key] !== undefined),
    paramsLabel: t('toolCards.common.inputParams'), resultLabel: t('toolCards.builtin.rawResult'),
    statusDescription: getToolCardStatusDescription(needsConfirmation ? 'pending_confirmation' : model.status, t, model.error),
    requiresConfirmation: needsConfirmation, isExpanded, onDetailsChange: dispatchToolCardToggle,
    onToggle: () => applyExpandedState(isExpanded, !isExpanded, setExpanded, { onExpand }),
  };
  return <div ref={cardRootRef} data-openbitfun-adapter="builtin-semantic" data-tool-card-id={toolItem.id}>
    {model.family === 'agent-roster' ? <AgentRosterToolCard {...common} deleting={name === 'AgentDelete'} />
      : model.family === 'marketplace-publish' ? <MarketplacePublishToolCard {...common} appearance={name === 'PublishAppearance'} />
        : model.family === 'mcp-resource' ? <McpResourceToolCard {...common} kind={name === 'ListMCPResources' ? 'resources'
          : name === 'ReadMCPResource' ? 'resource' : name === 'ListMCPPrompts' ? 'prompts' : 'prompt'} />
          : <View {...common} />}
    {market && <Suspense fallback={null}><BuiltinMarketDialog kind={market} open={marketOpen}
      onClose={() => setMarketOpen(false)} onExited={() => setMarket(undefined)} /></Suspense>}
  </div>;
};
