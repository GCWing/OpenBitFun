/**
 * Session rows of a device the window is not rendering (or is still switching
 * to), drawn from that device's own FlowChat container.
 *
 * Everything that decides which rows appear and in what order is the live
 * list's: the same hierarchy, comparator, view filters, first-level limit and
 * "show more" rule. A device therefore looks identical before, during and
 * after a switch, and the hand-over to the live list moves nothing.
 */

import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Icon, OverflowText, StatusPill } from '@openbitfun/ui';
import { Loader2 } from 'lucide-react';
import { useI18n, i18nService } from '@/infrastructure/i18n';
import { surfaceScopedKey, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { sessionNavStatusService } from '@/flow_chat/services/sessionNavStatusService';
import { knownWorkspaceSessionTotal } from '@/flow_chat/services/workspaceSessionTotals';
import { resolveSessionTitle } from '@/flow_chat/utils/sessionTitle';
import type { Session } from '@/flow_chat/types/flow-chat';
import type { SessionActivitySummary, SessionMetadata } from '@/shared/types/session-history';
import {
  compareWorkspaceNavSessions,
  matchesWorkspaceSessionView,
  matchesWorkspaceSourceAgent,
  sessionSourceAgentLabel,
  useWorkspaceSessionViewStore,
  workspaceSessionViewKey,
} from '../../workspaceSessionView';
import { getWorkspaceSessionHierarchy } from '../sessions/sessionNavHierarchy';
import {
  getSessionDisplayLimit,
  getSessionExpandToggleState,
  nextSessionDisplayCount,
  SESSIONS_PREFETCH_COUNT,
} from '../sessions/sessionNavExpand';
import { useSessionNavExpansion } from '../sessions/useSessionNavExpansion';
import { isWorkspaceSessionsCollapsed } from '../workspaces/workspaceDisclosure';
import { SessionStatusMark } from '../sessions/SessionStatusIndicator';
import { useCatalogSessionStatus } from './catalogSessionStatus';
import { openDeviceSession } from './openOnDevice';
import { useSurfaceSessions } from './useSurfaceSessions';
import { getChildSessionBadge } from '../sessions/sessionRowBadges';
import { SessionTitleNumber } from '@/flow_chat/components/SessionTitleNumber';
import { useSessionTitleNumbers } from '@/flow_chat/hooks/useSessionTitleNumbers';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';
import type { SidebarDeviceSlot } from './useSidebarDevices';

export interface BackgroundActions {
  pendingKey: string | null;
  run: (key: string, action: () => Promise<void>, failureKey: string, extra?: { sessionId?: string; title?: string }) => void;
}

const getTitle = (session: Session): string => resolveSessionTitle(session, (key, options) => i18nService.t(key, options));

function useCatalogActivities(surfaceId: DeviceSurfaceId, workspaceIds: readonly string[]) {
  const subscribe = useCallback((notify: () => void) => deviceWorkspaceCatalog.subscribe(changed => {
    if (changed === surfaceId) notify();
  }), [surfaceId]);
  const read = useCallback(() => deviceWorkspaceCatalog.getSnapshot(surfaceId), [surfaceId]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    const activities: Record<string, SessionActivitySummary> = {};
    let loading = false;
    let hasMore = false;
    let limit = 0;
    for (const workspaceId of workspaceIds) {
      const page = snapshot.sessions[workspaceId];
      if (!page) continue;
      Object.assign(activities, page.activities);
      loading ||= page.status === 'loading' && page.records.length === 0;
      hasMore ||= page.hasMore;
      limit = Math.max(limit, page.limit);
    }
    return { activities, loading, hasMore, limit };
  }, [snapshot, workspaceIds]);
}

