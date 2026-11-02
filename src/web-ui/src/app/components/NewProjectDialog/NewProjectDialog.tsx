/** A named project groups one primary folder and its associated folders. */
import {
  ActionCard, Button, Card, CardBody, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter,
  DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, Input, OverflowText, Tooltip,
} from '@openbitfun/ui';
import { FolderPlus, Server } from 'lucide-react';
import React, { useState, useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { globalAPI, type WorkspaceInfo } from '@/infrastructure/api/service-api/GlobalAPI';
import type { WorkspaceConnectionTarget } from '@/features/ssh-remote/types';
import { WorkspaceSourceSelector } from '@/features/ssh-remote/WorkspaceSourceSelector';
import { WorkspaceChoiceCapsules } from '@/features/ssh-remote/WorkspaceChoiceCapsules';
import { useWorkspaceSourceOptions, workspacePresetHost, type WorkspaceConnectionPreset, type WorkspaceSourceOption } from '@/features/ssh-remote/useWorkspaceSourceOptions';
import { workspaceSourceCoordinates, type WorkspaceSource } from '@/features/ssh-remote/workspaceSource';
import { AssistantProjectFolderError, DEFAULT_PROJECT_SUBDIRECTORY, ProjectDirectoryUnavailableError, projectFolderKey, projectFolderName, type ProjectDraft, type ProjectFolder } from '@/app/utils/projectDraft';
import { createLogger } from '@/shared/utils/logger';
import { ProjectFolderItem, ProjectFolderList } from '@/app/components/ProjectFolderList/ProjectFolderList';
import './NewProjectDialog.scss';

const log = createLogger('NewProjectDialog');

export interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (draft: ProjectDraft) => Promise<boolean>;
  defaultParentPath?: string;
  onPickRemoteFolder?: (target: WorkspaceConnectionTarget, existing?: ProjectFolder, preset?: WorkspaceConnectionPreset) => Promise<ProjectFolder | null>;
  onSelectRemoteHost?: (target: WorkspaceConnectionTarget, preset?: WorkspaceConnectionPreset) => Promise<NonNullable<ProjectFolder['remote']> | null>;
  /** Sidebar entry starts with a choice when assistant creation is available. */
  onCreateAssistant?: () => Promise<void>;
  'data-testid'?: string;
}

