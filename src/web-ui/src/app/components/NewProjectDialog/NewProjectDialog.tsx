/** A named project groups one primary folder and its associated folders. */
import {
  ActionCard, Button, Card, CardBody, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter,
  DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, Input, OverflowText, Select,
} from '@openbitfun/ui';
import { FolderPlus, Server } from 'lucide-react';
import React, { useState, useCallback, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { DEFAULT_PROJECT_SUBDIRECTORY, ProjectDirectoryUnavailableError, projectFolderKey, projectFolderName, type ProjectDraft, type ProjectFolder } from '@/app/utils/projectDraft';
import { createLogger } from '@/shared/utils/logger';
import { ProjectFolderItem, ProjectFolderList } from '@/app/components/ProjectFolderList/ProjectFolderList';
import './NewProjectDialog.scss';

const log = createLogger('NewProjectDialog');

export interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (draft: ProjectDraft) => Promise<boolean>;
  defaultParentPath?: string;
  onPickRemoteFolder?: (existing?: ProjectFolder) => Promise<ProjectFolder | null>;
  onSelectRemoteHost?: () => Promise<NonNullable<ProjectFolder['remote']> | null>;
  /** Sidebar entry starts with a choice when assistant creation is available. */
  onCreateAssistant?: () => Promise<void>;
  'data-testid'?: string;
}

export const NewProjectDialog: React.FC<NewProjectDialogProps> = ({
  isOpen, onClose, onConfirm, defaultParentPath, onPickRemoteFolder, onSelectRemoteHost, onCreateAssistant, 'data-testid': testId,
}) => {
  const { t } = useTranslation('common');
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [projectName, setProjectName] = useState('');
  const [source, setSource] = useState('host');
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
  const nameHint = invalidDirectoryName ? t('newProject.invalidDirectoryName')
    : folders.length === 1 ? t('newProject.singleFolderNameHint')
    : hasFolders ? t('newProject.groupNameHint') : undefined;
  const savePath = `~/${DEFAULT_PROJECT_SUBDIRECTORY}/${name}`;
  const saveLocation = `${t(source === 'remote' ? 'newProject.emptyRemoteProjectHint' : 'newProject.emptyProjectHint')} ${savePath}`;

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      formSurface.current = getActiveSurfaceScope();
      setFolders([]);
      setProjectName('');
      setSource('host');
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

  const changeStep = (next: typeof step) => {
    if (busy || submissionPending.current) return;
    setError('');
    setStep(next);
  };

  const handleAddFolder = useCallback(async () => {
    if (busy) return;
    setIsSelecting(true);
    setError('');
    try {
      formSurface.current.assertCurrent('select project folder');
      let folder: ProjectFolder | null = null;
      if (source === 'remote') {
        if (!onPickRemoteFolder) throw new Error(t('newProject.remoteUnavailable'));
        folder = await onPickRemoteFolder(folders[0]);
      } else {
        const { pickWorkspaceDirectory } = await import(
          '@/infrastructure/peer-device/pickWorkspaceDirectory'
        );
        formSurface.current.assertCurrent('browse project folder');
        const path = await pickWorkspaceDirectory({
          title: t('newProject.selectSourceFolder'),
          defaultPath: folders.at(-1)?.path || defaultParentPath,
        });
        if (path) folder = { path };
      }
      formSurface.current.assertCurrent('accept project folder');
      if (!folder) return;
      if (folders.length && folders[0].remote?.connectionId !== folder.remote?.connectionId) {
        throw new Error(t('newProject.sameHostRequired'));
      }
      const selected = folder;
      setFolders(current => current.some(item => projectFolderKey(item) === projectFolderKey(selected))
        ? current : [...current, selected]);
    } catch (error) {
      log.error('Failed to select project directory', error);
      setError(error instanceof Error ? error.message : t('newProject.errorSelectDirectory'));
    } finally {
      setIsSelecting(false);
    }
  }, [busy, source, folders, defaultParentPath, onPickRemoteFolder, t]);

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
    if (busy || submissionPending.current || step !== 'project' || (needsName && !name) || invalidDirectoryName) return;
    submissionPending.current = true;
    setIsCreating(true);
    setError('');
    try {
      formSurface.current.assertCurrent('submit project setup');
      let remote: ProjectFolder['remote'];
      if (folders.length === 0 && source === 'remote') {
        if (!onSelectRemoteHost) throw new Error(t('newProject.remoteUnavailable'));
        const selected = await onSelectRemoteHost();
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
        : error instanceof Error ? error.message : t('newProject.errorCreateFailed'));
    } finally {
      submissionPending.current = false;
      setIsCreating(false);
    }
  }, [busy, needsName, name, invalidDirectoryName, folders, onConfirm, onClose, source, onSelectRemoteHost, step, t]);

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
              <section className="new-project-dialog__field" aria-labelledby={sourceLabelId} data-openbitfun-component="new-project-dialog" data-openbitfun-part="field">
                <div className="new-project-dialog__section-heading">
                  <div className="new-project-dialog__source-heading">
                    <h3 id={sourceLabelId} className="new-project-dialog__source-label">{t('newProject.sourceFolder')}</h3>
                    <div className="new-project-dialog__source-control">
                      {onPickRemoteFolder ? (
                        <Select aria-label={t('newProject.folderSource')} value={source} size="sm" width="content" popupWidth="content" disabled={busy || hasFolders}
                          options={[{ value: 'host', label: t('newProject.hostFolders') }, { value: 'remote', label: t('newProject.remoteFolders') }]}
                          onValueChange={value => { setSource(String(value)); setError(''); }} />
                      ) : <span className="new-project-dialog__hint">{t('newProject.hostFolders')}</span>}
                    </div>
                  </div>
                  <span className="new-project-dialog__hint">{t('newProject.sourceFoldersHint')}</span>
                </div>
                <div data-openbitfun-component="new-project-dialog" data-openbitfun-part="pathSelector">
                  <Card appearance="neutral" radius="lg">
                    <CardBody className="new-project-dialog__folder" data-filled={hasFolders} align="stretch" padding="md">
                      <div className="new-project-dialog__folder-toolbar">
                        <Button variant="fill" size="sm" leadingIcon={<Icon glyph={FolderPlus} size="sm" />} onClick={handleAddFolder} disabled={busy} loading={isSelecting}>
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
            <Button type="submit" form={formId} variant="primary" disabled={busy || (needsName && !name) || invalidDirectoryName} loading={isCreating}>
              {isCreating ? t('newProject.creating') : onCreateAssistant ? projectTitle : t('newProject.create')}
            </Button>
          </div>
        </DialogFooter>
      )}
    </Dialog>
  );
};
