/**
 * Workspaces and sessions of a device this window is not rendering.
 *
 * Rows mirror the live workspace list (same classes, ordering and grouping).
 * The data comes from the read-only device catalog; acting on a row renders
 * that device first and then runs the local handler (see `openOnDevice`).
 */

import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { ActionItem, Button, Icon, OverflowText, Tooltip } from '@openbitfun/ui';
import { History, Loader2, MessageCirclePlus, Settings2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { peerReplyLostMessage } from '@/infrastructure/peer-device/peerReplyLost';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { deviceWorkspaceCatalog, type DeviceCatalogSnapshot } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { useDeviceWorkspaceCatalog } from '@/infrastructure/peer-device/useDeviceWorkspaceCatalog';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import {
  getWorkspaceDisplayOrderRevision,
  orderWorkspacesForDisplay,
  subscribeWorkspaceDisplayOrder,
} from '@/infrastructure/services/business/workspaceDisplayOrder';
import { WorkspaceIconArt } from '@/app/components/WorkspaceIcon/WorkspaceIcon';
import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import { notificationService } from '@/shared/notification-system';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { resolveAssistantName } from '@/shared/utils/assistantName';
import { projectWorkspaceBackedSessionGroups } from '../../sessionNavigationProjection';
import { remoteWorkspaceBadge } from '../workspaces/remoteWorkspaceBadge';
import { createDeviceSession, openDeviceAssistant, openDeviceProjectResources, openDeviceWorkspaceAction } from './openOnDevice';
import { beginDeviceOpen, endDeviceOpen, useDeviceOpenIntent } from '@/infrastructure/peer-device/deviceOpenIntent';
import type { SidebarDeviceSlot } from './useSidebarDevices';
import { BackgroundSessionList, type BackgroundActions } from './BackgroundSessionList';
import { setWorkspaceSessionsCollapsed, useWorkspaceSessionsCollapsed } from '../workspaces/workspaceDisclosure';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';

type CatalogActions = BackgroundActions;

/**
 * Opening an entry renders another device first, which takes a moment. The
 * intent is global so the clicked row stays highlighted with progress for the
 * whole open, other owners (catalog refresh, scene reset, list hand-over) can
 * wait for it, and a second click is ignored.
 */
function useCatalogActions(surfaceId: string): CatalogActions {
  const { t } = useI18n('common');
  const intent = useDeviceOpenIntent(state => state.intent);
  const run = useCallback<CatalogActions['run']>((key, action, failureKey, extra) => {
    if (useDeviceOpenIntent.getState().intent) return;
    const next = beginDeviceOpen({ surfaceId, key, ...extra });
    void action().catch(error => {
      if (isSurfaceChangedError(error)) return;
      notificationService.error(peerReplyLostMessage(error, t)
        ?? (error instanceof Error && error.message ? error.message : t(failureKey)), { duration: 4000 });
    }).finally(() => endDeviceOpen(next));
  }, [surfaceId, t]);
  return { pendingKey: intent?.surfaceId === surfaceId ? intent.key : null, run };
}

const CatalogAssistantRow: React.FC<{ slot: SidebarDeviceSlot; workspace: WorkspaceInfo; actions: CatalogActions }> = ({
  slot, workspace, actions,
}) => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const name = resolveAssistantName(workspace);
  const key = `assistant:${workspace.id}`;
  const open = () => actions.run(key, () => openDeviceAssistant(peer, slot, workspace.id, () => {
    notificationService.info(t('nav.sessions.defaultUnavailable'));
  }), 'nav.sessions.openFailed');
  return (
    <div className={`openbitfun-nav-panel__assistant-item is-single${actions.pendingKey === key ? ' is-active' : ''}`} data-openbitfun-product-component="workspace-item"
      data-openbitfun-product-part="root" data-openbitfun-variant="assistant" data-testid="nav-device-workspace-item"
      data-workspace-id={workspace.id} data-workspace-kind={workspace.workspaceKind}>
      <div className="openbitfun-nav-panel__assistant-item-card" data-openbitfun-product-component="workspace-item"
        data-openbitfun-product-part="card" onClick={open} style={{ cursor: 'pointer' }} aria-busy={actions.pendingKey === key || undefined}>
        <button type="button" className="openbitfun-nav-panel__assistant-item-open-btn" aria-label={t('nav.sessions.openAssistant')}
          data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
          onClick={event => { event.stopPropagation(); open(); }}>
          <span className="openbitfun-nav-panel__assistant-item-avatar" aria-hidden="true">
            <AssistantAvatar size={22} name={name} />
          </span>
        </button>
        <Tooltip content={t('nav.sessions.openAssistant')} placement="right" followCursor>
          <ActionItem data-overflow-trigger type="button" className="openbitfun-nav-panel__assistant-item-name-action"
            triggerClassName="openbitfun-nav-panel__assistant-item-name-btn" labelBehavior="static"
            data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="name"
            onClick={event => { event.stopPropagation(); open(); }}>
            <OverflowText className="openbitfun-nav-panel__assistant-item-label">{name}</OverflowText>
          </ActionItem>
        </Tooltip>
        <div className="openbitfun-nav-panel__assistant-item-menu" onClick={event => event.stopPropagation()}>
          <button type="button" className="openbitfun-nav-panel__assistant-item-menu-trigger"
            data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
            aria-label={t('actions.more')} aria-haspopup="menu" data-testid="nav-device-workspace-menu-btn"
            onClick={() => actions.run(`menu:${workspace.id}`, () => openDeviceWorkspaceAction(peer, slot, workspace.id, 'menu'), 'nav.sessions.openFailed')}>
            {actions.pendingKey === `menu:${workspace.id}`
              ? <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
              : <Icon name="more" size="xs" />}
          </button>
          <Tooltip content={t('nav.sessions.history')} placement="right" followCursor>
            <button type="button" className="openbitfun-nav-panel__assistant-item-menu-trigger"
              data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
              aria-label={t('nav.sessions.history')} data-testid="nav-device-assistant-history-btn"
              onClick={() => actions.run(`history:${workspace.id}`, () => openDeviceWorkspaceAction(peer, slot, workspace.id, 'assistant-history'), 'nav.sessions.openFailed')}>
              {actions.pendingKey === `history:${workspace.id}`
                ? <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
                : <Icon glyph={History} size="xs" />}
            </button>
          </Tooltip>
          <Tooltip content={t('nav.workspaces.actions.newSession')} placement="right" followCursor>
            <button type="button" className="openbitfun-nav-panel__assistant-item-menu-trigger"
              data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
              aria-label={t('nav.workspaces.actions.newSession')} data-testid="nav-device-new-session-btn"
              onClick={() => actions.run(`new:${workspace.id}`, () => createDeviceSession(peer, slot, workspace.id), 'nav.workspaces.createSessionFailed')}>
              <Icon glyph={MessageCirclePlus} size="xs" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

const CatalogProjectRow: React.FC<{ slot: SidebarDeviceSlot; workspace: WorkspaceInfo; actions: CatalogActions; single: boolean }> = ({
  slot, workspace, actions, single,
}) => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  // The live row reads the same window-wide disclosure, so a switch keeps it.
  const expanded = !useWorkspaceSessionsCollapsed(slot.surfaceId, workspace.id);
  const remote = workspace.workspaceKind === WorkspaceKind.Remote;
  const badge = remote ? remoteWorkspaceBadge(workspace) : undefined;
  const toggle = () => setWorkspaceSessionsCollapsed(slot.surfaceId, workspace.id, expanded);
  const workspaceIds = useMemo(() => [workspace.id], [workspace.id]);
  const workspaceNames = useMemo(() => new Map([[workspace.id, workspace.name]]), [workspace.id, workspace.name]);
  return (
    <div className={['openbitfun-nav-panel__workspace-item', single && 'is-single', !expanded && 'is-sessions-collapsed'].filter(Boolean).join(' ')}
      data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="root" data-openbitfun-variant="workspace"
      data-openbitfun-state={[!expanded && 'collapsed', remote && 'remote'].filter(Boolean).join(' ') || undefined}
      data-testid="nav-device-workspace-item" data-workspace-id={workspace.id} data-workspace-kind={workspace.workspaceKind}>
      <div className="openbitfun-nav-panel__workspace-item-card" data-openbitfun-product-component="workspace-item"
        data-openbitfun-product-part="card" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button type="button" className="openbitfun-nav-panel__workspace-item-collapse-btn"
          data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="collapse"
          onClick={event => { event.stopPropagation(); toggle(); }}
          aria-label={expanded ? t('nav.workspaces.collapseSessions') : t('nav.workspaces.expandSessions')}
          aria-expanded={expanded} data-testid="nav-device-workspace-toggle">
          <span className="openbitfun-nav-panel__workspace-item-icon" aria-hidden="true">
            <WorkspaceIconArt remote={remote} expanded={expanded} />
          </span>
        </button>
        <div className="openbitfun-nav-panel__workspace-item-name-cluster">
          <div className="openbitfun-nav-panel__workspace-item-name-stack">
            <div className="openbitfun-nav-panel__workspace-item-name-row">
              <Tooltip content={workspace.rootPath} placement="right" followCursor>
                <ActionItem data-overflow-trigger type="button" className="openbitfun-nav-panel__workspace-item-name-action"
                  triggerClassName="openbitfun-nav-panel__workspace-item-name-btn" labelBehavior="static"
                  data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="name"
                  onClick={event => { event.stopPropagation(); toggle(); }}>
                  <span className="openbitfun-nav-panel__workspace-item-name-line">
                    <OverflowText behavior="marquee" className="openbitfun-nav-panel__workspace-item-label" title="">{workspace.name}</OverflowText>
                  </span>
                </ActionItem>
              </Tooltip>
              {badge && (
                <span className="openbitfun-nav-panel__workspace-item-remote is-unknown" data-openbitfun-product-component="workspace-item"
                  data-openbitfun-product-part="remoteStatus">
                  <span className="openbitfun-nav-panel__workspace-item-remote-host">{badge.label}</span>
                </span>
              )}
            </div>
          </div>
        </div>
        {/* Inside the card, like the live row, so the actions centre on it. */}
        <div className="openbitfun-nav-panel__workspace-item-actions" onClick={event => event.stopPropagation()}>
        <div className="openbitfun-nav-panel__workspace-item-menu" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="menu">
          <button type="button" className="openbitfun-nav-panel__workspace-item-menu-trigger"
            data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="menuTrigger"
            aria-label={t('actions.more')} aria-haspopup="menu" aria-busy={actions.pendingKey === `menu:${workspace.id}` || undefined}
            data-testid="nav-device-workspace-menu-btn"
            onClick={() => actions.run(`menu:${workspace.id}`, () => openDeviceWorkspaceAction(peer, slot, workspace.id, 'menu'), 'nav.sessions.openFailed')}>
            {actions.pendingKey === `menu:${workspace.id}`
              ? <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
              : <Icon name="more" size="xs" />}
          </button>
          <Tooltip content={t('nav.workspaces.actions.projectResources')} placement="right" followCursor>
            <button type="button" className="openbitfun-nav-panel__workspace-item-menu-trigger"
              data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
              aria-label={t('nav.workspaces.actions.projectResources')} data-testid="nav-device-project-resources-btn"
              onClick={() => actions.run(`resources:${workspace.id}`, () => openDeviceProjectResources(peer, slot, workspace.id), 'nav.sessions.openFailed')}>
              {actions.pendingKey === `resources:${workspace.id}`
                ? <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
                : <Icon glyph={Settings2} size="xs" />}
            </button>
          </Tooltip>
          <Tooltip content={t('nav.sessions.newSession')} placement="right" followCursor>
            <button type="button" className="openbitfun-nav-panel__workspace-item-menu-trigger"
              data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="action"
              aria-label={t('nav.sessions.newSession')} data-testid="nav-device-new-session-btn"
              onClick={() => actions.run(`new:${workspace.id}`, () => createDeviceSession(peer, slot, workspace.id), 'nav.workspaces.createSessionFailed')}>
              {actions.pendingKey === `new:${workspace.id}`
                ? <Icon glyph={Loader2} size="xs" className="openbitfun-nav-panel__device-spinner" aria-hidden="true" />
                : <Icon glyph={MessageCirclePlus} size="xs" />}
            </button>
          </Tooltip>
        </div>
        </div>
      </div>
      {expanded && (
        <div className="openbitfun-nav-panel__workspace-item-sessions openbitfun-nav-panel__workspace-item-sessions--project"
          data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="sessions">
          <div className="openbitfun-nav-panel__workspace-item-sessions-inner">
            <BackgroundSessionList slot={slot} workspaceIds={workspaceIds} actions={actions} workspaceNames={workspaceNames} />
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Attach the control link while the pointer is over a device's list, so a
 * click only has to render it. Attaching neither renders nor mutates the host,
 * and the link is kept for later switches anyway.
 */
const PREWARM_HOVER_MS = 200;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;

function prewarmDeviceLink(slot: SidebarDeviceSlot): void {
  if (slot.isLocal || !slot.deviceId || !slot.controllable || peerConnectionManager.has(slot.deviceId)) return;
  cancelPrewarm();
  const deviceId = slot.deviceId;
  // Only a pointer that rests on the list attaches; passing over it does not.
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    if (!peerConnectionManager.has(deviceId)) void peerConnectionManager.connect(deviceId, slot.name).catch(() => undefined);
  }, PREWARM_HOVER_MS);
}

function cancelPrewarm(): void {
  if (prewarmTimer !== null) clearTimeout(prewarmTimer);
  prewarmTimer = null;
}

/**
 * Workspaces of a background device, in the device's display order: the
 * device catalog once it has answered (an empty or failed read is shown as
 * such), and until then the list this window last loaded for it, so the first
 * read draws no loading row where the list already stood.
 *
 * Both lists are drawn in the order the device is shown now, not the order
 * they were read in: the catalog of a device is not re-read while the window
 * renders it, so its last read can predate an order the live list settled on,
 * and the hand-over between the two projections must move no row.
 */
function useBackgroundWorkspaces(slot: SidebarDeviceSlot, catalog: DeviceCatalogSnapshot): readonly WorkspaceInfo[] {
  const answered = catalog.status === 'ready' || catalog.status === 'error';
  const orderRevision = useSyncExternalStore(subscribeWorkspaceDisplayOrder, getWorkspaceDisplayOrderRevision);
  return useMemo(
    () => {
      void orderRevision;
      return answered
        ? orderWorkspacesForDisplay(slot.surfaceId, catalog.workspaces)
        : workspaceManager.getSurfaceOpenedWorkspaces(slot.surfaceId);
    },
    [answered, catalog.workspaces, orderRevision, slot.surfaceId],
  );
}

/** Body of a background (or still-switching) device section. Mirrors `WorkspaceListSection`'s structure. */
const DeviceCatalogSection: React.FC<{ slot: SidebarDeviceSlot }> = ({ slot }) => {
  const { t } = useI18n('common');
  const catalog = useDeviceWorkspaceCatalog(slot.surfaceId, slot.controllable);
  const workspaces = useBackgroundWorkspaces(slot, catalog);
  const actions = useCatalogActions(slot.surfaceId);
  const grouping = useWorkspaceSessionViewStore(state => state.grouping);
  const groups = useMemo(() => projectWorkspaceBackedSessionGroups(workspaces, 'all'), [workspaces]);
  const assistants = groups.filter(group => group.kind === 'assistant');
  const projects = groups.filter(group => group.kind === 'project');
  const projectIds = useMemo(() => projects.map(group => group.workspace.id), [projects]);
  const projectNames = useMemo(() => new Map(projects.map(group => [group.workspace.id, group.workspace.name])), [projects]);

  if (!slot.controllable) {
    return <div className="openbitfun-nav-panel__device-note" role="note" data-testid="nav-device-incompatible">
      {t('deviceOverview.deviceClientIncompatible')}
    </div>;
  }
  return (
    <div className="openbitfun-nav-panel__workspace-list" data-testid="nav-device-workspace-list" data-device-surface={slot.surfaceId}
      onPointerEnter={() => prewarmDeviceLink(slot)}
      onPointerLeave={cancelPrewarm}
      aria-busy={catalog.status === 'loading' || undefined}>
      {catalog.status === 'loading' && workspaces.length === 0 && (
        <div className="openbitfun-nav-panel__inline-loading" role="status" aria-live="polite">
          <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
          <OverflowText>{t('nav.sessions.loading')}</OverflowText>
        </div>
      )}
      {catalog.status === 'ready' && workspaces.length === 0 && (
        <div className="openbitfun-nav-panel__workspace-list-empty">{t('nav.workspaces.emptySessionGroups')}</div>
      )}
      {catalog.error && workspaces.length === 0 && (
        <Button variant="outline" size="sm" className="openbitfun-nav-panel__inline-action" data-testid="nav-device-retry"
          onClick={() => { void deviceWorkspaceCatalog.retry(slot.surfaceId); }}>
          {t('nav.devices.loadFailed')} · {t('actions.retry')}
        </Button>
      )}
      {assistants.map(group => (
        <div key={group.workspace.id} className="openbitfun-nav-panel__workspace-drop-target">
          <CatalogAssistantRow slot={slot} workspace={group.workspace} actions={actions} />
        </div>
      ))}
      {projects.length > 0 && (
        <div className="openbitfun-nav-panel__session-view-transition">
          <div className="openbitfun-nav-panel__session-view-content">
            {grouping === 'all' ? (
              <div className="openbitfun-nav-panel__workspace-all-sessions">
                <BackgroundSessionList slot={slot} workspaceIds={projectIds} actions={actions} flat workspaceNames={projectNames} />
              </div>
            ) : projects.map(group => (
              <div key={group.workspace.id} className="openbitfun-nav-panel__workspace-drop-target">
                <CatalogProjectRow slot={slot} workspace={group.workspace} actions={actions} single={projects.length <= 1} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default DeviceCatalogSection;
