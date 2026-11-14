/**
 * The "more" menu of a session row of a device the window is not rendering.
 *
 * Same trigger, popover and items as the live row's menu (`SessionsSection`).
 * Every item renders the owning device first and then runs the live handler
 * on the rendered surface (`runDeviceSessionAction`). Items whose live owner is
 * the rendered row itself (scheduled jobs) are left to the live menu.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createOverlayPortal, Icon, Menu, MenuItem, MenuSeparator, subscribeOverlayInteraction } from '@openbitfun/ui';
import { Archive, FolderGit2, FolderOpen, Loader2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { beginDeviceOpen, endDeviceOpen, useDeviceOpenIntent } from '@/infrastructure/peer-device/deviceOpenIntent';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime/environment';
import { isNonLocalDispatchTarget } from '@/features/dispatch/types';
import type { Session } from '@/flow_chat/types/flow-chat';
import { isSessionEmptyForCopy } from '@/flow_chat/utils/sessionCopy';
import { isWorktreeIsolatedSession } from '@/flow_chat/utils/sessionOrdering';
import { sessionWorktreeRootPath } from '@/flow_chat/utils/sessionWorktree';
import { useSideAnchoredPopoverPosition } from '@/shared/utils/useSideAnchoredPopoverPosition';
import ArchivedSessionMenuItems from '../sessions/ArchivedSessionMenuItems';
import SessionDeleteMenuItem from '../sessions/SessionDeleteMenuItem';
import { activateDeviceSlot, runDeviceSessionAction, type DeviceSessionAction } from './openOnDevice';
import type { BackgroundActions } from './BackgroundSessionList';
import type { SidebarDeviceSlot } from './useSidebarDevices';

/** Intent key of a catalog session action; the row shows progress while it runs. */
export const catalogSessionActionKey = (sessionId: string, kind: string) => `session-action:${sessionId}:${kind}`;

const FAILURE_KEYS: Partial<Record<DeviceSessionAction['kind'], string>> = {
  duplicate: 'nav.sessions.duplicateFailed',
  'open-worktree': 'nav.sessions.openWorktreeWorkspaceFailed',
  'reveal-storage': 'nav.sessions.openStorageDirectoryFailed',
};

export function runCatalogSessionAction(
  actions: BackgroundActions,
  peer: ReturnType<typeof usePeerDeviceModeOptional>,
  slot: SidebarDeviceSlot,
  sessionId: string,
  action: DeviceSessionAction,
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  actions.run(
    catalogSessionActionKey(sessionId, action.kind),
    () => runDeviceSessionAction(peer, slot, sessionId, action, t),
    FAILURE_KEYS[action.kind] ?? 'nav.devices.sessionActionFailed',
  );
}

