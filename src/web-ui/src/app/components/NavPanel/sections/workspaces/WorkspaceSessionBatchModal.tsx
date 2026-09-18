import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { resolveLegacySessionWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { OverflowText,
  Button,
  Checkbox,
  Icon,
  ScrollArea,
  Spinner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import type { SessionMetadata } from '@/shared/types/session-history';
import { sessionBelongsToWorkspaceNavRow, compareSessionMetadataForDisplay } from '@/flow_chat/utils/sessionOrdering';
import { deriveSessionRelationshipFromMetadata, resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './WorkspaceSessionBatchModal.scss';

interface WorkspaceSessionBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Authoritative workspace scope; every load and mutation is keyed by it. */
  workspaceId: string;
  workspaceLabel: string;
}

type BatchActionKind = 'archive' | 'delete' | null;

interface SessionBatchItem {
  metadata: SessionMetadata;
  parentSessionId?: string | null;
  displayAsChild: boolean;
}

const log = createLogger('WorkspaceSessionBatchModal');

type SessionPresentation = 'project' | 'assistant';

function resolveSessionPresentation(agentType: string | undefined): SessionPresentation {
  const normalized = agentType?.trim().toLowerCase() ?? '';
  if (normalized === 'claw') {
    return 'assistant';
  }
  return 'project';
}

function buildSessionBatchItems(sessions: SessionMetadata[]): SessionBatchItem[] {
  const sortedSessions = [...sessions].sort(compareSessionMetadataForDisplay);
  const knownIds = new Set(sortedSessions.map(session => session.sessionId));
  return sortedSessions.map(metadata => {
    const relationship = resolveSessionRelationship(deriveSessionRelationshipFromMetadata(metadata));
    return {
      metadata,
      parentSessionId: relationship.parentSessionId,
      displayAsChild: Boolean(relationship.parentSessionId && knownIds.has(relationship.parentSessionId)),
    };
  });
}

function getDeletionPlan(selectedIds: Set<string>, sessions: SessionBatchItem[]): { rootIds: string[]; allIds: string[] } {
  const parentById = new Map<string, string | null | undefined>();
  const childrenByParent = new Map<string, string[]>();

  sessions.forEach(session => {
    const sessionId = session.metadata.sessionId;
    parentById.set(sessionId, session.parentSessionId);
    if (session.parentSessionId) {
      const siblings = childrenByParent.get(session.parentSessionId) || [];
      siblings.push(sessionId);
      childrenByParent.set(session.parentSessionId, siblings);
    }
  });

  const rootIds = Array.from(selectedIds).filter(sessionId => {
    let cursor = parentById.get(sessionId);
    while (cursor) {
      if (selectedIds.has(cursor)) {
        return false;
      }
      cursor = parentById.get(cursor);
    }
    return true;
  });

  const allIds = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const sessionId = stack.pop()!;
    if (allIds.has(sessionId)) {
      continue;
    }
    allIds.add(sessionId);
    const children = childrenByParent.get(sessionId) || [];
    children.forEach(childId => stack.push(childId));
  }

  return {
    rootIds,
    allIds: Array.from(allIds),
  };
}

const WorkspaceSessionBatchModal: React.FC<WorkspaceSessionBatchModalProps> = ({
  isOpen,
  onClose,
  workspaceId,
  workspaceLabel,
}) => {
  const { t, formatDate, formatRelativeTime } = useI18n('common');
  // Display-only projection of the workspace root; never used to select data.
  const workspacePath = workspaceManager.getState().openedWorkspaces.get(workspaceId)?.rootPath ?? '';
  const [sessions, setSessions] = useState<SessionBatchItem[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [actionKind, setActionKind] = useState<BatchActionKind>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setLoadFailed(false);
    try {
      const metadataList = await sessionAPI.listSessions(
        workspaceId
      );
      const filtered = metadataList.map(metadata => ({ ...metadata, workspaceId: metadata.workspaceId ??
        resolveLegacySessionWorkspace(metadata, [...workspaceManager.getState().openedWorkspaces.values()])?.id })).filter(metadata => {
        if (metadata.status === 'archived') {
          return false;
        }
        if (
          !sessionBelongsToWorkspaceNavRow(
            metadata, workspaceId
          )
        ) {
          return false;
        }
        const relationship = resolveSessionRelationship(deriveSessionRelationshipFromMetadata(metadata));
        return !relationship.isSubagent;
      });
      setSessions(buildSessionBatchItems(filtered));
      setSelectedSessionIds(new Set());
    } catch (error) {
      log.error('Failed to load workspace sessions for batch management', { error, workspaceId });
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedSessionIds(new Set());
      setActionKind(null);
      setLoadFailed(false);
      return;
    }
    void loadSessions();
  }, [isOpen, loadSessions]);

  const allSessionIds = useMemo(
    () => sessions.map(session => session.metadata.sessionId),
    [sessions]
  );
  const selectedCount = selectedSessionIds.size;
  const allSelected = allSessionIds.length > 0 && selectedCount === allSessionIds.length;
  const partiallySelected = selectedCount > 0 && selectedCount < allSessionIds.length;
  const isBusy = isLoading || actionKind !== null;
  const hasSessions = sessions.length > 0;
  const canSelectSessions = hasSessions && !isBusy && !loadFailed;

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedSessionIds(prev => {
      if (prev.size === allSessionIds.length) {
        return new Set();
      }
      return new Set(allSessionIds);
    });
  }, [allSessionIds]);

  const handleInvertSelection = useCallback(() => {
    setSelectedSessionIds(prev => new Set(allSessionIds.filter(sessionId => !prev.has(sessionId))));
  }, [allSessionIds]);

  const refreshWorkspaceSessions = useCallback(async () => {
    await flowChatManager.refreshWorkspaceSessions({ id: workspaceId });
  }, [workspaceId]);

  const handleArchiveSelected = useCallback(async () => {
    if (selectedCount === 0) {
      return;
    }

    const selectedIds = Array.from(selectedSessionIds);
    setActionKind('archive');
    try {
      const results = await Promise.allSettled(
        selectedIds.map(sessionId => flowChatManager.archiveChatSession(sessionId))
      );
      const successCount = results.filter(result => result.status === 'fulfilled').length;
      if (successCount > 0) {
        await refreshWorkspaceSessions();
        window.dispatchEvent(new CustomEvent('openbitfun:session-archived'));
        notificationService.success(t('nav.sessions.archivedAll', { count: successCount }), { duration: 3000 });
      }
      if (successCount !== selectedIds.length) {
        notificationService.error(t('nav.sessions.bulkArchiveFailed'), { duration: 4000 });
      }
      await loadSessions();
    } catch (error) {
      log.error('Failed to archive selected sessions', { error, workspaceId });
      notificationService.error(t('nav.sessions.bulkArchiveFailed'), { duration: 4000 });
    } finally {
      setActionKind(null);
    }
  }, [
    loadSessions,
    refreshWorkspaceSessions,
    selectedCount,
    selectedSessionIds,
    t,
    workspaceId,
  ]);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedCount === 0) {
      return;
    }
    const confirmed = await confirmDanger(
      t('nav.sessions.bulkDeleteConfirmTitle'),
      t('nav.sessions.bulkDeleteConfirmMessage', { count: selectedCount }),
      { confirmText: t('nav.sessions.deleteSelected') },
    );
    if (!confirmed) {
      return;
    }

    const deletionPlan = getDeletionPlan(selectedSessionIds, sessions);
    setActionKind('delete');
    try {
      const successIds = new Set<string>();

      for (const rootId of deletionPlan.rootIds) {
        const cascadeIds = getDeletionPlan(new Set([rootId]), sessions).allIds;
        try {
          await flowChatManager.deleteChatSession(rootId);
          cascadeIds.forEach(id => successIds.add(id));
        } catch (error) {
          log.error('Failed to delete selected root session', {
            error,
            rootSessionId: rootId,
            workspaceId,
          });
        }
      }

      if (successIds.size > 0) {
        await refreshWorkspaceSessions();
        notificationService.success(t('nav.sessions.deletedSelected', { count: successIds.size }), { duration: 3000 });
      }
      if (successIds.size !== deletionPlan.allIds.length) {
        notificationService.error(t('nav.sessions.bulkDeleteFailed'), { duration: 4000 });
      }
      await loadSessions();
    } catch (error) {
      log.error('Failed to delete selected sessions', { error, workspaceId });
      notificationService.error(t('nav.sessions.bulkDeleteFailed'), { duration: 4000 });
    } finally {
      setActionKind(null);
    }
  }, [
    loadSessions,
    refreshWorkspaceSessions,
    selectedCount,
    selectedSessionIds,
    sessions,
    t,
    workspaceId,
  ]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) onClose();
      }}
      size="xl"
      className="workspace-session-batch-modal__dialog"
      closeOnEscape={!isBusy}
      closeOnPointerOutside={!isBusy}
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('nav.sessions.manage')}</DialogTitle>
          <DialogDescription>{t('nav.sessions.batchManageDescription')}</DialogDescription>
        </DialogHeading>
        <DialogClose disabled={isBusy} />
      </DialogHeader>
      <DialogBody inset="none" className="workspace-session-batch-modal__body">
        <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="root" className="workspace-session-batch-modal">
          <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="hero" className="workspace-session-batch-modal__context">
            <Icon name="folder" size="sm" />
            <OverflowText className="workspace-session-batch-modal__workspace" title={workspacePath}>
              {workspaceLabel}
            </OverflowText>
          </div>

          <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="toolbar" className="workspace-session-batch-modal__toolbar">
            <div className="workspace-session-batch-modal__toolbar-main">
              <Checkbox
                checked={allSelected}
                indeterminate={partiallySelected}
                onChange={() => { handleToggleSelectAll(); }}
                disabled={!canSelectSessions}
                label={t('actions.selectAll')}
              />
              <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="toolbarActions" className="workspace-session-batch-modal__toolbar-actions">
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  onClick={handleInvertSelection}
                  disabled={!canSelectSessions}
                >
                  {t('actions.invertSelection')}
                </Button>
              </div>
            </div>
            <div
              data-openbitfun-component="workspace-session-batch-modal"
              data-openbitfun-part="summary"
              className="workspace-session-batch-modal__summary"
              role="status"
              aria-atomic="true"
            >
              {!isLoading && !loadFailed && hasSessions
                ? t('nav.sessions.batchSelectionSummary', { count: selectedCount, total: sessions.length })
                : null}
            </div>
          </div>

          <ScrollArea
            data-openbitfun-component="workspace-session-batch-modal"
            data-openbitfun-part="list"
            className="workspace-session-batch-modal__list"
            aria-busy={isLoading}
          >
            {isLoading ? (
              <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="state" data-openbitfun-state="loading" className="workspace-session-batch-modal__state" role="status">
                <Spinner size="sm" />
                <span>{t('nav.sessions.loading')}</span>
              </div>
            ) : loadFailed ? (
              <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="state" data-openbitfun-state="error" className="workspace-session-batch-modal__state" role="alert">
                <Icon name="info" size="md" />
                <span>{t('nav.sessions.batchLoadFailed')}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => { void loadSessions(); }}>
                  {t('actions.retry')}
                </Button>
              </div>
            ) : !hasSessions ? (
              <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="state" className="workspace-session-batch-modal__state" role="status">
                <Icon name="session" size="md" />
                <span>{t('nav.sessions.noSessionsToManage')}</span>
              </div>
            ) : (
              <div role="list" aria-label={t('nav.sessions.manage')}>
                {sessions.map(({ metadata, displayAsChild }) => {
                  const isSelected = selectedSessionIds.has(metadata.sessionId);
                  const sessionPresentation = resolveSessionPresentation(metadata.agentType);
                  const sessionName = metadata.sessionName || t('nav.sessions.untitled');
                  return (
                    <div
                      data-openbitfun-component="workspace-session-batch-modal"
                      data-openbitfun-part="row"
                      data-openbitfun-state={[isSelected && 'selected', displayAsChild && 'child'].filter(Boolean).join(' ') || undefined}
                      key={metadata.sessionId}
                      role="listitem"
                      className="workspace-session-batch-modal__row"
                    >
                      <div data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="rowCheck">
                        <Checkbox
                          className="workspace-session-batch-modal__row-control"
                          checked={isSelected}
                          onChange={() => { toggleSessionSelection(metadata.sessionId); }}
                          disabled={isBusy}
                          aria-label={sessionName}
                          label={
                            <span data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="rowContent" className="workspace-session-batch-modal__row-content">
                              <span className="workspace-session-batch-modal__row-icon">
                                {sessionPresentation === 'assistant'
                                  ? <Icon name="user" size="sm" />
                                  : <Icon name="session" size="sm" />}
                              </span>
                              <span className="workspace-session-batch-modal__row-head">
                                <OverflowText className="workspace-session-batch-modal__row-title" title={sessionName}>
                                  {sessionName}
                                </OverflowText>
                                {displayAsChild && (
                                  <span className="workspace-session-batch-modal__row-meta">
                                    {t('nav.sessions.batchChildSession')}
                                  </span>
                                )}
                              </span>
                              <span
                                className="workspace-session-batch-modal__row-updated"
                                title={formatDate(metadata.lastActiveAt, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              >
                                {formatRelativeTime(metadata.lastActiveAt)}
                              </span>
                            </span>
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogBody>

      <DialogFooter data-openbitfun-component="workspace-session-batch-modal" data-openbitfun-part="footer" className="workspace-session-batch-modal__footer">
        <Button
          type="button"
          variant="outline"
          tone="danger"
          onClick={() => { void handleDeleteSelected(); }}
          disabled={!canSelectSessions || selectedCount === 0}
          loading={actionKind === 'delete'}
          leadingIcon={<Icon name="delete" />}
        >
          {t('nav.sessions.deleteSelected')}
        </Button>
        <div className="workspace-session-batch-modal__footer-actions">
          <Button type="button" variant="fill" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => { void handleArchiveSelected(); }}
            disabled={!canSelectSessions || selectedCount === 0}
            loading={actionKind === 'archive'}
            leadingIcon={<Icon glyph={Archive} />}
          >
            {t('nav.sessions.archiveSelected')}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
};

export default WorkspaceSessionBatchModal;
