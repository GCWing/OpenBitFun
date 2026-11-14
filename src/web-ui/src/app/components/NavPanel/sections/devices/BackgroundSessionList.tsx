/**
 * Session rows of a device the window is not rendering (or is still switching
 * to), drawn from that device's own FlowChat container.
 *
 * Everything that decides which rows appear and in what order is the live
 * list's: the same hierarchy, comparator, view filters, first-level limit and
 * "show more" rule. A device therefore looks identical before, during and
 * after a switch, and the hand-over to the live list moves nothing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon, IconButton, Input, OverflowText, StatusPill, Tooltip } from '@openbitfun/ui';
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
import { SessionStatusMark } from '../sessions/SessionStatusIndicator';
import { useCatalogSessionStatus } from './catalogSessionStatus';
import { openDeviceSession } from './openOnDevice';
import { useSurfaceSessions } from './useSurfaceSessions';
import { getChildSessionBadge } from '../sessions/sessionRowBadges';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';
import type { SidebarDeviceSlot } from './useSidebarDevices';
import { CatalogSessionMenu } from './CatalogSessionMenu';
import { catalogSessionActionKey, runCatalogSessionAction } from './catalogSessionActions';

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
    /** Top-level sessions the host listed for these workspaces. */
    const listed: string[] = [];
    for (const workspaceId of workspaceIds) {
      const page = snapshot.sessions[workspaceId];
      // Not read yet: its rows are still coming, unless the device cannot be read.
      if (!page || page.status === 'idle') {
        loading ||= snapshot.status !== 'error';
        continue;
      }
      Object.assign(activities, page.activities);
      loading ||= page.status === 'loading' && page.records.length === 0;
      hasMore ||= page.hasMore;
      limit = Math.max(limit, page.limit);
      for (const session of page.sessions) listed.push(session.sessionId);
    }
    return { activities, loading, hasMore, limit, listed };
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
  /** Owning workspace name for menu copy (archived delete confirmation). */
  ownerWorkspaceName: string;
}> = ({ slot, session, level, activity, actions, flat, workspaceName, ownerWorkspaceName }) => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const status = useCatalogSessionStatus(slot.surfaceId, session.sessionId, activity);
  const title = getTitle(session);
  const relationship = resolveSessionRelationship(session);
  const isChildSession = level === 1 && relationship.displayAsChild;
  const key = `session:${session.sessionId}`;
  const opening = actions.pendingKey === key;
  // A menu action renders the device too; the row shows the same progress.
  const acting = actions.pendingKey?.startsWith(catalogSessionActionKey(session.sessionId, '')) ?? false;
  const workspaceId = session.workspaceId ?? session.config.workspaceId ?? '';
  useEffect(() => {
    if (!editing) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editing]);
  const startRename = () => {
    setEditingTitle(title);
    setEditing(true);
  };
  const cancelRename = () => {
    setEditing(false);
    setEditingTitle('');
  };
  const confirmRename = () => {
    if (!editing) return;
    const trimmed = editingTitle.trim();
    cancelRename();
    if (!trimmed || trimmed === title) return;
    runCatalogSessionAction(actions, peer, slot, session.sessionId, { kind: 'rename', title: trimmed }, t);
  };
  const open = () => editing ? undefined : actions.run(key, () => openDeviceSession(peer, slot, workspaceId, {
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
        (opening || acting) && 'is-active',
        editing && 'is-editing',
        menuOpen && 'is-menu-open',
      ].filter(Boolean).join(' ')}
      data-openbitfun-component="sessions-section"
      data-openbitfun-part="row"
      data-openbitfun-state={[
        (opening || acting) && 'active',
        editing && 'editing',
        menuOpen && 'menuOpen',
      ].filter(Boolean).join(' ') || undefined}
      data-overflow-trigger
      data-testid="nav-device-session-item"
      data-session-id={session.sessionId}
      data-session-level={String(level)}
      aria-label={title}
      aria-busy={opening || acting || undefined}
      onClick={open}
      onKeyDown={event => {
        // Keys typed in the row's own controls (menu button, rename field) stay theirs.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      {editing ? (
        <div className="openbitfun-nav-panel__inline-item-edit" data-openbitfun-component="sessions-section" data-openbitfun-part="edit"
          onClick={event => event.stopPropagation()}>
          <Input
            ref={editInputRef}
            className="openbitfun-nav-panel__inline-item-edit-field"
            value={editingTitle}
            onChange={event => setEditingTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); confirmRename(); }
              else if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
            }}
            onBlur={confirmRename}
            size="sm"
            data-testid="nav-device-session-rename-input"
          />
          <Tooltip content={t('nav.sessions.confirmEdit')} placement="top">
            <IconButton
              aria-label={t('nav.sessions.confirmEdit')}
              variant="quiet"
              size="sm"
              className="openbitfun-nav-panel__inline-item-edit-btn confirm"
              onClick={event => { event.stopPropagation(); confirmRename(); }}
              icon={<Icon name="check-line" size="2xs" />}
            />
          </Tooltip>
          <Tooltip content={t('nav.sessions.cancelEdit')} placement="top">
            <IconButton
              aria-label={t('nav.sessions.cancelEdit')}
              size="sm"
              className="openbitfun-nav-panel__inline-item-edit-btn cancel"
              onMouseDown={event => { event.preventDefault(); event.stopPropagation(); cancelRename(); }}
              icon={<Icon name="xmark" size="2xs" />}
            />
          </Tooltip>
        </div>
      ) : <>
      <span className="openbitfun-nav-panel__inline-item-main" data-openbitfun-component="sessions-section" data-openbitfun-part="rowMain">
        <span className="openbitfun-nav-panel__inline-item-copy">
          <span className="openbitfun-nav-panel__inline-item-primary">
            <span className="openbitfun-nav-panel__inline-item-title">
              <OverflowText behavior="marquee" title="" className="openbitfun-nav-panel__inline-item-label">{title}</OverflowText>
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
        {opening || acting
          ? <span className="session-status-indicator openbitfun-nav-panel__inline-item-status"><Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" /></span>
          : <SessionStatusMark status={status} />}
        <CatalogSessionMenu slot={slot} session={session} title={title}
          workspaceName={ownerWorkspaceName}
          running={status.kind === 'running' || sessionNavStatusService.isSurfaceRunning(slot.surfaceId, session.sessionId)}
          actions={actions} open={menuOpen} onOpenChange={setMenuOpen} onRename={startRename} />
      </div>
      </>}
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
  /** Workspace id to name: the flat view's workspace labels and menu copy. */
  workspaceNames?: ReadonlyMap<string, string>;
}> = ({ slot, workspaceIds, actions, flat = false, workspaceNames }) => {
  const { t } = useI18n('common');
  const sessions = useSurfaceSessions(slot.surfaceId);
  const ordering = useWorkspaceSessionViewStore(state => state.ordering);
  const show = useWorkspaceSessionViewStore(state => state.show);
  const filters = useWorkspaceSessionViewStore(state => state.filters);
  const sourceAgent = useWorkspaceSessionViewStore(state => state.sourceAgent);
  const { activities, loading, hasMore, limit: loadedLimit, listed } = useCatalogActivities(slot.surfaceId, workspaceIds);
  const primaryWorkspaceId = workspaceIds[0] ?? '';
  const { displayCount, setDisplayCount } = useSessionNavExpansion(
    `${surfaceScopedKey(slot.surfaceId, flat ? undefined : primaryWorkspaceId)}:${sourceAgent}`,
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

  // "No sessions" only once the host said so. Rows the catalog lists that the
  // container does not hold yet are on their way (seeding follows the catalog),
  // and a page not read yet is loading, not empty: either way the list shows
  // progress rather than an empty state under a known total.
  const awaitingRows = loading || listed.some(sessionId => !sessions.has(sessionId));
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
      {visibleItems.map(({ session, level }) => {
        const ownerId = workspaceIds.find(id => sessionBelongsToWorkspaceNavRow(session, id)) ?? '';
        const ownerName = workspaceNames?.get(ownerId);
        return (
          <BackgroundSessionRow key={session.sessionId} slot={slot} session={session} level={level}
            activity={activities[session.sessionId]} actions={actions} flat={flat}
            workspaceName={flat ? ownerName : undefined}
            ownerWorkspaceName={ownerName || ownerId} />
        );
      })}
      {visibleItems.length === 0 && (awaitingRows ? (
        <div className="openbitfun-nav-panel__inline-loading" role="status" aria-live="polite">
          <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
          <OverflowText>{t('nav.sessions.loading')}</OverflowText>
        </div>
      ) : (
        <div className="openbitfun-nav-panel__inline-empty" aria-disabled="true">{t('nav.sessions.noSessions')}</div>
      ))}
      {/* Like the live list, "show more" belongs under rows, never under an empty or loading list. */}
      {toggle.shouldRender && visibleItems.length > 0 && (
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