const BackgroundSessionRow: React.FC<{
  slot: SidebarDeviceSlot;
  session: Session;
  level: 0 | 1;
  activity?: SessionActivitySummary;
  actions: BackgroundActions;
  flat: boolean;
  /** Owning workspace name, shown in the flat view like the live row. */
  workspaceName?: string;
  titleNumber?: string;
}> = ({ slot, session, level, activity, actions, flat, workspaceName, titleNumber }) => {
  const peer = usePeerDeviceModeOptional();
  const status = useCatalogSessionStatus(slot.surfaceId, session.sessionId, activity);
  const title = getTitle(session);
  const relationship = resolveSessionRelationship(session);
  const isChildSession = level === 1 && relationship.displayAsChild;
  const key = `session:${session.sessionId}`;
  const opening = actions.pendingKey === key;
  const workspaceId = session.workspaceId ?? session.config.workspaceId ?? '';
  const open = () => actions.run(key, () => openDeviceSession(peer, slot, workspaceId, {
    sessionId: session.sessionId,
  } as SessionMetadata, title), 'nav.sessions.openFailed', { sessionId: session.sessionId, title });
  return (
    <div
      role="button"
      tabIndex={0}
      className={[
        'openbitfun-nav-panel__inline-item',
        level === 1 && 'is-child',
        isChildSession && 'is-btw-child',
        flat && workspaceName && !isChildSession && 'has-workspace-name',
        opening && 'is-active',
      ].filter(Boolean).join(' ')}
      data-openbitfun-component="sessions-section"
      data-openbitfun-part="row"
      data-openbitfun-state={opening ? 'active' : undefined}
      data-overflow-trigger
      data-testid="nav-device-session-item"
      data-session-id={session.sessionId}
      data-session-level={String(level)}
      aria-label={title}
      aria-busy={opening || undefined}
      onClick={open}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      <span className="openbitfun-nav-panel__inline-item-main" data-openbitfun-component="sessions-section" data-openbitfun-part="rowMain">
        <span className="openbitfun-nav-panel__inline-item-copy">
          <span className="openbitfun-nav-panel__inline-item-primary">
            <span className="openbitfun-nav-panel__inline-item-title">
              <OverflowText behavior="marquee" title="" className="openbitfun-nav-panel__inline-item-label">{title}</OverflowText>
              <SessionTitleNumber number={titleNumber} />
            </span>
            {session.importedSource ? (
              <StatusPill className="openbitfun-nav-panel__inline-item-source-badge" tone="neutral">
                {sessionSourceAgentLabel(session.importedSource)}
              </StatusPill>
            ) : null}
            {isChildSession ? (
              <StatusPill className="openbitfun-nav-panel__inline-item-btw-badge" tone="neutral">
                {getChildSessionBadge(relationship.kind)}
              </StatusPill>
            ) : null}
            {flat && workspaceName && !isChildSession ? (
              <OverflowText className="openbitfun-nav-panel__inline-item-workspace-name">{workspaceName}</OverflowText>
            ) : null}
          </span>
        </span>
      </span>
      <div className="openbitfun-nav-panel__inline-item-trailing">
        {opening
          ? <span className="session-status-indicator openbitfun-nav-panel__inline-item-status"><Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" /></span>
          : <SessionStatusMark status={status} />}
      </div>
    </div>
  );
};

/**
 * `workspaceIds` holds one project for the grouped view, every project for the
 * flat view (`flat`), mirroring the live `SessionsSection` scopes.
 */