export const NewProjectDialog: React.FC<NewProjectDialogProps> = ({
  isOpen, onClose, onConfirm, defaultParentPath, onPickRemoteFolder, onSelectRemoteHost, onCreateAssistant, 'data-testid': testId,
}) => {
  const { t } = useI18n('common');
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [recentError, setRecentError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [wslSupported, setWslSupported] = useState(false);
  const [source, setSource] = useState<WorkspaceSource>('host');
  const [selectedOption, setSelectedOption] = useState<string>();
  const [selectedHostOption, setSelectedHostOption] = useState<string>();
  const [connectedRemote, setConnectedRemote] = useState<ProjectFolder['remote']>();
  const [isCreating, setIsCreating] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'choice' | 'project'>(onCreateAssistant ? 'choice' : 'project');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const assistantChoiceRef = useRef<HTMLButtonElement>(null);
  const submissionPending = useRef(false);
  const wasOpen = useRef(false);
  const formSurface = useRef(getActiveSurfaceScope());
  const formId = useId();
  const sourceLabelId = useId();
  const nameHintId = useId();
  const busy = isCreating || isSelecting;
  const name = projectName.trim();
  const needsName = folders.length !== 1;
  const invalidDirectoryName = folders.length === 0 && (/[\\/]/.test(name) || name === '.' || name === '..');
  const hasFolders = folders.length > 0;
  const nameHint = invalidDirectoryName ? t('newProject.invalidDirectoryName') : undefined;
  const savePath = `~/${DEFAULT_PROJECT_SUBDIRECTORY}/${name}`;
  const { location, environment } = workspaceSourceCoordinates(source);
  const optionsEnabled = isOpen && step === 'project' && Boolean(onPickRemoteFolder);
  const hostOptions = useWorkspaceSourceOptions('ssh', optionsEnabled && location === 'other');
  const selectedHost = hostOptions.options.find(option => option.id === selectedHostOption);
  const environmentOptions = useWorkspaceSourceOptions(source, optionsEnabled && source !== 'host' && source !== 'ssh', selectedHost?.preset);
  const sourceOptions = source === 'ssh' ? hostOptions : environmentOptions;
  const connectionPreset = useMemo<WorkspaceConnectionPreset | undefined>(() => source === 'ssh' ? selectedHost?.preset
    : sourceOptions.options.find(option => option.id === selectedOption)?.preset
      ?? (source === 'remoteDocker' && selectedHost ? { kind: 'new', host: workspacePresetHost(selectedHost.preset), credentialConnectionId: selectedHost.preset.credentialConnectionId } : undefined),
  [source, selectedHost, sourceOptions.options, selectedOption]);
  const showEnvironment = location === 'current' || Boolean(selectedHost);
  const sourceReady = (source !== 'wsl' || wslSupported) && (hasFolders || (showEnvironment && (source === 'host' || (source === 'ssh' ? Boolean(selectedHost) : Boolean(selectedOption && sourceOptions.options.some(option => option.id === selectedOption)) || Boolean(connectedRemote)))));
  const environmentLabel = environment === 'wsl' ? t('workspaceSource.wsl')
    : environment === 'container' ? t('workspaceSource.container') : t('workspaceSource.system');
  const saveLocation = `${source === 'host' ? t('newProject.emptyProjectHint')
    : `${t(location === 'current' ? 'workspaceSource.currentHost' : 'workspaceSource.otherHost')} / ${environmentLabel}`} ${savePath}`;

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      formSurface.current = getActiveSurfaceScope();
      setFolders([]);
      setProjectName('');
      setSource('host');
      setSelectedOption(undefined);
      setSelectedHostOption(undefined);
      setConnectedRemote(undefined);
      setError('');
      setStep(onCreateAssistant ? 'choice' : 'project');
    }
    wasOpen.current = isOpen;
  }, [isOpen, onCreateAssistant]);

  useEffect(() => {
    if (!isOpen) return;
    if (step === 'project') nameInputRef.current?.focus();
    else assistantChoiceRef.current?.focus();
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen || step !== 'project' || !onPickRemoteFolder) return;
    const scope = getActiveSurfaceScope();
    let cancelled = false;
    setRecentWorkspaces([]);
    setRecentError('');
    void globalAPI.getRecentWorkspaces().then(workspaces => {
      if (cancelled || !scope.isCurrent()) return;
      const paths = new Set<string>();
      setRecentWorkspaces(workspaces
        .filter(workspace => workspace.workspaceKind.toLowerCase() === 'normal'
          && !workspace.connectionId && (!workspace.sshHost || workspace.sshHost === 'localhost') && workspace.rootPath)
        .sort((a, b) => (Date.parse(b.lastAccessed) || 0) - (Date.parse(a.lastAccessed) || 0))
        .filter(workspace => {
          const key = projectFolderKey({ path: workspace.rootPath });
          if (paths.has(key)) return false;
          paths.add(key);
          return true;
        }).slice(0, 5));
    }).catch(cause => {
      if (cancelled || !scope.isCurrent()) return;
      log.error('Failed to load recent project workspaces', cause);
      setRecentError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [isOpen, step, onPickRemoteFolder]);

  const changeStep = (next: typeof step) => {
    if (busy || submissionPending.current) return;
    setError('');
    setStep(next);
  };

  const handleAddFolder = useCallback(async () => {
    if (busy || sourceOptions.loading || !sourceReady) return;
    setIsSelecting(true);
    setError('');
    try {
      formSurface.current.assertCurrent('select project folder');
      let folder: ProjectFolder | null = null;
      if (source !== 'host') {
        if (!onPickRemoteFolder) throw new Error(t('newProject.remoteUnavailable'));
        folder = connectedRemote && !folders.length
          ? await onPickRemoteFolder(source, { path: '', remote: connectedRemote })
          : connectionPreset && !folders.length
          ? await onPickRemoteFolder(source, undefined, connectionPreset)
          : await onPickRemoteFolder(source, folders[0]);
      } else {
        const { pickWorkspaceDirectory } = await import('@/infrastructure/peer-device/pickWorkspaceDirectory');
        formSurface.current.assertCurrent('browse project folder');
        const path = await pickWorkspaceDirectory({ title: t('newProject.selectSourceFolder'), defaultPath: folders.at(-1)?.path || defaultParentPath });
        if (path) folder = { path };
      }
      formSurface.current.assertCurrent('accept project folder');
      if (!folder) return;
      if (folders.length && folders[0].remote?.connectionId !== folder.remote?.connectionId) throw new Error(t('newProject.sameHostRequired'));
      const selected = folder;
      setFolders(current => current.some(item => projectFolderKey(item) === projectFolderKey(selected)) ? current : [...current, selected]);
    } catch (cause) {
      log.error('Failed to select project directory', cause);
      setError(cause instanceof Error ? cause.message : t('newProject.errorSelectDirectory'));
    } finally { setIsSelecting(false); }
  }, [busy, sourceOptions.loading, source, folders, defaultParentPath, onPickRemoteFolder, t, connectionPreset, connectedRemote, sourceReady]);

  const handleCreateAssistant = useCallback(async () => {
    if (busy || submissionPending.current || !onCreateAssistant) return;
    submissionPending.current = true;
    setIsCreating(true);
    setError('');
    try {
      formSurface.current.assertCurrent('create assistant');
      await onCreateAssistant();
      formSurface.current.assertCurrent('finish assistant creation');
      onClose();
    } catch (error) {
      log.error('Failed to create assistant', error);
      setError(error instanceof Error ? error.message : t('newWorkspace.assistantError'));
    } finally {
      submissionPending.current = false;
      setIsCreating(false);
    }
  }, [busy, onCreateAssistant, onClose, t]);

  const handleConfirm = useCallback(async () => {
    if (busy || sourceOptions.loading || !sourceReady || submissionPending.current || step !== 'project' || (needsName && !name) || invalidDirectoryName) return;
    submissionPending.current = true;
    setIsCreating(true);
    setError('');
    try {
      formSurface.current.assertCurrent('submit project setup');
      let remote: ProjectFolder['remote'] = folders.length === 0 ? connectedRemote : undefined;
      if (folders.length === 0 && source !== 'host' && !remote) {
        if (!onSelectRemoteHost) throw new Error(t('newProject.remoteUnavailable'));
        const selected = connectionPreset ? await onSelectRemoteHost(source, connectionPreset) : await onSelectRemoteHost(source);
        formSurface.current.assertCurrent('accept new remote project host');
        if (!selected) return;
        remote = selected;
      }
      const succeeded = await onConfirm({ name, folders, ...(remote ? { remote } : {}) });
      if (succeeded) onClose();
    } catch (error) {
      log.error('Failed to submit project setup', error);
      setError(error instanceof ProjectDirectoryUnavailableError
        ? t('newProject.defaultDirectoryUnavailable')
        : error instanceof AssistantProjectFolderError ? t('newProject.assistantFolderUnavailable')
        : error instanceof Error ? error.message : t('newProject.errorCreateFailed'));
    } finally {
      submissionPending.current = false;
      setIsCreating(false);
    }
  }, [busy, needsName, name, invalidDirectoryName, folders, onConfirm, onClose, source, onSelectRemoteHost, step, t, connectionPreset, connectedRemote, sourceOptions.loading, sourceReady]);

  const handleConfigureSource = async (target: WorkspaceConnectionTarget) => {
    if (busy || hasFolders || !onSelectRemoteHost || (target === 'wsl' && !wslSupported)) return;
    setIsSelecting(true);
    setError('');
    try {
      formSurface.current.assertCurrent('configure project source');
      const host = target === 'remoteDocker' ? workspacePresetHost(selectedHost?.preset) : undefined;
      const remote = await onSelectRemoteHost(target, { kind: 'new', ...(host ? { host, ...(selectedHost?.preset.credentialConnectionId ? { credentialConnectionId: selectedHost.preset.credentialConnectionId } : {}) } : {}) });
      formSurface.current.assertCurrent('accept configured project source');
      if (remote) {
        if (target === 'ssh') {
          setSelectedHostOption(remote.connectionId);
          setSelectedOption(undefined);
          setConnectedRemote(undefined);
          hostOptions.refresh();
        } else {
          setSelectedOption(remote.connectionId);
          environmentOptions.refresh();
        }
        if (target === source) setConnectedRemote(remote);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('newProject.errorSelectDirectory'));
    } finally { setIsSelecting(false); }
  };

  const handleEditSource = async (option: WorkspaceSourceOption, target: WorkspaceConnectionTarget) => {
    if (busy || hasFolders || !onSelectRemoteHost || (target === 'wsl' && !wslSupported)) return;
    setIsSelecting(true);
    setError('');
    try {
      formSurface.current.assertCurrent('edit project source');
      await onSelectRemoteHost(target, { ...option.preset, edit: true });
      formSurface.current.assertCurrent('accept edited project source');
      if (target === 'ssh') {
        hostOptions.refresh();
        if (selectedHostOption === option.id) {
          setConnectedRemote(undefined);
        }
        if (selectedHostOption === option.id && source !== 'ssh') {
          setSelectedOption(undefined);
          setConnectedRemote(undefined);
        }
      }
      else {
        environmentOptions.refresh();
        if (selectedOption === option.id) setConnectedRemote(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('newProject.errorSelectDirectory'));
    } finally { setIsSelecting(false); }
  };

  const optionActions = (options: typeof sourceOptions, target: WorkspaceConnectionTarget) => <>
      {onSelectRemoteHost && <Tooltip content={t('ssh.remote.newConnection')}><IconButton variant="quiet" size="xs" disabled={busy || hasFolders || (target === 'remoteDocker' && !selectedHost)}
        icon={<Icon name="plus" size="xs" />} aria-label={t('ssh.remote.newConnection')}
        onClick={() => void handleConfigureSource(target)} /></Tooltip>}
      <Tooltip content={t('workspaceSource.refreshOptions')}>
      <IconButton size="xs" variant="quiet" icon={<Icon name="refresh" size="xs" />}
        aria-label={t('workspaceSource.refreshOptions')} loading={options.loading} disabled={busy || hasFolders}
        onClick={() => { setConnectedRemote(undefined); options.refresh(); }} />
      </Tooltip>
    </>;
  const optionChoices = (options: typeof sourceOptions, target: WorkspaceConnectionTarget, value: string | undefined, onChange: (id: string | undefined) => void) => <div className="new-project-dialog__source-options" aria-busy={options.loading}>
    {options.options.length > 0 && <WorkspaceChoiceCapsules label={t('workspaceSource.availableOptions')} value={value}
      onEdit={onSelectRemoteHost ? id => {
        const option = options.options.find(item => item.id === id);
        if (option) void handleEditSource(option, target);
      } : undefined}
      choices={options.options} disabled={busy || hasFolders} onValueChange={value => {
        onChange(value);
        if (value !== connectedRemote?.connectionId) setConnectedRemote(undefined);
      }} />}
    {options.loading && options.options.length === 0 && <span className="new-project-dialog__source-status" role="status">{t('app.loading')}</span>}
    {!options.loading && options.options.length === 0 && !options.error
      && <span className="new-project-dialog__source-status" role="status">{t(target === 'remoteDocker' && !selectedHost
        ? 'workspaceSource.selectHostHint' : 'workspaceSource.noAvailableOptions')}</span>}
    {options.error && <span className="new-project-dialog__source-status" role="alert">{options.error}</span>}
  </div>;

  const projectTitle = t(onCreateAssistant ? 'newWorkspace.createProject' : 'newProject.title');

  return (
    <Dialog open={isOpen} onOpenChange={() => { if (!busy) onClose(); }}
      initialFocusRef={step === 'choice' ? assistantChoiceRef : nameInputRef}
      size="md" data-testid={testId}>
      <DialogHeader>
        <DialogHeading>
          <DialogTitle data-openbitfun-component="new-project-dialog" data-openbitfun-part="title">
            {step === 'choice' ? t('newWorkspace.title') : projectTitle}
          </DialogTitle>
          {step === 'choice' && <DialogDescription>{t('newWorkspace.description')}</DialogDescription>}
        </DialogHeading>
        <DialogClose aria-label={t('actions.close')} disabled={busy} />
      </DialogHeader>
      <DialogBody className="new-project-dialog__body">
        {step === 'choice' && (
          <div className="new-project-dialog__choices" data-openbitfun-component="new-project-dialog" data-openbitfun-part="choices">
            <ActionCard ref={assistantChoiceRef} size="md" className="new-project-dialog__choice-card"
              triggerClassName="new-project-dialog__choice-trigger" leading={<Icon name="user" size="md" />}
              aria-label={t('newWorkspace.createAssistant')} aria-busy={isCreating} disabled={busy}
              onClick={handleCreateAssistant} data-testid="nav-session-group-add-assistant"
              body={(
                <span className="new-project-dialog__choice-content">
                  <span className="new-project-dialog__choice-title">{t('newWorkspace.assistantTitle')}</span>
                  <span className="new-project-dialog__choice-description" aria-live="polite">
                    {t(isCreating ? 'newProject.creating' : 'newWorkspace.assistantDescription')}
                  </span>
                </span>
              )} />
            <ActionCard size="md" className="new-project-dialog__choice-card"
              triggerClassName="new-project-dialog__choice-trigger" leading={<Icon name="folder" size="md" />}
              aria-label={t('newWorkspace.createProject')} disabled={busy}
              onClick={() => changeStep('project')} data-testid="nav-session-group-add-project"
              body={(
                <span className="new-project-dialog__choice-content">
                  <span className="new-project-dialog__choice-title">{t('newWorkspace.projectTitle')}</span>
                  <span className="new-project-dialog__choice-description">{t('newWorkspace.projectDescription')}</span>
                </span>
              )} />
          </div>
        )}
        {step === 'project' && (
          <form id={formId} data-openbitfun-component="new-project-dialog" data-openbitfun-part="root" className="new-project-dialog" aria-busy={busy}
            onSubmit={event => { event.preventDefault(); void handleConfirm(); }}>
            <div data-openbitfun-component="new-project-dialog" data-openbitfun-part="content" className="new-project-dialog__content">
              <div className="new-project-dialog__field" data-openbitfun-component="new-project-dialog" data-openbitfun-part="field">
                <Input ref={nameInputRef} className="new-project-dialog__name-input" size="lg" leading={<Icon name="folder" size="md" />}
                  aria-label={t('newProject.projectName')} aria-describedby={nameHint ? nameHintId : undefined}
                  value={projectName} onChange={event => { setProjectName(event.target.value); setError(''); }}
                  placeholder={folders.length === 1 ? projectFolderName(folders[0].path) : t('newProject.projectNamePlaceholder')}
                  disabled={busy} invalid={invalidDirectoryName} autoComplete="off" />
                {nameHint && <div id={nameHintId} className="new-project-dialog__hint">{nameHint}</div>}
              </div>
              {onPickRemoteFolder && (
                <div className="new-project-dialog__field" data-openbitfun-component="new-project-dialog" data-openbitfun-part="field">
                  <WorkspaceSourceSelector onWslSupportChange={setWslSupported} value={source} disabled={busy || hasFolders} showEnvironment={showEnvironment}
                    showCurrentDevice={source !== 'host' || recentWorkspaces.length === 0}
                    locationOptions={location === 'other' ? optionChoices(hostOptions, 'ssh', selectedHostOption, value => {
                      setSelectedHostOption(value); setSelectedOption(undefined);
                    }) : source === 'host' ? <>
                      {recentWorkspaces.length > 0 && <WorkspaceChoiceCapsules label={t('workspaceSource.availableOptions')}
                        choices={recentWorkspaces.map(workspace => ({ id: workspace.id, label: workspace.name || projectFolderName(workspace.rootPath), description: workspace.rootPath }))}
                        value={recentWorkspaces.find(workspace => folders.some(folder => projectFolderKey(folder) === projectFolderKey({ path: workspace.rootPath })))?.id}
                        disabled={busy || hasFolders} onValueChange={id => {
                          if (busy || hasFolders) return;
                          try {
                            formSurface.current.assertCurrent('select recent project workspace');
                            const workspace = recentWorkspaces.find(item => item.id === id);
                            if (workspace) { setFolders([{ path: workspace.rootPath }]); setError(''); }
                          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                        }} />}
                      {recentError && <span className="new-project-dialog__source-status" role="alert">{recentError}</span>}
                    </> : undefined}
                    environmentOptions={source !== 'host' && source !== 'ssh' ? optionChoices(environmentOptions, source, selectedOption, setSelectedOption) : undefined}
                    locationActions={location === 'other' ? optionActions(hostOptions, 'ssh') : undefined}
                    environmentActions={source !== 'host' && source !== 'ssh' && (source !== 'wsl' || wslSupported) ? optionActions(environmentOptions, source) : undefined}
                    onValueChange={value => {
                      if (workspaceSourceCoordinates(value).location !== location) setSelectedHostOption(undefined);
                      setSource(value); setSelectedOption(undefined); setConnectedRemote(undefined); setError('');
                    }} />
                  {hasFolders && <span className="new-project-dialog__hint">{t('workspaceSource.foldersLockedHint')}</span>}
                </div>
              )}
              <section className="new-project-dialog__field" aria-labelledby={sourceLabelId} data-openbitfun-component="new-project-dialog" data-openbitfun-part="field">
                <div className="new-project-dialog__section-heading">
                  <h3 id={sourceLabelId} className="new-project-dialog__source-label">{t('newProject.sourceFolder')}</h3>
                </div>
                <div data-openbitfun-component="new-project-dialog" data-openbitfun-part="pathSelector" aria-disabled={!sourceReady}
                  className={!sourceReady ? 'new-project-dialog__paths--disabled' : undefined}>
                  <Card appearance="neutral" radius="lg">
                    <CardBody className="new-project-dialog__folder" data-filled={hasFolders} align="stretch" padding="md">
                      <div className="new-project-dialog__folder-toolbar">
                        <Button variant="fill" size="sm" leadingIcon={<Icon glyph={FolderPlus} size="sm" />} onClick={handleAddFolder} disabled={busy || sourceOptions.loading || !sourceReady} loading={isSelecting}>
                          {t('actions.add')}
                        </Button>
                      </div>
                      {hasFolders && (
                        <ProjectFolderList label={t('newProject.sourceFolder')} scrollable>
                          {folders.map(folder => (
                            <ProjectFolderItem key={projectFolderKey(folder)} name={projectFolderName(folder.path)}
                              path={`${folder.remote ? `${folder.remote.connectionName}: ` : ''}${folder.path}`}
                              leading={folder.remote ? <Icon glyph={Server} size="sm" /> : undefined}
                              actions={(
                                <IconButton icon={<Icon name="xmark" size="sm" />} size="xs" variant="quiet"
                                  aria-label={t('newProject.removeFolder', { name: projectFolderName(folder.path) })} disabled={busy}
                                  onClick={() => { setFolders(current => current.filter(item => projectFolderKey(item) !== projectFolderKey(folder))); setError(''); }} />
                              )} />
                          ))}
                        </ProjectFolderList>
                      )}
                    </CardBody>
                  </Card>

                </div>
                {!hasFolders && name && !invalidDirectoryName && (
                  <OverflowText className="new-project-dialog__save-location" title={saveLocation}>{saveLocation}</OverflowText>
                )}
              </section>
            </div>
          </form>
        )}
        {error && <div role="alert" data-openbitfun-component="new-project-dialog" data-openbitfun-part="error" className="new-project-dialog__error"><Icon name="info" size="sm" /><span>{error}</span></div>}
      </DialogBody>
      {step === 'project' && (
        <DialogFooter className="new-project-dialog__footer" data-openbitfun-component="new-project-dialog" data-openbitfun-part="footer">
          {onCreateAssistant && (
            <Button variant="fill" leadingIcon={<Icon name="arrow-left" size="sm" />} disabled={busy} onClick={() => changeStep('choice')}>
              {t('newWorkspace.back')}
            </Button>
          )}
          <div className="new-project-dialog__primary-actions">
            {!onCreateAssistant && <Button variant="fill" onClick={onClose} disabled={busy}>{t('newProject.cancel')}</Button>}
            <Button type="submit" form={formId} variant="primary" disabled={busy || sourceOptions.loading || !sourceReady || (needsName && !name) || invalidDirectoryName} loading={isCreating}>
              {isCreating ? t('newProject.creating') : onCreateAssistant ? projectTitle : t('newProject.create')}
            </Button>
          </div>
        </DialogFooter>
      )}
    </Dialog>
  );
};
