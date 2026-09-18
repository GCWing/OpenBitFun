import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { resolveLegacySessionWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { OverflowText, Button, ConfirmDialog, Icon, IconButton, Input, NumberInput, Switch, Tooltip } from '@openbitfun/ui';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { FolderGit2, LoaderCircle, MessageSquareText, RotateCcw } from 'lucide-react';
import { openAgentCompanionSession } from '@/app/services/openAgentCompanionSession';
import { confirmWarning } from '@/infrastructure/confirm-dialog';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { configAPI, worktreeAPI } from '@/infrastructure/api';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import type {
  WorktreeCommandError,
  WorktreeProjectLocator,
  WorktreeProjectSummary,
  WorktreeSessionSummary,
  WorktreeSettings,
  WorktreeSummary,
} from '@/infrastructure/api/service-api/WorktreeAPI';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import {
  ConfigActionBar,
  ConfigEmptyState,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  ConfigLoadingState,
  ConfigMessage,
  ConfigRefreshButton,
  ConfigRetryState,
} from './common';
import { useSettingsDraft } from '@/infrastructure/config/settingsDraftRegistry';
import './WorktreeSettingsPage.scss';

const AUTO_DELETE_LIMIT_MIN = 1;
const AUTO_DELETE_LIMIT_MAX = 100;
const WORKTREE_REMOVE_ANIMATION_MS = 180;

const DEFAULT_SETTINGS: WorktreeSettings = {
  rootPath: '~/.openbitfun/worktrees',
  branchPrefix: 'openbitfun/',
  copyLocalChanges: false,
  autoDeleteEnabled: true,
  autoDeleteLimit: 15,
};

interface DeleteTarget {
  projectWorkspaceId?: string;
  projectWorkspacePath: string;
  worktree: WorktreeSummary;
}

interface ScrollSnapshot {
  anchorTop: number;
  scrollContainer: HTMLElement;
  scrollTop: number;
}

type PageMessage = {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
};

function normalizeSettings(configured: unknown): WorktreeSettings {
  const value = configured && typeof configured === 'object'
    ? configured as Partial<WorktreeSettings>
    : {};
  const configuredLimit = typeof value.autoDeleteLimit === 'number'
    && Number.isFinite(value.autoDeleteLimit)
    ? Math.round(value.autoDeleteLimit)
    : DEFAULT_SETTINGS.autoDeleteLimit;

  return {
    rootPath: typeof value.rootPath === 'string'
      ? value.rootPath
      : DEFAULT_SETTINGS.rootPath,
    branchPrefix: typeof value.branchPrefix === 'string'
      ? value.branchPrefix
      : DEFAULT_SETTINGS.branchPrefix,
    copyLocalChanges: typeof value.copyLocalChanges === 'boolean'
      ? value.copyLocalChanges
      : DEFAULT_SETTINGS.copyLocalChanges,
    autoDeleteEnabled: typeof value.autoDeleteEnabled === 'boolean'
      ? value.autoDeleteEnabled
      : DEFAULT_SETTINGS.autoDeleteEnabled,
    autoDeleteLimit: Math.min(
      AUTO_DELETE_LIMIT_MAX,
      Math.max(AUTO_DELETE_LIMIT_MIN, configuredLimit),
    ),
  };
}

function settingsEqual(left: WorktreeSettings, right: WorktreeSettings): boolean {
  return left.rootPath === right.rootPath
    && left.branchPrefix === right.branchPrefix
    && left.copyLocalChanges === right.copyLocalChanges
    && left.autoDeleteEnabled === right.autoDeleteEnabled
    && left.autoDeleteLimit === right.autoDeleteLimit;
}

function createDeleteRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `worktree-settings-delete-${Date.now()}-${Math.random()}`;
}

type DeletionBlockReason = 'locked' | 'missing';

function deletionBlockReason(worktree: WorktreeSummary): DeletionBlockReason | null {
  if (worktree.locked) return 'locked';
  if (worktree.missing) return 'missing';
  return null;
}

function workspaceName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function removeWorktreeFromProjects(
  projects: WorktreeProjectSummary[],
  projectWorkspacePath: string,
  worktreeId: string,
): WorktreeProjectSummary[] {
  return projects
    .map(project => project.projectWorkspacePath === projectWorkspacePath
      ? {
          ...project,
          worktrees: project.worktrees.filter(worktree => worktree.worktreeId !== worktreeId),
        }
      : project)
    .filter(project => project.worktrees.length > 0);
}