export const BackgroundSessionList: React.FC<{
  slot: SidebarDeviceSlot;
  workspaceIds: readonly string[];
  actions: BackgroundActions;
  flat?: boolean;
  /** Workspace id to name, for the flat view's workspace labels. */
  workspaceNames?: ReadonlyMap<string, string>;
}> = ({ slot, workspaceIds, actions, flat = false, workspaceNames }) => {
  const { t } = useI18n('common');
  const sessions = useSurfaceSessions(slot.surfaceId);
  const titleNumbers = useSessionTitleNumbers(sessions);
  const ordering = useWorkspaceSessionViewStore(state => state.ordering);
  const show = useWorkspaceSessionViewStore(state => state.show);
  const filters = useWorkspaceSessionViewStore(state => state.filters);
  const sourceAgent = useWorkspaceSessionViewStore(state => state.sourceAgent);
  const { activities, loading, hasMore, limit: loadedLimit } = useCatalogActivities(slot.surfaceId, workspaceIds);
  const primaryWorkspaceId = workspaceIds[0] ?? '';
  const { displayCount, setDisplayCount } = useSessionNavExpansion(
    `${surfaceScopedKey(slot.surfaceId, flat ? undefined : primaryWorkspaceId)}:${sourceAgent}`,
    // Unmounted by a collapse: reopening starts at the first rows.
    { shouldHandOff: () => flat || !isWorkspaceSessionsCollapsed(slot.surfaceId, primaryWorkspaceId) },
  );

  const isRunning = useCallback((session: Session) => (
    activities[session.sessionId]?.execution === 'running'
    || sessionNavStatusService.isSurfaceRunning(slot.surfaceId, session.sessionId)
  ), [activities, slot.surfaceId]);

  const { visibleItems, total } = useMemo(() => {
    const { topLevelSessions, childrenByParent } = getWorkspaceSessionHierarchy(
      show === 'archived' ? [...sessions.values()].filter(session => session.persistedStatus === 'archived') : sessions.values(),
      workspaceIds,
    );
    const compare = (left: Session, right: Session) => compareWorkspaceNavSessions(
      left, right, ordering, getTitle, isRunning,
      session => sessionNavStatusService.getSurfaceSortTimestamp(slot.surfaceId, session),
    );
    const matches = (session: Session) => matchesWorkspaceSourceAgent(session, sourceAgent)
      && matchesWorkspaceSessionView(session, show, filters, isRunning(session));
    const parents = [...topLevelSessions].sort(compare).filter(matches);
    const limit = getSessionDisplayLimit({
      loadedTopLevelCount: parents.length,
      displayCount,
      // Each device's flat list shows its first rows plus "show more".
      showAllWithoutLimit: false,
    });
    const items: Array<{ session: Session; level: 0 | 1 }> = [];
    for (const parent of parents.slice(0, limit)) {
      items.push({ session: parent, level: 0 });
      for (const child of [...(childrenByParent.get(parent.sessionId) ?? [])].sort(compare).filter(matches)) {
        items.push({ session: child, level: 1 });
      }
    }
    const reported = workspaceIds.length === 1
      ? knownWorkspaceSessionTotal(slot.surfaceId, primaryWorkspaceId, workspaceSessionViewKey(sourceAgent, show, filters)) : undefined;
    return { visibleItems: items, total: Math.max(parents.length, reported ?? 0), shown: limit };
  }, [displayCount, filters, isRunning, ordering, primaryWorkspaceId, sessions, show, slot.surfaceId, sourceAgent, workspaceIds]);

  const toggle = getSessionExpandToggleState(total, displayCount);
  const handleToggle = () => {
    const next = nextSessionDisplayCount(displayCount, total);
    setDisplayCount(next);
    // Keep one step loaded ahead, like the live list.
    const wanted = next + SESSIONS_PREFETCH_COUNT;
    if (wanted > loadedLimit && hasMore) {
      for (const workspaceId of workspaceIds) void deviceWorkspaceCatalog.loadMoreSessions(slot.surfaceId, workspaceId, wanted);
    }
  };
  const remaining = toggle.action === 'show-more' ? toggle.remainingCount : null;

  return (
    <div className={`openbitfun-nav-panel__inline-list${flat ? ' is-flat-workspace-view' : ''}`} data-testid="nav-device-session-list"
      data-workspace-id={primaryWorkspaceId}>
      {visibleItems.map(({ session, level }) => (
        <BackgroundSessionRow key={session.sessionId} slot={slot} session={session} level={level}
          activity={activities[session.sessionId]} actions={actions} flat={flat}
          titleNumber={titleNumbers.get(session.sessionId)}
          workspaceName={flat ? workspaceNames?.get(workspaceIds.find(id => sessionBelongsToWorkspaceNavRow(session, id)) ?? '') : undefined} />
      ))}
      {visibleItems.length === 0 && (loading ? (
        <div className="openbitfun-nav-panel__inline-loading" role="status" aria-live="polite">
          <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
          <OverflowText>{t('nav.sessions.loading')}</OverflowText>
        </div>
      ) : (
        <div className="openbitfun-nav-panel__inline-empty" aria-disabled="true">{t('nav.sessions.noSessions')}</div>
      ))}
      {toggle.shouldRender && (
        <button data-overflow-trigger type="button" className="openbitfun-nav-panel__inline-toggle"
          data-openbitfun-component="sessions-section" data-openbitfun-part="toggle"
          data-testid="nav-device-session-list-toggle" data-session-nav-toggle-action={toggle.action}
          onClick={handleToggle}>
          <OverflowText className="openbitfun-nav-panel__inline-toggle-label">
            {t(toggle.action === 'show-more' ? 'nav.sessions.showMoreLabel' : 'nav.sessions.showLess')}
          </OverflowText>
          {remaining ? <span className="openbitfun-nav-panel__inline-toggle-count" aria-hidden>+{remaining}</span> : null}
          <span className="openbitfun-nav-panel__inline-toggle-trailing">
            <Icon name={toggle.action === 'show-less' ? 'chevron-up' : 'chevron-down'} size="xs"
              className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
          </span>
        </button>
      )}
    </div>
  );
};
