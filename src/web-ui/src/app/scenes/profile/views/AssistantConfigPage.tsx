import { resolveAssistantName } from '@/shared/utils/assistantName';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
  Suspense,
} from 'react';
import { useTranslation } from 'react-i18next';

import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { WorkspaceKind } from '@/shared/types';
import { useMyAgentStore } from '@/app/scenes/my-agent/myAgentStore';
import { useAgentIdentityDocument } from '@/app/scenes/my-agent/useAgentIdentityDocument';
import { EditArea, MEditor } from '@/tools/editor/meditor';
import { analyzeMarkdownEditability } from '@/tools/editor/meditor/utils/tiptapMarkdown';
import {
  joinMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from '@/app/scenes/my-agent/identityDocument';
import SessionsSection from '@/app/components/NavPanel/sections/sessions/SessionsSection';
import AssistantAvatarPicker from './AssistantAvatarPicker';
import AssistantQuickInput from './AssistantQuickInput';
import { useNurseryStore } from '../nurseryStore';
import './NurseryView.scss';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Icon,
  Input,
  OverflowText,
  PageHeader,
  ScrollArea,
  Spinner,
  Textarea,
} from '@openbitfun/ui';

const log = createLogger('AssistantConfigPage');

const ScheduledJobsView = lazyWithRecovery(() => import('@/app/components/scheduled-jobs/ScheduledJobsView'));

const PERSONA_DOC_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md'] as const;
type PersonaDocFile = typeof PERSONA_DOC_FILES[number];