export const CatalogSessionMenu: React.FC<{
  slot: SidebarDeviceSlot;
  session: Session;
  title: string;
  workspaceName: string;
  /** The host reports a running turn: not a stable copy boundary. */
  running: boolean;
  actions: BackgroundActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
}> = ({ slot, session, title, workspaceName, running, actions, open, onOpenChange, onRename }) => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [exportScopeMenu, setExportScopeMenu] = useState(false);
  const position = useSideAnchoredPopoverPosition({
    open,
    anchorRef,
    popoverRef,
    gap: 4,
    layoutRevision: `${open}:${exportScopeMenu}`,
  });

  const close = () => {
    setExportScopeMenu(false);
    onOpenChange(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) close();
    };
    const remove = subscribeOverlayInteraction(popoverRef, 'mousedown', handleOutside);
    return () => remove?.();
    // `close` only reads stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = (event: React.MouseEvent, action: DeviceSessionAction) => {
    event.stopPropagation();
    close();
    runCatalogSessionAction(actions, peer, slot, session.sessionId, action, t);
  };

  const isArchived = session.persistedStatus === 'archived';
  const isDispatched = isNonLocalDispatchTarget(session.config.dispatchTarget);
  const sessionMutationDisabledReason = isDispatched ? t('nav.sessions.dispatchMutationUnsupported') : undefined;
  const capabilities = slot.isLocal
    ? null
    : peer?.attachments.find(attachment => attachment.deviceId === slot.deviceId)?.capabilities ?? null;
  // An unanswered host is re-checked after its device is rendered.
  const copyUnsupported = !slot.isLocal && capabilities !== null && capabilities.wholeSessionCopyV1 !== true;
  const copyEmpty = isSessionEmptyForCopy(session);
  const worktreeRootPath = isWorktreeIsolatedSession(session) ? sessionWorktreeRootPath(session) ?? '' : '';
  // Storage directories open only for data stored on this desktop instance.
  const storageUnavailable = !slot.isLocal || !isTauriRuntime() || isDispatched;
  const busy = actions.pendingKey !== null;

  // Archived rows reuse the live archived menu; it renders the device itself.
  const activateForArchived = async (): Promise<boolean> => {
    if (useDeviceOpenIntent.getState().intent) return false;
    const intent = beginDeviceOpen({ surfaceId: slot.surfaceId, key: catalogSessionActionKey(session.sessionId, 'archived') });
    try {
      return await activateDeviceSlot(peer, slot) === 'activated';
    } finally {
      endDeviceOpen(intent);
    }
  };

  return (
    <>
      <div
        className={`openbitfun-nav-panel__inline-item-actions${open ? ' is-open' : ''}`}
        data-openbitfun-component="sessions-section"
        data-openbitfun-part="actions"
        data-openbitfun-state={open ? 'menuOpen' : undefined}
      >
        <button
          type="button"
          ref={anchorRef}
          className={`openbitfun-nav-panel__inline-item-action-btn${open ? ' is-open' : ''}`}
          onClick={event => {
            event.stopPropagation();
            if (open) close();
            else onOpenChange(true);
          }}
          onKeyDown={event => event.stopPropagation()}
          aria-label={`${title} · ${t('actions.more')}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          data-testid="nav-device-session-menu-btn"
          data-session-id={session.sessionId}
        >
          <Icon name="more" size="xs" />
        </button>
      </div>
      {open && createOverlayPortal(
        <Menu
          ref={popoverRef}
          className="openbitfun-nav-panel__inline-item-menu-popover"
          inlineSize="content"
          data-openbitfun-component="sessions-section"
          data-openbitfun-part="menu"
          data-openbitfun-state="menuOpen"
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? 'visible' : 'hidden',
          }}
          data-testid="nav-device-session-menu"
          data-session-id={session.sessionId}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
        >
          {isArchived ? (
            <ArchivedSessionMenuItems
              session={session}
              title={title}
              workspaceName={workspaceName}
              activate={activateForArchived}
              onClose={close}
              onChanged={() => undefined}
            />
          ) : exportScopeMenu ? (
            <>
              <MenuItem
                type="button"
                leading={<Icon name="chevron-left" size="sm" />}
                onClick={event => { event.stopPropagation(); setExportScopeMenu(false); }}
                data-testid="nav-device-session-menu-export-back"
              >
                <span>{t('nav.sessions.exportMarkdown')}</span>
              </MenuItem>
              <MenuItem
                type="button"
                leading={<Icon name="arrow-down" size="sm" />}
                onClick={event => run(event, { kind: 'export', scope: 'full', title })}
                data-testid="nav-device-session-menu-export-full"
              >
                <span>{t('nav.sessions.exportMarkdownFull')}</span>
              </MenuItem>
              <MenuItem
                type="button"
                leading={<Icon name="arrow-down" size="sm" />}
                onClick={event => run(event, { kind: 'export', scope: 'result', title })}
                data-testid="nav-device-session-menu-export-result"
              >
                <span>{t('nav.sessions.exportMarkdownResult')}</span>
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                type="button"
                leading={<Icon name="edit" size="sm" />}
                onClick={event => { event.stopPropagation(); close(); onRename(); }}
                data-testid="nav-device-session-menu-rename"
              >
                <span>{t('nav.sessions.rename')}</span>
              </MenuItem>
              <MenuItem
                type="button"
                leading={actions.pendingKey === catalogSessionActionKey(session.sessionId, 'duplicate')
                  ? <Loader2 className="openbitfun-nav-panel__inline-toggle-spinner" aria-hidden />
                  : <Icon name="git" size="sm" />}
                onClick={event => run(event, { kind: 'duplicate' })}
                disabled={isDispatched || copyUnsupported || copyEmpty || running}
                title={isDispatched
                  ? t('nav.sessions.duplicateDispatchUnsupported')
                  : copyUnsupported
                    ? t('nav.sessions.duplicateHostUnsupported')
                    : copyEmpty
                      ? t('nav.sessions.duplicateEmpty')
                      : running
                        ? t('nav.sessions.duplicateRunning')
                        : undefined}
                data-testid="nav-device-session-menu-duplicate"
              >
                <span>{t('nav.sessions.duplicate')}</span>
              </MenuItem>
              <MenuItem
                type="button"
                leading={<Icon name="arrow-down" size="sm" />}
                onClick={event => { event.stopPropagation(); setExportScopeMenu(true); }}
                data-testid="nav-device-session-menu-export-markdown"
              >
                <span>{t('nav.sessions.exportMarkdown')}</span>
              </MenuItem>
              {worktreeRootPath ? (
                <MenuItem
                  type="button"
                  leading={<Icon glyph={FolderGit2} size="sm" />}
                  onClick={event => run(event, { kind: 'open-worktree', worktreePath: worktreeRootPath })}
                  data-testid="nav-device-session-menu-open-worktree-workspace"
                >
                  <span>{t('nav.sessions.openWorktreeWorkspace')}</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                type="button"
                leading={<Icon glyph={FolderOpen} size="sm" />}
                onClick={event => run(event, { kind: 'reveal-storage' })}
                disabled={storageUnavailable}
                title={storageUnavailable ? t('nav.sessions.storageDirectoryDesktopOnly') : undefined}
                data-testid="nav-device-session-menu-open-storage"
              >
                <span>{t('nav.sessions.openStorageDirectory')}</span>
              </MenuItem>
              <MenuItem
                type="button"
                leading={<Icon glyph={Archive} size="sm" />}
                onClick={event => run(event, { kind: 'archive' })}
                disabled={Boolean(sessionMutationDisabledReason)}
                title={sessionMutationDisabledReason}
                data-testid="nav-device-session-menu-archive"
              >
                <span>{t('nav.sessions.archive')}</span>
              </MenuItem>
              <SessionDeleteMenuItem
                key={slot.surfaceId}
                sessionId={session.sessionId}
                testId="nav-device-session-menu-delete"
                label={t(session.externalHistory?.mode === 'follow' ? 'nav.sessions.removeSource' : 'nav.sessions.delete')}
                disabled={Boolean(sessionMutationDisabledReason)}
                description={sessionMutationDisabledReason ?? t(session.externalHistory?.mode === 'follow' ? 'nav.sessions.removeSourceConfirmMessage' : 'nav.sessions.deleteConfirmMessage', { name: title })}
                onConfirm={() => {
                  close();
                  runCatalogSessionAction(actions, peer, slot, session.sessionId, { kind: 'delete' }, t);
                }}
              />
            </>
          )}
        </Menu>,
        getAppearanceOverlayHost(),
      )}
    </>
  );
};
