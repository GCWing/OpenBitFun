/**
 * ArchivedSessionsConfig — settings page for managing archived sessions.
 *
 * Lists all archived sessions grouped by workspace, with per-session
 * restore / delete actions and a bulk "Delete All Archived" action.
 * Destructive operations are confirmed; restoring is reversible and runs
 * directly with explicit success or failure feedback.
 */

import { OverflowText, Button, Empty, Icon } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ConfigPageLayout,
  ConfigPageHeader,
  ConfigPageContent,
  ConfigMessage,
  ConfigRefreshButton,
  ConfigPageSection,
} from '@/infrastructure/config/components/common';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import type { SessionMetadata } from '@/shared/types/session-history';
import { i18nService } from '@/infrastructure/i18n';
import './ArchivedSessionsConfig.scss';

const log = createLogger('ArchivedSessionsConfig');

// ── Types ──────────────────────────────────────────────────────────────────

interface ArchivedEntry {
  workspaceId: string;
  session: SessionMetadata;
  workspacePath: string;
  workspaceName: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

interface WorkspaceLoadFailure {
  workspaceKey: string;
  workspacePath: string;
  workspaceName: string;
}

type PendingAction = {
  entryKey: string;
  type: 'restore' | 'delete';
};

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(timestampMs: number): string {
  if (!timestampMs) return '';
  try {
    const d = new Date(timestampMs);
    return i18nService.formatDate(d, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

interface ArchivedRowProps {
  entry: ArchivedEntry;
  onRestore: (entry: ArchivedEntry) => void;
  onDelete: (entry: ArchivedEntry) => void;
  pendingAction: PendingAction | null;
  disabled: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function workspaceIdentityKey(workspaceId: string): string { return workspaceId; }

function workspaceScopeLabel(
  workspaceName: string,
  remoteConnectionId?: string,
  remoteSshHost?: string,
): string {
  const hostLabel = remoteSshHost || remoteConnectionId;
  return hostLabel && hostLabel !== workspaceName
    ? `${workspaceName} · ${hostLabel}`
    : workspaceName;
}

function archivedEntryIdentityKey(entry: ArchivedEntry): string {
  return JSON.stringify([
    workspaceIdentityKey(entry.workspaceId),
    entry.session.sessionId,
  ]);
}

const ArchivedRow: React.FC<ArchivedRowProps> = ({
  entry,
  onRestore,
  onDelete,
  pendingAction,
  disabled,
  t,
}) => {
  const { session } = entry;
  const displayName = session.sessionName || t('nav.sessions.untitled');
  const dateStr = formatDateTime(session.lastActiveAt);

  return (
    <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="row" className="archived-sessions-config__row">
      <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="rowInfo" className="archived-sessions-config__row-info">
        <OverflowText className="archived-sessions-config__row-name">{displayName}</OverflowText>
        {dateStr && (
          <span className="archived-sessions-config__row-date">{dateStr}</span>
        )}
      </div>
      <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="rowActions" className="archived-sessions-config__row-actions">
        <Button
          size="sm"
          variant="outline"
          leadingIcon={<RotateCcw size={13} />}
          onClick={() => onRestore(entry)}
          disabled={disabled}
          loading={pendingAction?.entryKey === archivedEntryIdentityKey(entry)
            && pendingAction.type === 'restore'}
          aria-label={t('nav.sessions.restore')}
        >
          {t('nav.sessions.restore')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          leadingIcon={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
          onClick={() => onDelete(entry)}
          disabled={disabled}
          loading={pendingAction?.entryKey === archivedEntryIdentityKey(entry)
            && pendingAction.type === 'delete'}
          aria-label={t('nav.sessions.deleteArchived')}
        >
          {t('nav.sessions.deleteArchived')}
        </Button>
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

const ArchivedSessionsConfig: React.FC = () => {
  const { t } = useTranslation('common');
  const { openedWorkspacesList } = useWorkspaceContext();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [entries, setEntries] = useState<ArchivedEntry[]>([]);
  const [loadFailures, setLoadFailures] = useState<WorkspaceLoadFailure[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const prevLoadingRef = useRef(loading);
  const loadRequestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  // ── Load archived sessions from all open workspaces ──────────────────────

  const loadArchived = useCallback(async (background = false) => {
    const requestId = ++loadRequestIdRef.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    const collected: ArchivedEntry[] = [];
    const failures: WorkspaceLoadFailure[] = [];

    const results = await Promise.all(openedWorkspacesList.map(async ws => {
      try {
        const archived = await sessionAPI.listArchivedSessions(ws.id);
        return { ws, archived };
      } catch (err) {
        log.error('Failed to load archived sessions for workspace', {
          workspace: ws.rootPath,
          err,
        });
        return { ws, archived: null };
      }
    }));

    if (requestId !== loadRequestIdRef.current) return;

    for (const { ws, archived } of results) {
      if (!archived) {
        failures.push({
          workspaceKey: workspaceIdentityKey(ws.id),
          workspacePath: ws.rootPath,
          workspaceName: workspaceScopeLabel(ws.name, ws.connectionId, ws.sshHost),
        });
        continue;
      }
      for (const session of archived) {
        collected.push({
          session,
          workspaceId: ws.id,
          workspacePath: ws.rootPath,
          workspaceName: ws.name,
          remoteConnectionId: ws.connectionId,
          remoteSshHost: ws.sshHost,
        });
      }
    }

    // Sort by last active descending
    collected.sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);
    if (background && failures.length > 0) {
      const failedWorkspaceKeys = new Set(failures.map(failure => failure.workspaceKey));
      setEntries(previous => [
        ...collected,
        ...previous.filter(entry => failedWorkspaceKeys.has(workspaceIdentityKey(entry.workspaceId))),
      ].sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt));
    } else {
      setEntries(collected);
    }
    setLoadFailures(failures);
    hasLoadedRef.current = true;
    setLoading(false);
    setRefreshing(false);
  }, [openedWorkspacesList]);

  // This view only mounts while selected, so mounting is the activation boundary.
  useEffect(() => {
    void loadArchived(hasLoadedRef.current);
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [loadArchived]);

  // Re-fetch when a session is archived elsewhere while this page is open
  useEffect(() => {
    const handler = () => {
      void loadArchived(true);
    };
    window.addEventListener('openbitfun:session-archived', handler);
    return () => window.removeEventListener('openbitfun:session-archived', handler);
  }, [loadArchived]);

  // ── Group entries by workspace ───────────────────────────────────────────

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; entries: ArchivedEntry[] }>();
    for (const entry of entries) {
      const key = workspaceIdentityKey(entry.workspaceId);
      let group = map.get(key);
      if (!group) {
        const scopeLabel = workspaceScopeLabel(
          entry.workspaceName,
          entry.remoteConnectionId,
          entry.remoteSshHost,
        );
        group = {
          label: scopeLabel === entry.workspacePath
            ? entry.workspacePath
            : `${scopeLabel} · ${entry.workspacePath}`,
          entries: [],
        };
        map.set(key, group);
      }
      group.entries.push(entry);
    }
    return map;
  }, [entries]);

  // Collapse all workspace groups by default when data finishes loading
  useEffect(() => {
    if (prevLoadingRef.current && !loading && grouped.size > 0) {
      setCollapsedWorkspaces(new Set(grouped.keys()));
    }
    prevLoadingRef.current = loading;
  }, [loading, grouped]);

  // ── Remove an entry from local state after mutation ──────────────────────

  const removeEntry = useCallback((target: ArchivedEntry) => {
    const targetKey = archivedEntryIdentityKey(target);
    setEntries(prev => prev.filter(entry => archivedEntryIdentityKey(entry) !== targetKey));
  }, []);

  const toggleWorkspace = useCallback((workspaceKey: string) => {
    setCollapsedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return next;
    });
  }, []);

  // ── Restore single session ───────────────────────────────────────────────

  const handleRestore = useCallback(async (entry: ArchivedEntry) => {
    if (pendingAction || bulkDeleting) return;
    setPendingAction({ entryKey: archivedEntryIdentityKey(entry), type: 'restore' });

    try {
      await sessionAPI.unarchiveSession(entry.session.sessionId, entry.workspaceId);
      removeEntry(entry);
      notificationService.success(t('nav.sessions.restoreSucceeded', {
        name: entry.session.sessionName || t('nav.sessions.untitled'),
        workspace: workspaceScopeLabel(
          entry.workspaceName,
          entry.remoteConnectionId,
          entry.remoteSshHost,
        ),
      }));
      try {
        // Refresh the workspace sessions so the restored session appears in the sidebar immediately.
        await flowChatManager.refreshWorkspaceSessions({
          id: entry.workspaceId,
        });
      } catch (err) {
        log.error('Restored session but failed to refresh workspace sessions', err);
        notificationService.warning(t('nav.sessions.restoreRefreshFailed'), {
          duration: 4000,
        });
      }
    } catch (err) {
      log.error('Failed to restore archived session', err);
      notificationService.error(
        err instanceof Error ? err.message : t('nav.sessions.restoreFailed'),
        { duration: 4000 }
      );
    } finally {
      setPendingAction(null);
    }
  }, [bulkDeleting, pendingAction, removeEntry, t]);

  // ── Delete single archived session ───────────────────────────────────────

  const handleDelete = useCallback(async (entry: ArchivedEntry) => {
    if (pendingAction || bulkDeleting) return;
    const confirmed = await confirmDanger(
      t('nav.sessions.deleteArchivedConfirmTitle'),
      t('nav.sessions.deleteArchivedConfirmMessage', {
        name: entry.session.sessionName || t('nav.sessions.untitled'),
        workspace: workspaceScopeLabel(
          entry.workspaceName,
          entry.remoteConnectionId,
          entry.remoteSshHost,
        ),
      }),
    );
    if (!confirmed) return;

    setPendingAction({ entryKey: archivedEntryIdentityKey(entry), type: 'delete' });
    try {
      await sessionAPI.deleteSession(entry.session.sessionId, entry.workspaceId);
      removeEntry(entry);
      notificationService.success(t('nav.sessions.deleteArchivedSucceeded', {
        name: entry.session.sessionName || t('nav.sessions.untitled'),
        workspace: workspaceScopeLabel(
          entry.workspaceName,
          entry.remoteConnectionId,
          entry.remoteSshHost,
        ),
      }));
    } catch (err) {
      log.error('Failed to delete archived session', err);
      notificationService.error(
        err instanceof Error ? err.message : t('nav.sessions.deleteArchivedFailed'),
        { duration: 4000 }
      );
    } finally {
      setPendingAction(null);
    }
  }, [bulkDeleting, pendingAction, removeEntry, t]);

  // ── Delete all archived sessions ─────────────────────────────────────────

  const handleDeleteAll = useCallback(async () => {
    if (pendingAction || bulkDeleting || entries.length === 0) return;
    const workspaceCount = new Set(entries.map(entry => workspaceIdentityKey(entry.workspaceId))).size;
    const confirmed = await confirmDanger(
      t('nav.sessions.deleteAllArchivedConfirmTitle'),
      t('nav.sessions.deleteAllArchivedConfirmMessage', {
        count: entries.length,
        workspaceCount,
      }),
    );
    if (!confirmed) return;

    setBulkDeleting(true);
    try {
      const targets = Array.from(new Map(
        entries.map(entry => [workspaceIdentityKey(entry.workspaceId), entry]),
      ).values());
      const results = await Promise.all(targets.map(async entry => {
        try {
          await sessionAPI.deleteAllArchivedSessions(entry.workspaceId);
          return { entry, succeeded: true } as const;
        } catch (err) {
          log.error('Failed to delete archived sessions for workspace', {
            workspace: entry.workspacePath,
            err,
          });
          return { entry, succeeded: false } as const;
        }
      }));
      const deletedWorkspaceKeys = new Set(
        results.filter(result => result.succeeded).map(result => workspaceIdentityKey(result.entry.workspaceId)),
      );
      const failedWorkspaceCount = results.filter(result => !result.succeeded).length;
      const deletedCount = entries.filter(entry => deletedWorkspaceKeys.has(workspaceIdentityKey(entry.workspaceId))).length;

      if (deletedWorkspaceKeys.size > 0) {
        setEntries(previous => previous.filter(entry => !deletedWorkspaceKeys.has(
          workspaceIdentityKey(entry.workspaceId),
        )));
      }
      if (failedWorkspaceCount === 0) {
        notificationService.success(t('nav.sessions.deleteAllArchivedSucceeded', {
          count: deletedCount,
        }));
      } else if (deletedWorkspaceKeys.size > 0) {
        notificationService.warning(t('nav.sessions.deleteAllArchivedPartial', {
          deletedCount,
          failedWorkspaceCount,
        }), { duration: 5000 });
      } else {
        notificationService.error(t('nav.sessions.deleteAllArchivedFailed'), {
          duration: 4000,
        });
      }
    } catch (err) {
      log.error('Failed to delete all archived sessions', err);
      notificationService.error(
        err instanceof Error ? err.message : t('nav.sessions.deleteAllArchivedFailed'),
        { duration: 4000 }
      );
    } finally {
      setBulkDeleting(false);
    }
  }, [bulkDeleting, entries, pendingAction, t]);

  // ── Render ───────────────────────────────────────────────────────────────

  const hasEntries = entries.length > 0;

  const headerExtra = (
    <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="headerActions" className="archived-sessions-config__header-actions">
      <ConfigRefreshButton
        tooltip={t('actions.refresh')}
        onClick={() => { void loadArchived(true); }}
        disabled={loading || refreshing || pendingAction !== null || bulkDeleting}
        loading={refreshing}
      />
      {hasEntries && (
        <Button
          size="sm"
          variant="outline"
          leadingIcon={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
          onClick={() => { void handleDeleteAll(); }}
          disabled={pendingAction !== null || bulkDeleting}
          loading={bulkDeleting}
        >
          {t('nav.sessions.deleteAllArchived')}
        </Button>
      )}
    </div>
  );

  return (
    <ConfigPageLayout data-openbitfun-component="archived-sessions-config" data-openbitfun-part="root" className="archived-sessions-config">
      <ConfigPageHeader
        title={t('nav.sessions.archivedSessions')}
        subtitle={t('nav.sessions.archivedSessionsDescription')}
      />
      <ConfigPageContent>
        <ConfigPageSection
          title={t('nav.sessions.archivedSessions')}
          extra={headerExtra}
        >
          {loadFailures.map(failure => (
            <ConfigMessage
              key={failure.workspaceKey}
              message={{
                type: 'error',
                text: t('nav.sessions.loadArchivedFailedForWorkspace', {
                  workspace: failure.workspaceName,
                  path: failure.workspacePath,
                }),
              }}
            />
          ))}
          {loading ? (
            <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="loading" className="archived-sessions-config__loading">
              {t('nav.sessions.loading')}
            </div>
          ) : !hasEntries && loadFailures.length === 0 ? (
            <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="empty" className="archived-sessions-config__empty">
              <Empty
                icon={<Inbox aria-hidden />}
                title={t('nav.sessions.noArchivedSessions')}
              />
            </div>
          ) : hasEntries ? (
            <>
            {Array.from(grouped.entries()).map(([workspaceKey, group]) => {
              const isCollapsed = collapsedWorkspaces.has(workspaceKey);
              return (
              <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="group" data-openbitfun-state={isCollapsed ? 'collapsed' : undefined} key={workspaceKey} className="archived-sessions-config__group">
                <button data-overflow-trigger
                  type="button"
                  data-openbitfun-component="archived-sessions-config"
                  data-openbitfun-part="groupHeader"
                  className="archived-sessions-config__group-header"
                  onClick={() => toggleWorkspace(workspaceKey)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? (
                    <Icon name="chevron-right" size="sm" className="archived-sessions-config__group-chevron" />
                  ) : (
                    <Icon name="chevron-down" size="sm" className="archived-sessions-config__group-chevron" />
                  )}
                  <OverflowText className="archived-sessions-config__group-name">{group.label}</OverflowText>
                  <span className="archived-sessions-config__group-count">
                    {group.entries.length}
                  </span>
                </button>
                {!isCollapsed && (
                <div data-openbitfun-component="archived-sessions-config" data-openbitfun-part="groupList" className="archived-sessions-config__group-list">
                  {group.entries.map(entry => (
                    <ArchivedRow
                      key={archivedEntryIdentityKey(entry)}
                      entry={entry}
                      onRestore={(e) => { void handleRestore(e); }}
                      onDelete={(e) => { void handleDelete(e); }}
                      pendingAction={pendingAction}
                      disabled={pendingAction !== null || bulkDeleting}
                      t={t}
                    />
                  ))}
                </div>
                )}
              </div>
              );
            })}
            </>
          ) : null}
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default ArchivedSessionsConfig;