function personaDocFullPath(workspaceRoot: string, fileName: PersonaDocFile): string {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}/${fileName}`;
}

function isFileMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|no such file|not found/i.test(message);
}


interface PersonaDocState {
  fileName: PersonaDocFile;
  originalContent: string;
  content: string;
  loading: boolean;
  error: string | null;
}

interface AutoResizeTextareaProps {
  value: string;
  onChange: (value: string) => void;
}

const AutoResizeTextarea: React.FC<AutoResizeTextareaProps> = ({
  value,
  onChange,
}) => {
  return (
    <Textarea
      autoResize
      className="acp-persona-editor__frontmatter-control"
      font="mono"
      resize="none"
      value={value}
      onValueChange={onChange}
      spellCheck={false}
      rows={1}
    />
  );
};

const AssistantConfigPage: React.FC = () => {
  const { t } = useTranslation('scenes/profile');
  const { openGallery, activeWorkspaceId } = useNurseryStore();
  const selectedAssistantWorkspaceId = useMyAgentStore((s) => s.selectedAssistantWorkspaceId);
  const { allAssistantWorkspacesList: assistantWorkspacesList, currentWorkspace } = useWorkspaceContext();

  const effectiveWorkspaceId = useMemo(() => {
    const inList = (id: string | null | undefined) =>
      id && assistantWorkspacesList.some((w) => w.id === id) ? id : null;

    // Explicit selection from nursery gallery takes highest priority,
    // followed by the selected assistant store, then the active workspace.
    return (
      inList(activeWorkspaceId) ??
      inList(selectedAssistantWorkspaceId) ??
      (currentWorkspace?.workspaceKind === WorkspaceKind.Assistant ? inList(currentWorkspace.id) : null) ??
      null
    );
  }, [
    activeWorkspaceId,
    assistantWorkspacesList,
    currentWorkspace?.id,
    currentWorkspace?.workspaceKind,
    selectedAssistantWorkspaceId,
  ]);

  const workspace = useMemo(
    () =>
      effectiveWorkspaceId
        ? assistantWorkspacesList.find((w) => w.id === effectiveWorkspaceId) ?? null
        : null,
    [assistantWorkspacesList, effectiveWorkspaceId],
  );
  const workspacePath = workspace?.rootPath ?? '';

  const {
    document: identityDocument,
    error: identitySaveError,
    saveStatus: identitySaveStatus,
    updateField: updateIdentityField,
    reload: reloadIdentityDocument,
  } = useAgentIdentityDocument(workspace ? { id: workspace.id, rootPath: workspace.rootPath } : null);

  const displayIdentity = useMemo(() => {
    const api = workspace?.identity;
    return {
      name: identityDocument.name.trim() || api?.name?.trim() || '',
      avatar: identityDocument.avatar.trim() || api?.avatar?.trim() || '',
      emoji: identityDocument.emoji.trim() || api?.emoji?.trim() || '',
    };
  }, [identityDocument, workspace?.identity]);

  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [personaDoc, setPersonaDoc] = useState<PersonaDocState | null>(null);
  const [personaSaveCount, setPersonaSaveCount] = useState(0);
  const personaSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const personaSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const personaPendingRef = useRef<{ file: PersonaDocFile; content: string } | null>(null);

  const workspaceId = workspace?.id ?? '';

  const flushPersonaWrite = useCallback((file: PersonaDocFile, content: string) => {
    if (!workspaceId || !workspacePath) return;
    const fullPath = personaDocFullPath(workspacePath, file);
    setPersonaSaveCount(count => count + 1);
    // Keep manual saves, autosaves, and close-time saves in edit order.
    const save = personaSaveQueueRef.current.then(async () => {
      try {
        await workspaceAPI.writeWorkspaceFile(workspaceId, fullPath, content);
        if (
          personaPendingRef.current?.file === file &&
          personaPendingRef.current?.content === content
        ) {
          personaPendingRef.current = null;
        }
        setPersonaDoc((prev) => prev?.fileName === file ? { ...prev, originalContent: content } : prev);
        if (file === 'IDENTITY.md') {
          await reloadIdentityDocument();
        }
      } catch (e) {
        log.error('persona doc save', e);
        notificationService.error(t('nursery.assistant.personaDocSaveFailed'));
      } finally {
        setPersonaSaveCount(count => count - 1);
      }
    });
    personaSaveQueueRef.current = save;
    return save;
  }, [workspaceId, workspacePath, reloadIdentityDocument, t]);

  const handleSavePersonaDoc = useCallback(() => {
    if (!personaDoc || personaDoc.loading || personaDoc.error || personaSaveCount > 0
      || personaDoc.content === personaDoc.originalContent) return;
    if (personaSaveTimerRef.current) {
      clearTimeout(personaSaveTimerRef.current);
      personaSaveTimerRef.current = null;
    }
    void flushPersonaWrite(personaDoc.fileName, personaDoc.content);
  }, [personaDoc, personaSaveCount, flushPersonaWrite]);

  const flushPersonaWriteRef = useRef(flushPersonaWrite);
  flushPersonaWriteRef.current = flushPersonaWrite;

  const closePersonaDoc = useCallback(() => {
    if (
      personaDoc &&
      personaPendingRef.current &&
      personaPendingRef.current.content !== personaDoc.originalContent
    ) {
      const { file, content } = personaPendingRef.current;
      void flushPersonaWriteRef.current(file, content);
    }
    if (personaSaveTimerRef.current) {
      clearTimeout(personaSaveTimerRef.current);
      personaSaveTimerRef.current = null;
    }
    personaPendingRef.current = null;
    setPersonaDoc(null);
  }, [personaDoc]);

  const openPersonaDoc = useCallback((fileName: PersonaDocFile) => {
    closePersonaDoc();
    if (personaDoc?.fileName === fileName) return;

    setPersonaDoc({ fileName, originalContent: '', content: '', loading: true, error: null });

    if (!workspaceId || !workspacePath) return;
    const fullPath = personaDocFullPath(workspacePath, fileName);
    workspaceAPI.readWorkspaceFile(workspaceId, fullPath)
      .then((content) => {
        setPersonaDoc((prev) => prev?.fileName === fileName ? {
          ...prev,
          originalContent: content,
          content,
          loading: false,
        } : prev);
      })
      .catch((err) => {
        if (isFileMissingError(err)) {
          setPersonaDoc((prev) => prev?.fileName === fileName ? {
            ...prev,
            originalContent: '',
            content: '',
            loading: false,
          } : prev);
        } else {
          setPersonaDoc((prev) => prev?.fileName === fileName
            ? {
              ...prev,
              originalContent: '',
              content: '',
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
            : prev);
        }
      });
  }, [personaDoc, workspaceId, workspacePath, closePersonaDoc]);

  const handlePersonaDocChange = useCallback((value: string) => {
    if (!personaDoc) return;
    const { fileName, content: previousContent } = personaDoc;
    if (value === previousContent) {
      return;
    }
    setPersonaDoc((prev) => prev ? { ...prev, content: value } : prev);
    personaPendingRef.current = { file: fileName, content: value };
    if (personaSaveTimerRef.current) {
      clearTimeout(personaSaveTimerRef.current);
    }
    personaSaveTimerRef.current = setTimeout(() => {
      personaSaveTimerRef.current = null;
      const pending = personaPendingRef.current;
      if (!pending || pending.file !== fileName || !workspacePath) return;
      void flushPersonaWrite(pending.file, pending.content);
    }, 600);
  }, [personaDoc, workspacePath, flushPersonaWrite]);

  const personaDocSections = useMemo(
    () => (personaDoc ? splitMarkdownFrontmatter(personaDoc.content) : null),
    [personaDoc]
  );

  const handlePersonaDocFrontmatterChange = useCallback((frontmatter: string) => {
    if (!personaDocSections?.hasFrontmatter) {
      return;
    }

    handlePersonaDocChange(joinMarkdownFrontmatter(frontmatter, personaDocSections.body, {
      preserveFrontmatterBlock: true,
    }));
  }, [handlePersonaDocChange, personaDocSections]);

  const handlePersonaDocBodyChange = useCallback((body: string) => {
    if (!personaDocSections) {
      return;
    }

    if (personaDocSections.hasFrontmatter) {
      handlePersonaDocChange(joinMarkdownFrontmatter(personaDocSections.frontmatter, body, {
        preserveFrontmatterBlock: true,
      }));
      return;
    }

    handlePersonaDocChange(body);
  }, [handlePersonaDocChange, personaDocSections]);

  useEffect(() => {
    return () => {
      if (personaSaveTimerRef.current) clearTimeout(personaSaveTimerRef.current);
      const pending = personaPendingRef.current;
      if (pending && workspacePath) {
        void flushPersonaWriteRef.current(pending.file, pending.content);
      }
    };
  }, [workspacePath]);

  const startEdit = useCallback(() => {
    setEditingName(true);
    setEditValue(displayIdentity.name);
    setTimeout(() => { nameInputRef.current?.focus(); }, 10);
  }, [displayIdentity.name]);

  const commitEdit = useCallback(() => {
    if (!editingName) return;
    updateIdentityField('name', editValue.trim());
    setEditingName(false);
  }, [editingName, editValue, updateIdentityField]);

  const onEditKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditingName(false);
  }, [commitEdit]);

  const identityName = displayIdentity.name || resolveAssistantName(workspace, t('shared:agents.Claw'));

  const renderPersonaDocLinks = () => (
    <div className="acp-identity__meta" data-openbitfun-component="assistant-config-page" data-openbitfun-part="personaList">
      {PERSONA_DOC_FILES.map((fileName, index) => {
        const selected = personaDoc?.fileName === fileName;
        const labelKey = fileName.replace(/\.md$/i, '') as 'SOUL' | 'USER' | 'IDENTITY';
        return (
          <div
            key={fileName}
            className="acp-identity__meta-item"
            data-openbitfun-component="assistant-config-page"
            data-openbitfun-part="persona"
            data-openbitfun-state={selected ? 'selected' : undefined}
          >
            {index > 0 && <span className="acp-identity__meta-divider" aria-hidden />}
            <button
              type="button"
              data-overflow-trigger
              className="acp-identity__meta-tag"
              aria-haspopup="dialog"
              aria-expanded={selected}
              onClick={() => openPersonaDoc(fileName)}
            >
              <OverflowText>{t(`nursery.assistant.personaDocs.${labelKey}`)}</OverflowText>
            </button>
          </div>
        );
      })}
    </div>
  );

  const renderPersonaDocContent = () => {
    if (!personaDoc) return null;
    const { fileName, content, loading, error } = personaDoc;
    const docLabelKey = fileName.replace(/\.md$/i, '') as 'SOUL' | 'USER' | 'IDENTITY';
    const sections = personaDocSections ?? splitMarkdownFrontmatter(content);
    const bodyEditability = analyzeMarkdownEditability(sections.body);
    const usesHybridEditor = sections.hasFrontmatter;
    const usesSourceBodyEditor = bodyEditability.mode === 'unsafe';
    return (
      <div className="acp-persona-editor" data-openbitfun-component="assistant-config-page" data-openbitfun-part="editor">
        <div className="acp-persona-editor__head" data-openbitfun-component="assistant-config-page" data-openbitfun-part="editorHeader">
          <DialogHeader separator>
            <DialogHeading>
              <DialogTitle>{t(`nursery.assistant.personaDocs.${docLabelKey}`)}</DialogTitle>
              <DialogDescription>{fileName}</DialogDescription>
            </DialogHeading>
            <DialogClose aria-label={t('nursery.assistant.closeDetail')} />
          </DialogHeader>
        </div>
        <DialogBody inset="none">
          <div className="acp-persona-editor__body" data-openbitfun-component="assistant-config-page" data-openbitfun-part="editorBody">
            {error && <p className="acp-persona-editor__error" data-openbitfun-component="assistant-config-page" data-openbitfun-part="error">{t('nursery.assistant.personaDocLoadFailed')}: {error}</p>}
            {loading ? (
              <div className="acp-loading" data-openbitfun-component="assistant-config-page" data-openbitfun-part="loading"><Spinner size="sm" /></div>
            ) : usesHybridEditor ? (
              <div className="acp-persona-editor__hybrid">
                <section className="acp-persona-editor__frontmatter" data-openbitfun-component="assistant-config-page" data-openbitfun-part="frontmatter">
                  <AutoResizeTextarea
                    key={`${fileName}-frontmatter`}
                    value={sections.frontmatter}
                    onChange={handlePersonaDocFrontmatterChange}
                  />
                </section>
                <div className="acp-persona-editor__divider" aria-hidden="true" />
                <section className="acp-persona-editor__body-editor" data-openbitfun-component="assistant-config-page" data-openbitfun-part="bodyEditor">
                  {usesSourceBodyEditor ? (
                    <EditArea
                      key={`${fileName}-body-source`}
                      value={sections.body}
                      onChange={handlePersonaDocBodyChange}
                    />
                  ) : (
                    <MEditor
                      key={`${fileName}-body`}
                      value={sections.body}
                      onChange={handlePersonaDocBodyChange}
                      toolbar={false}
                      mode="ir"
                      height="100%"
                      className="acp-persona-editor__meditor"
                    />
                  )}
                </section>
              </div>
            ) : usesSourceBodyEditor ? (
              <EditArea
                key={fileName}
                value={content}
                onChange={handlePersonaDocChange}
              />
            ) : (
              <MEditor
                key={fileName}
                value={content}
                onChange={handlePersonaDocBodyChange}
                toolbar={false}
                mode="ir"
                height="100%"
                className="acp-persona-editor__meditor"
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter className="acp-persona-editor__footer" separator>
          <Button
            variant="primary"
            loading={personaSaveCount > 0}
            disabled={loading || Boolean(error) || !workspaceId || content === personaDoc.originalContent}
            onClick={handleSavePersonaDoc}
          >
            {personaSaveCount > 0 ? t('common:status.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </div>
    );
  };

  return (
    <div
      className="nursery-page acp-page"
      data-openbitfun-component="assistant-config-page"
      data-openbitfun-part="root"
    >
      <header className="acp-page__toolbar" data-openbitfun-component="assistant-config-page" data-openbitfun-part="toolbar">
        <span data-openbitfun-component="assistant-config-page" data-openbitfun-part="back">
          <Button
            className="acp-page__back"
            variant="text"
            size="sm"
            onClick={openGallery}
            leadingIcon={<Icon name="arrow-left" size="sm" />}
          >
            {t('nursery.backToGallery')}
          </Button>
        </span>
      </header>
      <ScrollArea className="acp-page__scroll">
        <div className="acp-layout" data-openbitfun-component="assistant-config-page" data-openbitfun-part="layout">
          <div className="acp-identity" data-openbitfun-component="assistant-config-page" data-openbitfun-part="identity">
            <AssistantAvatarPicker
              presetValue={displayIdentity.avatar}
              value={displayIdentity.emoji}
              stableKey={workspace?.assistantId || workspace?.id}
              assistantName={displayIdentity.name || resolveAssistantName(workspace, t('shared:agents.Claw'))}
              saveStatus={identitySaveStatus}
              saveError={identitySaveError}
              onPresetChange={(avatar) => updateIdentityField('avatar', avatar)}
              onChange={(emoji) => updateIdentityField('emoji', emoji)}
            />
            <div className="acp-identity__info">
              <h2 className="acp-identity__title">
                {editingName ? (
                  <Input
                    ref={nameInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={onEditKey}
                    className="acp-identity__name-input"
                    aria-label={t('hero.editNameTitle')}
                  />
                ) : (
                  <button
                    type="button"
                    data-overflow-trigger
                    className="acp-identity__name"
                    onClick={startEdit}
                    title={t('hero.editNameTitle')}
                  >
                    <OverflowText>{identityName}</OverflowText>
                  </button>
                )}
              </h2>
              {renderPersonaDocLinks()}
            </div>
          </div>

          <section className="acp-section" aria-label={t('nursery.assistant.newSessionTitle')}>
            <PageHeader size="sm" level={3} title={t('nursery.assistant.newSessionTitle')} />
            <AssistantQuickInput
              workspacePath={workspacePath}
              workspaceId={workspace?.id}
              assistantName={identityName}
            />
          </section>

          <section className="acp-section acp-section--schedule" aria-label={t('nursery.assistant.scheduledSessionsTitle')}>
            {!workspace ? (
              <>
                <PageHeader size="sm" level={3} title={t('nursery.assistant.scheduledSessionsTitle')} />
                <p className="acp-empty">{t('nursery.assistant.scheduledSessionsNoWorkspace')}</p>
              </>
            ) : (
              <Suspense
                fallback={(
                  <>
                    <PageHeader size="sm" level={3} title={t('nursery.assistant.scheduledSessionsTitle')} />
                    <div className="acp-loading" data-openbitfun-component="assistant-config-page" data-openbitfun-part="loading">
                      <Spinner size="sm" />
                    </div>
                  </>
                )}
              >
                <ScheduledJobsView
                  workspaceId={workspace.id}
                  workspaceKind={workspace.workspaceKind}
                  assistantName={identityName}
                  headerTitle={t('nursery.assistant.scheduledSessionsTitle')}
                  assistantWorkspaceMode
                />
              </Suspense>
            )}
          </section>

          <section
            className="acp-section acp-sessions-area"
            aria-label={t('nursery.assistant.sessionsSectionTitle')}
            data-openbitfun-component="assistant-config-page"
            data-openbitfun-part="sessions"
          >
            <PageHeader size="sm" level={3} title={t('nursery.assistant.sessionsSectionTitle')} />
            <SessionsSection
              workspaceId={workspace?.id}
              workspacePath={workspacePath}
              isActiveWorkspace
            />
          </section>
        </div>
      </ScrollArea>
      <Dialog
        open={personaDoc !== null}
        onOpenChange={open => { if (!open) closePersonaDoc(); }}
        size="lg"
        className="acp-persona-dialog"
      >
        {renderPersonaDocContent()}
      </Dialog>
    </div>
  );
};

export default AssistantConfigPage;
