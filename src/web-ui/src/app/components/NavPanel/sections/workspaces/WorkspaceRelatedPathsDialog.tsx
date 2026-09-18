import {
  Button,
  Icon,
  Input,
  Textarea,
  Dialog,
  Disclosure,
  DialogBody,
  DialogClose,
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
import { FolderOpen } from 'lucide-react';
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
  const relatedPathCount = drafts.length + visibleExternalReferences.length;
  const scopeDescription = remoteWorkspace
    ? t('nav.workspaces.relatedPaths.dialog.remoteScope', {
        connectionName: workspace.connectionName || workspace.name,
      })
    : t('nav.workspaces.relatedPaths.dialog.localScope');

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDrafts((workspace.relatedPaths ?? []).map(path => createDraft(path)));
    setSaving(false);
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
    setDrafts(current => [...current, createDraft()]);
    setError(null);
  };

  const handleRemoveDraft = (draftId: string) => {
    setDrafts(current => current.filter(draft => draft.id !== draftId));
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

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !saving) onClose();
        }}
        size="lg"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('nav.workspaces.relatedPaths.dialog.title')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          <div className="workspace-related-paths-dialog__modal">
        <div
          className="workspace-related-paths-dialog"
          data-openbitfun-component="workspace-related-paths-dialog"
          data-openbitfun-part="root"
        >
          <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="intro" className="workspace-related-paths-dialog__intro">
            <div className="workspace-related-paths-dialog__intro-icon">
              <Icon name="link" size="lg" />
            </div>
            <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="introCopy" className="workspace-related-paths-dialog__intro-copy">
              <div className="workspace-related-paths-dialog__intro-title">
                {t('nav.workspaces.relatedPaths.dialog.heading')}
              </div>
              <div className="workspace-related-paths-dialog__intro-text">
                {t('nav.workspaces.relatedPaths.dialog.description')}
              </div>
              <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="scope" className="workspace-related-paths-dialog__scope">
                {scopeDescription}
              </div>
            </div>
            <div className="workspace-related-paths-dialog__intro-badge">
              <span className="workspace-related-paths-dialog__intro-badge-label">
                {t('nav.workspaces.relatedPaths.badge', { count: relatedPathCount })}
              </span>
            </div>
          </div>

          <div className="workspace-related-paths-dialog__section-heading">
            {t('nav.workspaces.relatedPaths.dialog.nativeHeading')}
          </div>

          {drafts.length === 0 ? (
            <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="empty" className="workspace-related-paths-dialog__empty">
              {t('nav.workspaces.relatedPaths.dialog.empty')}
            </div>
          ) : (
            <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="list" className="workspace-related-paths-dialog__list">
              {drafts.map((draft, index) => (
                <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="card" key={draft.id} className="workspace-related-paths-dialog__card">
                  <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="cardHeader" className="workspace-related-paths-dialog__card-header">
                    <span className="workspace-related-paths-dialog__card-index">
                      {t('nav.workspaces.relatedPaths.dialog.itemLabel', { index: index + 1 })}
                    </span>
                    <button
                      type="button"
                      className="workspace-related-paths-dialog__remove"
                      onClick={() => handleRemoveDraft(draft.id)}
                      aria-label={t('actions.remove')}
                    >
                      <Icon name="delete" size="sm" />
                    </button>
                  </div>

                  <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="pathRow" className="workspace-related-paths-dialog__path-row">
                    <Input
                      className="workspace-related-paths-dialog__path-input"
                      value={draft.path}
                      onChange={event => setDraftValue(draft.id, 'path', event.target.value)}
                      placeholder={t('nav.workspaces.relatedPaths.dialog.pathPlaceholder')}
                      disabled={saving}
                      size="sm"
                    />
                    <Button
                      type="button"
                      className="workspace-related-paths-dialog__select"
                      variant="outline"
                      size="sm"
                      leadingIcon={<Icon glyph={FolderOpen} />}
                      onClick={() =>
                        remoteWorkspace
                          ? setBrowsingIndex(index)
                          : void handleSelectLocalDirectory(index)
                      }
                      disabled={saving || (remoteWorkspace && !connectionId)}
                    >
                      {t('actions.select')}
                    </Button>
                  </div>

                  <div
                    data-openbitfun-component="workspace-related-paths-dialog"
                    data-openbitfun-part="description"
                    className="workspace-related-paths-dialog__description"
                  >
                    <Textarea
                      value={draft.description}
                      onChange={event => setDraftValue(draft.id, 'description', event.target.value)}
                      placeholder={t('nav.workspaces.relatedPaths.dialog.descriptionPlaceholder')}
                      disabled={saving}
                      layout="fill"
                      resize="none"
                      rows={2}
                      variant="outlined"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!remoteWorkspace ? (
            <section className="workspace-related-paths-dialog__external-section">
              <div className="workspace-related-paths-dialog__section-heading">
                <span>{t('nav.workspaces.relatedPaths.dialog.externalHeading')}</span>
                <span className="workspace-related-paths-dialog__read-only">
                  {t('nav.workspaces.relatedPaths.dialog.readOnly')}
                </span>
              </div>
              <div className="workspace-related-paths-dialog__section-description">
                {t('nav.workspaces.relatedPaths.dialog.externalDescription')}
              </div>
              {externalReferenceDiagnostics.length > 0 ? (
                <Disclosure
                  presentation="native"
                  className="workspace-related-paths-dialog__diagnostics"
                  summary={t('nav.workspaces.relatedPaths.dialog.externalDiagnostics', {
                    count: externalReferenceDiagnostics.length,
                  })}
                >
                  <ul>
                    {externalReferenceDiagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${index}`}>
                        <code>{diagnostic.code}</code>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              ) : null}
              {externalReferencesLoading ? (
                <div className="workspace-related-paths-dialog__empty">
                  {t('nav.workspaces.relatedPaths.dialog.externalLoading')}
                </div>
              ) : externalReferencesFailed ? (
                <div className="workspace-related-paths-dialog__error" role="status">
                  {t('nav.workspaces.relatedPaths.messages.externalLoadFailed')}
                </div>
              ) : visibleExternalReferences.length === 0 ? (
                <div className="workspace-related-paths-dialog__empty">
                  {t('nav.workspaces.relatedPaths.dialog.externalEmpty')}
                </div>
              ) : (
                <div className="workspace-related-paths-dialog__list">
                  {visibleExternalReferences.map(reference => (
                    <div
                      key={reference.stableKey}
                      className="workspace-related-paths-dialog__card workspace-related-paths-dialog__card--external"
                    >
                      <div className="workspace-related-paths-dialog__card-header">
                        <span className="workspace-related-paths-dialog__external-alias">
                          @{reference.alias}
                        </span>
                        <span className="workspace-related-paths-dialog__external-source">
                          {reference.sourceDisplayName}
                        </span>
                      </div>
                      <div className="workspace-related-paths-dialog__external-path">
                        {reference.path}
                      </div>
                      {reference.description ? (
                        <div className="workspace-related-paths-dialog__section-description">
                          {reference.description}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {error ? (
            <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="error" className="workspace-related-paths-dialog__error" role="alert">
              {error}
            </div>
          ) : null}

        </div>
                </div>
                </DialogBody>
          <DialogFooter
            separator
            data-openbitfun-component="workspace-related-paths-dialog"
            data-openbitfun-part="footer"
            className="workspace-related-paths-dialog__footer"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              leadingIcon={<Icon name="plus" size="lg" />}
              onClick={handleAddDraft}
              disabled={saving}
            >
              {t('nav.workspaces.relatedPaths.dialog.add')}
            </Button>

            <div data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="footerActions" className="workspace-related-paths-dialog__footer-actions">
              <Button
                type="button"
                variant="fill"
                size="sm"
                onClick={onClose}
                disabled={saving}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleSave()}
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
