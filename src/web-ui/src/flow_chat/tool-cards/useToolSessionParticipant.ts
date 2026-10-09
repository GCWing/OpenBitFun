import { createElement, useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ToolCardParticipant } from '@openbitfun/ui/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import { resolveSubagentNameKey, SubagentAvatar } from '../subagent-identity';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { notificationService } from '@/shared/notification-system';

export function subscribeToToolSessions(listener: () => void): () => void {
  const unsubscribe = flowChatStore.subscribe(() => listener());
  const unsubscribeSurface = onSurfaceActivated(listener);
  return () => { unsubscribe(); unsubscribeSurface(); };
}

/** The actor is identified by its position in this conversation, never its title. */
export function useCurrentToolSessionParticipant(sessionId: string | undefined, t: (key: string) => string): ToolCardParticipant {
  const label = t('toolCards.interaction.currentSession');
  const participant = useToolSessionParticipant(sessionId, label, t, 'session', {});
  return useMemo(() => ({ ...participant, label }), [participant, label]);
}

/** Uses the active host's hydrated state only; never fetches from a local fallback. */
export function useToolSessionParticipant(
  sessionId: string | undefined,
  fallback: string,
  t: (key: string) => string,
  kind: 'agent' | 'session' = 'session',
  navigation?: { parentSessionId?: string; parentToolCallId?: string; enabled?: boolean },
): ToolCardParticipant {
  const hasNavigation = Boolean(navigation);
  const parentSessionId = navigation?.parentSessionId;
  const parentToolCallId = navigation?.parentToolCallId;
  const navigationEnabled = navigation?.enabled;
  const readSnapshot = useCallback(() => {
    const { sessions } = flowChatStore.getState();
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const resolvedParentId = session?.parentSessionId || parentSessionId;
    const parent = resolvedParentId ? sessions.get(resolvedParentId) : undefined;
    return JSON.stringify([session?.title?.trim() ?? '', session?.sessionKind === 'subagent', Boolean(session),
      Boolean(parent), Boolean(session?.config?.dispatchTarget || session?.config?.dispatchJobId
        || parent?.config?.dispatchTarget || parent?.config?.dispatchJobId), getActiveSurfaceScope().epoch, resolvedParentId || '']);
  }, [sessionId, parentSessionId]);
  const snapshot = useSyncExternalStore(subscribeToToolSessions, readSnapshot, readSnapshot);
  return useMemo<ToolCardParticipant>(() => {
    const [title, subagent, available, parentAvailable, detached, epoch, resolvedParentId] = JSON.parse(snapshot) as [string, boolean, boolean, boolean, boolean, number, string];
    const agent = subagent || kind === 'agent';
    const label = agent ? sessionId ? t(resolveSubagentNameKey(sessionId)) : fallback : title || fallback;
    const canOpen = hasNavigation && navigationEnabled !== false && !detached && sessionId
      && (agent ? parentAvailable && resolvedParentId !== sessionId : available);
    const link = canOpen ? {
      openLabel: t(agent ? 'toolCards.taskTool.openInPanel' : 'toolCards.builtin.links.openSession'),
      onOpen: () => {
        const scope = getActiveSurfaceScope();
        if (scope.epoch !== epoch) return;
        const child = flowChatStore.getState().sessions.get(sessionId);
        const parentId = child?.parentSessionId || resolvedParentId;
        const parent = parentId ? flowChatStore.getState().sessions.get(parentId) : undefined;
        if (child?.config?.dispatchTarget || child?.config?.dispatchJobId
          || parent?.config?.dispatchTarget || parent?.config?.dispatchJobId) return;
        if (agent) {
          if (!parent || parentId === sessionId) {
            notificationService.error(t('toolCards.interaction.sessionUnavailable'));
            return;
          }
          openBtwSessionInAuxPane({ childSessionId: sessionId, parentSessionId: parentId, sessionKind: 'subagent',
            sessionTitle: label, workspaceId: child?.workspaceId, workspacePath: parent.workspacePath,
            parentToolCallId: child?.parentToolCallId || parentToolCallId,
            agentType: child?.mode || child?.config?.agentType || undefined, subagentType: child?.subagentType,
            remoteConnectionId: parent.remoteConnectionId, remoteSshHost: parent.remoteSshHost, includeInternal: true });
          return;
        }
        void import('../services/sessionActivation').then(async ({ openMainSession }) => {
          if (!scope.isCurrent()) return;
          if (!flowChatStore.getState().sessions.has(sessionId)) throw new Error('Session is no longer available');
          await openMainSession(sessionId, { isCurrent: scope.isCurrent });
        }).catch(() => { if (scope.isCurrent()) notificationService.error(t('toolCards.interaction.sessionUnavailable')); });
      },
    } : {};
    if (subagent || kind === 'agent') {
      return {
        ...link,
        id: sessionId,
        label,
        kind: 'agent',
        avatar: sessionId ? createElement(SubagentAvatar, {
          sessionId, name: label, size: 16, motion: true, showStatus: false,
        }) : undefined,
      };
    }
    return { ...link, id: sessionId, label, kind: 'session' };
  }, [snapshot, sessionId, kind, fallback, t, hasNavigation, navigationEnabled, parentToolCallId]);
}