function removalAnimationDuration(): number {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 0
    : WORKTREE_REMOVE_ANIMATION_MS;
}

function waitFor(ms: number): Promise<void> {
  return ms > 0
    ? new Promise(resolve => globalThis.setTimeout(resolve, ms))
    : Promise.resolve();
}

const WorktreeSettingsPage: React.FC = () => {
  const { t } = useI18n('worktrees');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [trustedSettings, setTrustedSettings] = useState<WorktreeSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<PageMessage | null>(null);
  const [projects, setProjects] = useState<WorktreeProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsInitialized, setProjectsInitialized] = useState(false);
  const [projectsMessage, setProjectsMessage] = useState<PageMessage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletingWorktreeId, setDeletingWorktreeId] = useState<string | null>(null);
  const [removingWorktreeId, setRemovingWorktreeId] = useState<string | null>(null);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [projectsLayoutRevision, setProjectsLayoutRevision] = useState(0);
  const projectsResultsRef = useRef<HTMLDivElement>(null);
  const projectsRequestIdRef = useRef(0);
  const pendingScrollSnapshotRef = useRef<ScrollSnapshot | null>(null);
  const worktreeMutationInFlightRef = useRef(false);
  const pendingWorktreeRefreshRef = useRef(false);
  const settingsSaveInFlightRef = useRef(false);
  const settingsDirty = trustedSettings !== null && !settingsEqual(settings, trustedSettings);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsMessage(null);
    try {
      const configured = await configAPI.getConfig('app.worktrees', {
        skipRetryOnNotFound: true,
      });
      const nextSettings = normalizeSettings(configured);
      setSettings(nextSettings);
      setTrustedSettings(nextSettings);
    } catch {
      setTrustedSettings(null);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const updateSettings = useCallback((patch: Partial<WorktreeSettings>) => {
    setSettings(current => ({ ...current, ...patch }));
    setSettingsMessage(null);
  }, []);

  const captureScrollSnapshot = useCallback((): ScrollSnapshot | null => {
    const anchor = projectsResultsRef.current;
    const scrollContainer = anchor?.closest<HTMLElement>('.openbitfun-config-page-layout');
    if (!anchor || !scrollContainer) {
      return null;
    }
    return {
      anchorTop: anchor.getBoundingClientRect().top,
      scrollContainer,
      scrollTop: scrollContainer.scrollTop,
    };
  }, []);

  const commitProjectsLayoutChange = useCallback((update: () => void) => {
    pendingScrollSnapshotRef.current = captureScrollSnapshot();
    update();
    setProjectsLayoutRevision(current => current + 1);
  }, [captureScrollSnapshot]);

  useLayoutEffect(() => {
    const snapshot = pendingScrollSnapshotRef.current;
    const anchor = projectsResultsRef.current;
    if (!snapshot || !anchor || !snapshot.scrollContainer.isConnected) {
      pendingScrollSnapshotRef.current = null;
      return;
    }

    const anchorDelta = anchor.getBoundingClientRect().top - snapshot.anchorTop;
    snapshot.scrollContainer.scrollTop = snapshot.scrollTop + anchorDelta;
    pendingScrollSnapshotRef.current = null;
  }, [projectsLayoutRevision]);

  const loadProjects = useCallback(async (): Promise<boolean> => {
    const requestId = ++projectsRequestIdRef.current;
    setProjectsLoading(true);
    try {
      const nextProjects = await worktreeAPI.listProjects();
      if (requestId !== projectsRequestIdRef.current) {
        return false;
      }
      commitProjectsLayoutChange(() => {
        setProjects(nextProjects);
        setProjectsMessage(null);
        setProjectsInitialized(true);
        setProjectsLoading(false);
      });
      return true;
    } catch {
      if (requestId !== projectsRequestIdRef.current) {
        return false;
      }
      commitProjectsLayoutChange(() => {
        setProjectsMessage({ type: 'error', text: t('management.loadFailed') });
        setProjectsInitialized(true);
        setProjectsLoading(false);
      });
      return false;
    }
  }, [commitProjectsLayoutChange, t]);

  useEffect(() => {
    void loadSettings();
    void loadProjects();
    return worktreeAPI.onChanged(() => {
      if (worktreeMutationInFlightRef.current) {
        pendingWorktreeRefreshRef.current = true;
        return;
      }
      void loadProjects();
    });
  }, [loadProjects, loadSettings]);

  const save = async (): Promise<boolean> => {
    if (!trustedSettings || !settingsDirty) {
      return !settingsDirty;
    }
    if (settingsSaveInFlightRef.current || saving) return false;
    if (!settings.rootPath.trim() || !settings.branchPrefix.trim()) {
      setSettingsMessage({ type: 'error', text: t('settings.required') });
      return false;
    }
    if (
      settings.autoDeleteLimit < AUTO_DELETE_LIMIT_MIN
      || settings.autoDeleteLimit > AUTO_DELETE_LIMIT_MAX
    ) {
      setSettingsMessage({
        type: 'error',
        text: t('settings.autoDeleteLimit.invalid', {
          min: AUTO_DELETE_LIMIT_MIN,
          max: AUTO_DELETE_LIMIT_MAX,
        }),
      });
      return false;
    }

    settingsSaveInFlightRef.current = true;
    setSaving(true);
    setSettingsMessage(null);
    try {
      const normalized = {
        ...settings,
        rootPath: settings.rootPath.trim(),
        branchPrefix: settings.branchPrefix.trim(),
        autoDeleteLimit: Math.round(settings.autoDeleteLimit),
      };
      await configAPI.setConfig('app.worktrees', normalized);
      setSettings(normalized);
      setTrustedSettings(normalized);
      setSettingsMessage({ type: 'success', text: t('settings.saved') });
      return true;
    } catch {
      setSettingsMessage({ type: 'error', text: t('settings.saveFailed') });
      return false;
    } finally {
      settingsSaveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const discardSettings = useCallback(() => {
    if (!trustedSettings) return;
    setSettings(trustedSettings);
    setSettingsMessage(null);
  }, [trustedSettings]);

  useSettingsDraft({
    id: 'worktree-settings',
    pageId: 'workspace.worktrees',
    label: t('settings.title'),
    dirty: settingsDirty,
    saving,
    save,
    discard: discardSettings,
  });

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;

    setDeleteTarget(null);
    setDeletingWorktreeId(target.worktree.worktreeId);
    worktreeMutationInFlightRef.current = true;
    pendingWorktreeRefreshRef.current = false;
    try {
      const discardLocalWork =
        target.worktree.dirty || target.worktree.hasUnpublishedCommits;
      await worktreeAPI.remove(
        {
          projectWorkspaceId: target.projectWorkspaceId,
          projectWorkspacePath: target.projectWorkspacePath,
        },
        target.worktree.worktreeId,
        createDeleteRequestId(),
        discardLocalWork,
      );
      setRemovingWorktreeId(target.worktree.worktreeId);
      await waitFor(removalAnimationDuration());
      commitProjectsLayoutChange(() => {
        setProjects(current => removeWorktreeFromProjects(
          current,
          target.projectWorkspacePath,
          target.worktree.worktreeId,
        ));
        setRemovingWorktreeId(null);
      });
      notificationService.success(
        t('management.deleted', { path: target.worktree.path }),
        { duration: 2400 },
      );
      await loadProjects();
      pendingWorktreeRefreshRef.current = false;
    } catch (error) {
      const code = (error as Partial<WorktreeCommandError> | null)?.code;
      const text = (() => {
        switch (code) {
          case 'worktree_locked':
            return t('management.errors.locked');
          case 'dirty_worktree':
            return t('management.errors.dirty');
          case 'unpublished_commits':
            return t('management.errors.unpublishedCommits');
          case 'worktree_not_found':
            return t('management.errors.notFound');
          case 'remote_unsupported':
            return t('management.errors.remoteUnsupported');
          default:
            return t('management.errors.deleteFailed');
        }
      })();
      commitProjectsLayoutChange(() => {
        setProjectsMessage({
          type: 'error',
          text,
        });
      });
    } finally {
      worktreeMutationInFlightRef.current = false;
      setDeletingWorktreeId(null);
      setRemovingWorktreeId(null);
      if (pendingWorktreeRefreshRef.current) {
        pendingWorktreeRefreshRef.current = false;
        void loadProjects();
      }
    }
  };

  const openAssociatedSession = useCallback(async (
    project: WorktreeProjectLocator,
    session: WorktreeSessionSummary,
  ) => {
    if (openingSessionId) return;

    setOpeningSessionId(session.sessionId);
    try {
      // The session's own workspace ID is authoritative; the owning project ID
      // covers persisted sessions recorded before per-session IDs. The path
      // lookup is the legacy-compat boundary for pre-ID project catalogs.
      const workspaceId = session.workspaceId
        ?? project.projectWorkspaceId
        ?? resolveLegacySessionWorkspace({ workspacePath: project.projectWorkspacePath },
          [...workspaceManager.getState().openedWorkspaces.values()])?.id;
      if (!workspaceId) throw new Error('Workspace ID is unavailable');
      if (session.archived) {
        const shouldRestore = await confirmWarning(
          t('management.sessions.restoreTitle'),
          t('management.sessions.restoreMessage', { name: session.sessionName }),
        );
        if (!shouldRestore) {
          return;
        }
        await sessionAPI.unarchiveSession(session.sessionId, workspaceId);
        await flowChatManager.refreshWorkspaceSessions({
          id: workspaceId,
        });
      }

      let opened = await openAgentCompanionSession(session.sessionId);
      if (!opened) {
        await flowChatManager.refreshWorkspaceSessions({
          id: workspaceId,
        });
        opened = await openAgentCompanionSession(session.sessionId);
      }
      if (!opened) {
        throw new Error('Associated session was not found after refreshing the workspace');
      }
    } catch {
      notificationService.error(t('management.sessions.openFailed'), {
        duration: 3200,
      });
    } finally {
      setOpeningSessionId(null);
    }
  }, [openingSessionId, t]);

  const renderSettings = () => {
    if (settingsLoading) {
      return <ConfigLoadingState label={t('settings.loading')} />;
    }

    if (!trustedSettings) {
      return (
        <ConfigRetryState
          message={t('settings.loadFailed')}
          retryLabel={t('settings.retry')}
          onRetry={() => void loadSettings()}
        />
      );
    }

    return (
      <>
        <ConfigPageSection
          title={t('settings.isolation.title')}
          description={t('settings.isolation.description')}
          extra={(
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateSettings(DEFAULT_SETTINGS)}
              disabled={saving || settingsEqual(settings, DEFAULT_SETTINGS)}
              leadingIcon={<RotateCcw size={14} aria-hidden />}
            >
              {t('settings.reset')}
            </Button>
          )}
        >
          <ConfigPageRow
            label={t('settings.rootPath.label')}
            description={t('settings.rootPath.description')}
          >
            <Input
              value={settings.rootPath}
              onChange={event => updateSettings({ rootPath: event.target.value })}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('settings.branchPrefix.label')}
            description={t('settings.branchPrefix.description')}
          >
            <Input
              value={settings.branchPrefix}
              onChange={event => updateSettings({ branchPrefix: event.target.value })}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('settings.copyChanges.label')}
            description={t('settings.copyChanges.description')}
            align="center"
          >
            <Switch
              checked={settings.copyLocalChanges}
              onChange={event => updateSettings({ copyLocalChanges: event.target.checked })}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('settings.autoDelete.label')}
            description={t('settings.autoDelete.description')}
            align="center"
          >
            <Switch
              checked={settings.autoDeleteEnabled}
              onChange={event => updateSettings({ autoDeleteEnabled: event.target.checked })}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('settings.autoDeleteLimit.label')}
            description={t('settings.autoDeleteLimit.description')}
            align="center"
          >
            <NumberInput
              value={settings.autoDeleteLimit}
              onValueChange={value => updateSettings({ autoDeleteLimit: value })}
              min={AUTO_DELETE_LIMIT_MIN}
              max={AUTO_DELETE_LIMIT_MAX}
              showButtons={false}
              disableWheel
              disabled={saving || !settings.autoDeleteEnabled}
            />
          </ConfigPageRow>
        </ConfigPageSection>
        <ConfigActionBar
          status={settingsMessage?.type === 'error'
            ? 'error'
            : saving
              ? 'saving'
              : settingsDirty
                ? 'unsaved'
                : 'saved'}
          statusMessage={settingsMessage?.text}
          saving={saving}
          saveDisabled={!settingsDirty}
          discardDisabled={!settingsDirty}
          saveLabel={t('settings.save')}
          onSave={() => void save()}
          onDiscard={discardSettings}
        />
      </>
    );
  };

  const renderWorktree = (
    project: WorktreeProjectSummary,
    worktree: WorktreeSummary,
  ) => {
    const blockCode = deletionBlockReason(worktree);
    const blockReason = (() => {
      switch (blockCode) {
        case 'locked':
          return t('management.protection.locked');
        case 'missing':
          return t('management.protection.missing');
        default:
          return null;
      }
    })();
    const sessionNames = worktree.sessions
      .map(session => session.sessionName)
      .join(', ');
    const branchLabel = worktree.branch
      ?? t('labels.detached', { commit: worktree.head.slice(0, 7) });
    const lifecycleLabel = (() => {
      switch (worktree.lifecycle) {
        case 'permanent':
          return t('management.lifecycle.permanent');
        case 'external':
          return t('management.lifecycle.external');
        default:
          return t('management.lifecycle.managed');
      }
    })();

    return (
      <article
        className={[
          'openbitfun-worktree-settings__worktree',
          removingWorktreeId === worktree.worktreeId
            && 'openbitfun-worktree-settings__worktree--removing',
        ].filter(Boolean).join(' ')}
        key={worktree.worktreeId}
        data-worktree-id={worktree.worktreeId}
      >
        <div className="openbitfun-worktree-settings__worktree-main">
          <div className="openbitfun-worktree-settings__worktree-copy">
            <div className="openbitfun-worktree-settings__worktree-heading">
              <h5 className="openbitfun-worktree-settings__worktree-title"><OverflowText>{branchLabel}</OverflowText></h5>
              <div className="openbitfun-worktree-settings__metadata">
                {worktree.lifecycle !== 'managed' && <span>{lifecycleLabel}</span>}
                {worktree.dirty && <span>{t('management.state.dirty')}</span>}
                {worktree.hasUnpublishedCommits && (
                  <span>{t('management.state.unpublishedCommits')}</span>
                )}
                {worktree.locked && <span>{t('management.state.locked')}</span>}
                {worktree.missing && <span>{t('management.state.missing')}</span>}
              </div>
            </div>
            <code className="openbitfun-worktree-settings__path" title={worktree.path}><OverflowText>
              {worktree.path}
            </OverflowText></code>
            {worktree.associatedSessionCount > 0 && (
              <div
                className="openbitfun-worktree-settings__sessions-summary"
                title={sessionNames}
              >
                <MessageSquareText size={13} aria-hidden />
                <span>
                  {t('management.sessions.summary', {
                    count: worktree.associatedSessionCount,
                  })}
                </span>
                <span className="openbitfun-worktree-settings__session-links">
                  {worktree.sessions.map(session => (
                    <button data-overflow-trigger
                      key={session.sessionId}
                      type="button"
                      className="openbitfun-worktree-settings__session-link"
                      disabled={openingSessionId !== null}
                      title={t('management.sessions.openLabel', {
                        name: session.sessionName,
                      })}
                      onClick={() => void openAssociatedSession(
                        project,
                        session,
                      )}
                    >
                      {openingSessionId === session.sessionId && (
                        <LoaderCircle
                          className="openbitfun-worktree-settings__session-link-spinner"
                          size={12}
                          aria-hidden
                        />
                      )}
                      <OverflowText>{session.sessionName}</OverflowText>
                      {session.archived && (
                        <OverflowText className="openbitfun-worktree-settings__session-link-state">
                          {t('management.sessions.status.archived')}
                        </OverflowText>
                      )}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </div>
          <div className="openbitfun-worktree-settings__delete-control">
            <Tooltip content={blockReason ?? t('management.delete.action')}>
              <IconButton
                tone="danger"
                size="sm"
                disabled={Boolean(blockCode) || deletingWorktreeId !== null}
                loading={deletingWorktreeId === worktree.worktreeId}
                title={blockReason ?? undefined}
                onClick={() => setDeleteTarget({
                  projectWorkspaceId: project.projectWorkspaceId,
                  projectWorkspacePath: project.projectWorkspacePath,
                  worktree,
                })}
                aria-label={t('management.delete.actionLabel', { path: worktree.path })}
                icon={<Icon name="delete" size="sm" aria-hidden />}
              />
            </Tooltip>
          </div>
        </div>
      </article>
    );
  };

  const renderProjectsSkeleton = () => (
    <div className="openbitfun-worktree-settings__skeleton">
      <span className="openbitfun-sr-only" role="status">
        {t('management.loading')}
      </span>
      <div className="openbitfun-worktree-settings__skeleton-header" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="openbitfun-worktree-settings__skeleton-list" aria-hidden="true">
        {[0, 1, 2].map(index => (
          <div className="openbitfun-worktree-settings__skeleton-row" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );

  const renderProjects = () => {
    if (!projectsInitialized && projectsLoading) {
      return renderProjectsSkeleton();
    }
    if (projects.length === 0 && !projectsMessage) {
      return (
        <ConfigEmptyState
          className="openbitfun-worktree-settings__empty"
          icon={<FolderGit2 aria-hidden />}
          title={t('management.empty.title')}
          description={t('management.empty.description')}
        />
      );
    }
    if (projects.length === 0) {
      return null;
    }

    return (
      <div className="openbitfun-worktree-settings__projects">
        {projects.map(project => (
          <section
            className="openbitfun-worktree-settings__project"
            data-openbitfun-component="worktree-settings"
            data-openbitfun-part="project"
            key={project.projectWorkspacePath}
          >
            <header className="openbitfun-worktree-settings__project-header">
              <div className="openbitfun-worktree-settings__project-identity">
                <h4>{workspaceName(project.projectWorkspacePath)}</h4>
                <code title={project.projectWorkspacePath}><OverflowText>
                  {project.projectWorkspacePath}
                </OverflowText></code>
              </div>
              <span>
                {t('management.worktreeCount', { count: project.worktrees.length })}
              </span>
            </header>
            <div
              className="openbitfun-worktree-settings__worktree-list"
              data-openbitfun-component="worktree-settings"
              data-openbitfun-part="worktreeList"
            >
              {project.worktrees.map(worktree => renderWorktree(project, worktree))}
            </div>
          </section>
        ))}
      </div>
    );
  };

  const deletingWithLocalWork = Boolean(
    deleteTarget?.worktree.dirty || deleteTarget?.worktree.hasUnpublishedCommits,
  );
  const deletingWithSessions = Boolean(deleteTarget?.worktree.associatedSessionCount);
  const deleteMessage = (() => {
    if (deletingWithLocalWork && deletingWithSessions) {
      return t('management.delete.forceMessageWithSessions');
    }
    if (deletingWithLocalWork) {
      return t('management.delete.forceMessage');
    }
    if (deletingWithSessions) {
      return t('management.delete.messageWithSessions');
    }
    return t('management.delete.message');
  })();

  return (
    <ConfigPageLayout
      className="openbitfun-worktree-settings"
      data-openbitfun-component="worktree-settings"
      data-openbitfun-part="root"
    >
      <ConfigPageHeader
        icon={<Icon name="git" size="lg" aria-hidden />}
        title={t('settings.title')}
        subtitle={t('settings.description')}
      />
      <ConfigPageContent>
        {renderSettings()}
        <ConfigPageSection
          className="openbitfun-worktree-settings__management-section"
          bodySurface={false}
          title={t('management.title')}
          description={t('management.description')}
          extra={(
            <ConfigRefreshButton
              tooltip={t('management.refresh')}
              onClick={() => void loadProjects()}
              loading={projectsLoading}
              disabled={deletingWorktreeId !== null}
            />
          )}
        >
          <ConfigMessage message={projectsMessage} />
          {projectsMessage?.type === 'error' && projects.length === 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadProjects()}
            >
              {t('management.retry')}
            </Button>
          )}
          <div
            ref={projectsResultsRef}
            data-openbitfun-component="worktree-settings"
            data-openbitfun-part="results"
            className={[
              'openbitfun-worktree-settings__results',
              projectsLoading
                && projectsInitialized
                && 'openbitfun-worktree-settings__results--refreshing',
            ].filter(Boolean).join(' ')}
            aria-busy={projectsLoading}
          >
            {projectsLoading && projectsInitialized && (
              <>
                <div
                  className="openbitfun-worktree-settings__refresh-progress"
                  aria-hidden="true"
                >
                  <span />
                </div>
                <span className="openbitfun-sr-only" role="status">
                  {t('management.loading')}
                </span>
              </>
            )}
            {renderProjects()}
          </div>
        </ConfigPageSection>
      </ConfigPageContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title={deletingWithLocalWork
          ? t('management.delete.forceTitle')
          : t('management.delete.title')}
        message={deleteMessage}
        preview={deleteTarget?.worktree.path}
        type={deletingWithLocalWork ? 'error' : 'warning'}
        confirmDanger
        confirmText={deletingWithLocalWork
          ? t('management.delete.forceAction')
          : t('management.delete.action')}
        cancelText={t('management.delete.cancel')}
      />
    </ConfigPageLayout>
  );
};

export default WorktreeSettingsPage;
