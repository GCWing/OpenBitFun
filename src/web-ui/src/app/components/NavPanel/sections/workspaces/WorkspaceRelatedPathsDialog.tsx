import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FormSection,
  IconButton,
  LoadingState,
  OverflowText,
  StatusPill,
  Icon,
  Input,
  Textarea,
  Dialog,
  Disclosure,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import {
  externalSourcesAPI,
  type WorkspaceReferenceEntry,
  type WorkspaceReferenceSnapshot,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { sshApi } from '@/features/ssh-remote/sshApi';
import RemoteFileBrowser from '@/features/ssh-remote/RemoteFileBrowser';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteWorkspace, type RelatedPath, type WorkspaceInfo } from '@/shared/types';
import { FolderOpen, FolderPlus, Server } from 'lucide-react';
import { ProjectFolderItem, ProjectFolderList } from '@/app/components/ProjectFolderList/ProjectFolderList';
import './WorkspaceRelatedPathsDialog.scss';

const log = createLogger('WorkspaceRelatedPathsDialog');

interface WorkspaceRelatedPathsDialogProps {
  workspace: WorkspaceInfo;
  isOpen: boolean;
  onClose: () => void;
}

interface DraftRelatedPath {
  id: string;
  path: string;
  description: string;
}

type WorkspaceReferenceDiagnostic = NonNullable<WorkspaceReferenceSnapshot['diagnostics']>[number];

function createDraft(path?: Partial<RelatedPath>): DraftRelatedPath {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    path: path?.path ?? '',
    description: path?.description ?? '',
  };
}

function normalizeDrafts(drafts: DraftRelatedPath[]): RelatedPath[] {
  return drafts.map(draft => ({
    path: draft.path.trim(),
    ...(draft.description.trim()
      ? { description: draft.description.trim() }
      : {}),
  }));
}

export const WorkspaceRelatedPathsDialog: React.FC<WorkspaceRelatedPathsDialogProps> = ({
  workspace,
  isOpen,
  onClose,
}) => {
  const { t } = useI18n('common');
  const { updateWorkspaceRelatedPaths } = useWorkspaceContext();
  const [drafts, setDrafts] = useState<DraftRelatedPath[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);
  const [remoteHomePath, setRemoteHomePath] = useState<string | undefined>(undefined);
  const [externalReferences, setExternalReferences] = useState<WorkspaceReferenceEntry[]>([]);
  const [externalReferencesLoading, setExternalReferencesLoading] = useState(false);
  const [externalReferencesFailed, setExternalReferencesFailed] = useState(false);
  const [externalReferenceDiagnostics, setExternalReferenceDiagnostics] = useState<WorkspaceReferenceDiagnostic[]>([]);

  const remoteWorkspace = isRemoteWorkspace(workspace);
  const connectionId = workspace.connectionId?.trim() || undefined;
  const visibleExternalReferences = useMemo(
    () => externalReferences.filter(reference => reference.origin === 'external' && !reference.hidden),
    [externalReferences],
  );
  const showExternalReferences = !remoteWorkspace && (
    visibleExternalReferences.length > 0 || externalReferencesFailed || externalReferenceDiagnostics.length > 0
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDrafts((workspace.relatedPaths ?? []).map(path => createDraft(path)));
    setSaving(false);
    setEditingDraftId(null);
    setError(null);
  }, [isOpen, workspace.relatedPaths]);

  useEffect(() => {
    if (!isOpen || remoteWorkspace) {
      setExternalReferences([]);
      setExternalReferencesLoading(false);
      setExternalReferencesFailed(false);
      setExternalReferenceDiagnostics([]);
      return;
    }

    let cancelled = false;
    setExternalReferencesLoading(true);
    setExternalReferencesFailed(false);
    void externalSourcesAPI
      .getWorkspaceReferences(workspace.id)
      .then(snapshot => {
        if (!cancelled) {
          setExternalReferences(snapshot.references);
          setExternalReferenceDiagnostics(snapshot.diagnostics ?? []);
        }
      })
      .catch(fetchError => {
        log.warn('Failed to load external workspace references', {
          workspaceId: workspace.id,
          error: fetchError,
        });
        if (!cancelled) {
          setExternalReferences([]);
          setExternalReferencesFailed(true);
          setExternalReferenceDiagnostics([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExternalReferencesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, remoteWorkspace, workspace.id, workspace.rootPath]);

  useEffect(() => {
    if (!isOpen || !remoteWorkspace || !connectionId) {
      setRemoteHomePath(undefined);
      return;
    }

    let cancelled = false;
    void sshApi
      .getServerInfo(connectionId)
      .then(info => {
        if (!cancelled) {
          setRemoteHomePath(info?.homeDir?.trim() || undefined);
        }
      })
      .catch(fetchError => {
        log.warn('Failed to load remote server info for related directories', {
          workspaceId: workspace.id,
          error: fetchError,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [connectionId, isOpen, remoteWorkspace, workspace.id]);

  const normalizedDrafts = useMemo(() => normalizeDrafts(drafts), [drafts]);
  const hasInvalidDraft = normalizedDrafts.some(draft => !draft.path);
  const isUnchanged = JSON.stringify(normalizedDrafts) === JSON.stringify(workspace.relatedPaths ?? []);

  const setDraftValue = (
    draftId: string,
    field: 'path' | 'description',
    value: string
  ) => {
    setDrafts(current =>
      current.map(draft => (draft.id === draftId ? { ...draft, [field]: value } : draft))
    );
    setError(null);
  };

  const handleAddDraft = () => {
    const draft = createDraft();
    setDrafts(current => [...current, draft]);
    setEditingDraftId(draft.id);
    setError(null);
  };

  const handleRemoveDraft = (draftId: string) => {
    setDrafts(current => current.filter(draft => draft.id !== draftId));
    setEditingDraftId(current => current === draftId ? null : current);
    setError(null);
  };

  const handleSelectLocalDirectory = async (index: number) => {
    try {
      const { pickWorkspaceDirectory } = await import(
        '@/infrastructure/peer-device/pickWorkspaceDirectory'
      );
      const selected = await pickWorkspaceDirectory({
        title: t('nav.workspaces.relatedPaths.dialog.selectDirectoryTitle'),
        defaultPath: drafts[index]?.path || workspace.rootPath,
      });

      if (selected?.trim()) {
        setDraftValue(drafts[index].id, 'path', selected);
      }
    } catch (selectionError) {
      log.error('Failed to select related directory', { workspaceId: workspace.id, error: selectionError });
      setError(t('nav.workspaces.relatedPaths.messages.selectFailed'));
    }
  };

  const handleSave = async () => {
    if (hasInvalidDraft) {
      setError(t('nav.workspaces.relatedPaths.validation.pathRequired'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateWorkspaceRelatedPaths(workspace.id, normalizedDrafts);
      onClose();
    } catch (saveError) {
      log.error('Failed to save related directories', { workspaceId: workspace.id, error: saveError });
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('nav.workspaces.relatedPaths.messages.saveFailed')
      );
    } finally {
      setSaving(false);
    }
  };

  const directoryName = (path: string) => {
    const normalized = remoteWorkspace ? path : path.replace(/\\/g, '/');
    return normalized.replace(/\/+$/, '').split('/').pop() || path;
  };
  const directoryIcon = remoteWorkspace ? <Icon glyph={Server} size="sm" /> : undefined;

  const addDirectoryButton = (
    <Button
      type="button"
      variant="fill"
      size="sm"
      leadingIcon={<Icon glyph={FolderPlus} size="sm" />}
      onClick={handleAddDraft}
      disabled={saving}
    >
      {t('nav.workspaces.relatedPaths.dialog.add')}
    </Button>
  );

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !saving) onClose();
        }}
        size="md"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('nav.workspaces.relatedPaths.dialog.title')}</DialogTitle>
            {remoteWorkspace && (
              <DialogDescription>
                {t('nav.workspaces.relatedPaths.dialog.remoteScope', {
                  connectionName: workspace.connectionName || workspace.name,
                })}
              </DialogDescription>
            )}
          </DialogHeading>
          <DialogClose aria-label={t('actions.close')} disabled={saving} />
        </DialogHeader>
        <DialogBody>
          <div
            className="workspace-related-paths-dialog"
            data-openbitfun-component="workspace-related-paths-dialog"
            data-openbitfun-part="root"
            aria-busy={saving}
          >
            <Card appearance="neutral" radius="lg">
              <CardBody padding="md" className="workspace-related-paths-dialog__folders">
                <div className="workspace-related-paths-dialog__add">{addDirectoryButton}</div>
                <ProjectFolderList label={t('nav.workspaces.relatedPaths.dialog.title')}>
                  <ProjectFolderItem
                    name={workspace.name}
                    path={workspace.rootPath}
                    leading={directoryIcon}
                    actions={<StatusPill tone="neutral">{t('nav.workspaces.relatedPaths.dialog.primaryDirectory')}</StatusPill>}
                  />
                  {drafts.map((draft, index) => (
                    <ProjectFolderItem
                      key={draft.id}
                      name={directoryName(draft.path) || t('nav.workspaces.relatedPaths.dialog.itemLabel', { index: index + 2 })}
                      path={draft.path}
                      leading={directoryIcon}
                      editorId={`related-directory-${draft.id}`}
                      actions={(
                        <>
                          <IconButton
                            aria-label={t('actions.edit')}
                            aria-expanded={editingDraftId === draft.id}
                            aria-controls={`related-directory-${draft.id}`}
                            icon={<Icon name="edit" size="sm" />}
                            size="xs"
                            onClick={() => setEditingDraftId(current => current === draft.id ? null : draft.id)}
                            disabled={saving}
                          />
                          <IconButton
                            aria-label={t('newProject.removeFolder', { name: directoryName(draft.path) })}
                            icon={<Icon name="xmark" size="sm" />}
                            size="xs"
                            onClick={() => handleRemoveDraft(draft.id)}
                            disabled={saving}
                          />
                        </>
                      )}
                    >
                      {editingDraftId === draft.id && (
                        <>
                          <Field
                            label={t('nav.workspaces.relatedPaths.dialog.pathPlaceholder')}
                            controlWidth="fill"
                            controlTrailing={(
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                leadingIcon={<Icon glyph={FolderOpen} size="sm" />}
                                onClick={() => remoteWorkspace
                                  ? setBrowsingIndex(index)
                                  : void handleSelectLocalDirectory(index)}
                                disabled={saving || (remoteWorkspace && !connectionId)}
                              >
                                {t('actions.select')}
                              </Button>
                            )}
                          >
                            <Input
                              value={draft.path}
                              onChange={event => setDraftValue(draft.id, 'path', event.target.value)}
                              disabled={saving}
                              size="sm"
                              autoFocus
                            />
                          </Field>
                          <Field label={t('nav.workspaces.relatedPaths.dialog.descriptionLabel')} controlWidth="fill">
                            <Textarea
                              value={draft.description}
                              onChange={event => setDraftValue(draft.id, 'description', event.target.value)}
                              disabled={saving}
                              layout="fill"
                              resize="none"
                              rows={2}
                              variant="outlined"
                            />
                          </Field>
                        </>
                      )}
                    </ProjectFolderItem>
                  ))}
                </ProjectFolderList>
              </CardBody>
            </Card>

            {externalReferencesLoading && (
              <LoadingState size="sm" role="status">
                {t('nav.workspaces.relatedPaths.dialog.externalLoading')}
              </LoadingState>
            )}
            {showExternalReferences && (
              <FormSection
                title={t('nav.workspaces.relatedPaths.dialog.externalHeading')}
                actions={<StatusPill tone="neutral">{t('nav.workspaces.relatedPaths.dialog.readOnly')}</StatusPill>}
              >
                {externalReferencesFailed && (
                  <Alert tone="warning" role="status" message={t('nav.workspaces.relatedPaths.messages.externalLoadFailed')} />
                )}
                {visibleExternalReferences.map(reference => (
                  <Card key={reference.stableKey} padding="sm" gap="sm">
                    <CardHeader
                      title={<OverflowText>@{reference.alias}</OverflowText>}
                      actions={<StatusPill tone="neutral">{reference.sourceDisplayName}</StatusPill>}
                    />
                    <CardBody>
                      <div className="workspace-related-paths-dialog__external-path">{reference.path}</div>
                      {reference.description && (
                        <div className="workspace-related-paths-dialog__external-description">{reference.description}</div>
                      )}
                    </CardBody>
                  </Card>
                ))}
                {externalReferenceDiagnostics.length > 0 && (
                  <Disclosure
                    presentation="native"
                    summary={t('nav.workspaces.relatedPaths.dialog.externalDiagnostics', {
                      count: externalReferenceDiagnostics.length,
                    })}
                  >
                    <ul className="workspace-related-paths-dialog__diagnostics">
                      {externalReferenceDiagnostics.map((diagnostic, index) => (
                        <li key={`${diagnostic.code}-${index}`}>
                          <code>{diagnostic.code}</code>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                )}
              </FormSection>
            )}

            {error && <Alert tone="error" message={error} />}
          </div>
        </DialogBody>
        <DialogFooter
          data-openbitfun-component="workspace-related-paths-dialog"
          data-openbitfun-part="footer"
          className="workspace-related-paths-dialog__footer"
        >
          <div
            data-openbitfun-component="workspace-related-paths-dialog"
            data-openbitfun-part="footerActions"
            className="workspace-related-paths-dialog__footer-actions"
          >
            <Button type="button" variant="fill" size="sm" onClick={onClose} disabled={saving}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void handleSave()}
              loading={saving}
              disabled={saving || hasInvalidDraft || isUnchanged}
            >
              {saving ? t('status.saving') : t('actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </Dialog>

      {remoteWorkspace && connectionId && browsingIndex !== null ? (
        <RemoteFileBrowser
          connectionId={connectionId}
          initialPath={drafts[browsingIndex]?.path || workspace.rootPath}
          homePath={remoteHomePath}
          selectDirectoriesOnly
          onSelect={(path: string) => {
            setDraftValue(drafts[browsingIndex].id, 'path', path);
            setBrowsingIndex(null);
          }}
          onCancel={() => setBrowsingIndex(null)}
        />
      ) : null}
    </>
  );
};

export default WorkspaceRelatedPathsDialog;
