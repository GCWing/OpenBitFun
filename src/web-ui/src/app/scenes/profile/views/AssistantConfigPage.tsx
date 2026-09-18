import React, {
  useCallback, useEffect, useMemo, useRef, useState,
  lazy,
  Suspense,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';

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
  ActionCard,
  Card,
  Icon,
  IconButton,
  Input,
  OverflowText,
  PageHeader,
  ScrollArea,
  Spinner,
  Textarea,
  Tooltip,
} from '@openbitfun/ui';

const log = createLogger('AssistantConfigPage');

const ScheduledJobsView = lazy(() => import('@/app/components/scheduled-jobs/ScheduledJobsView'));

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

const DEFAULT_AGENT_NAME = 'OpenBitFun Agent';

type RightPanelView = 'info' | 'personaDoc';

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
  const { assistantWorkspacesList, currentWorkspace } = useWorkspaceContext();

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
      creature: identityDocument.creature.trim() || api?.creature?.trim() || '',
      vibe: identityDocument.vibe.trim() || api?.vibe?.trim() || '',
      avatar: identityDocument.avatar.trim() || api?.avatar?.trim() || '',
      emoji: identityDocument.emoji.trim() || api?.emoji?.trim() || '',
    };
  }, [identityDocument, workspace?.identity]);

  const [editingField, setEditingField] = useState<'name' | 'creature' | 'vibe' | null>(null);
  const [editValue, setEditValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const metaInputRef = useRef<HTMLInputElement>(null);
  const [rightView, setRightView] = useState<RightPanelView>('info');
  const [personaDoc, setPersonaDoc] = useState<PersonaDocState | null>(null);
  const personaSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const personaPendingRef = useRef<{ file: PersonaDocFile; content: string } | null>(null);

  const workspaceId = workspace?.id ?? '';

  const flushPersonaWrite = useCallback(async (file: PersonaDocFile, content: string) => {
    if (!workspaceId || !workspacePath) return;
    const fullPath = personaDocFullPath(workspacePath, file);
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
    }
  }, [workspaceId, workspacePath, reloadIdentityDocument, t]);

  const flushPersonaWriteRef = useRef(flushPersonaWrite);
  flushPersonaWriteRef.current = flushPersonaWrite;

  const openPersonaDoc = useCallback((fileName: PersonaDocFile) => {
    if (personaDoc?.fileName === fileName) {
      setRightView('info');
      setPersonaDoc(null);
      return;
    }

    setPersonaDoc({ fileName, originalContent: '', content: '', loading: true, error: null });
    setRightView('personaDoc');
    personaPendingRef.current = null;

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
        personaPendingRef.current = null;
      })
      .catch((err) => {
        if (isFileMissingError(err)) {
          setPersonaDoc((prev) => prev?.fileName === fileName ? {
            ...prev,
            originalContent: '',
            content: '',
            loading: false,
          } : prev);
          personaPendingRef.current = null;
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
  }, [personaDoc, workspaceId, workspacePath]);

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
    setRightView('info');
  }, [personaDoc]);

  useEffect(() => {
    return () => {
      if (personaSaveTimerRef.current) clearTimeout(personaSaveTimerRef.current);
      const pending = personaPendingRef.current;
      if (pending && workspacePath) {
        void flushPersonaWriteRef.current(pending.file, pending.content);
      }
    };
  }, [workspacePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && rightView === 'personaDoc') closePersonaDoc();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rightView, closePersonaDoc]);

  const startEdit = useCallback((field: 'name' | 'creature' | 'vibe') => {
    setEditingField(field);
    setEditValue(
      field === 'name'
        ? displayIdentity.name
        : field === 'creature'
          ? displayIdentity.creature
          : displayIdentity.vibe,
    );
    setTimeout(() => {
      (field === 'name' ? nameInputRef : metaInputRef).current?.focus();
    }, 10);
  }, [displayIdentity]);

  const commitEdit = useCallback(() => {
    if (!editingField) return;
    updateIdentityField(editingField, editValue.trim());
    setEditingField(null);
  }, [editingField, editValue, updateIdentityField]);

  const onEditKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditingField(null);
  }, [commitEdit]);

  const identityName = displayIdentity.name || DEFAULT_AGENT_NAME;

  // ── Right panel: identity info ──────────────────────────────────────────

  const renderInfoPanel = () => (
    <div className="acp-right-info" data-openbitfun-component="assistant-config-page" data-openbitfun-part="details">
      <Card className="acp-right-shell" appearance="subtle" radius="md" clip>
        {/* Persona docs */}
        <div className="acp-section acp-section--nested">
          <div className="acp-section__head">
            <PageHeader size="sm" level={3} title={t('nursery.assistant.personaDocsTitle')} />
          </div>
          <div className="acp-persona-doc-list" data-openbitfun-component="assistant-config-page" data-openbitfun-part="personaList">
            {PERSONA_DOC_FILES.map((fileName) => {
              const selected = personaDoc?.fileName === fileName && rightView === 'personaDoc';
              const labelKey = fileName.replace(/\.md$/i, '') as 'SOUL' | 'USER' | 'IDENTITY';
              return (
                <div
                  key={fileName}
                  className="acp-persona-doc-row"
                  data-openbitfun-component="assistant-config-page"
                  data-openbitfun-part="persona"
                  data-openbitfun-state={selected ? 'selected' : undefined}
                >
                  <ActionCard
                    className="acp-persona-doc-row__control"
                    size="sm"
                    selected={selected}
                    aria-pressed={selected}
                    leading={<Icon glyph={FileText} size="sm" />}
                    description={fileName}
                    onClick={() => openPersonaDoc(fileName)}
                  >
                    {t(`nursery.assistant.personaDocs.${labelKey}`)}
                  </ActionCard>
                </div>
              );
            })}
          </div>
        </div>

        <div className="acp-right-shell__divider" role="separator" aria-hidden="true" />

        {/* Scheduled tasks — title/toolbar live inside ScheduledJobsView */}
        <div className="acp-section acp-section--nested acp-section--schedule">
          <ScrollArea className="acp-section__schedule-body">
            {!workspace ? (
              <p className="acp-empty">{t('nursery.assistant.scheduledSessionsNoWorkspace')}</p>
            ) : (
              <Suspense
                fallback={(
                  <div className="acp-loading" data-openbitfun-component="assistant-config-page" data-openbitfun-part="loading">
                    <Spinner size="sm" />
                  </div>
                )}
              >
                <ScheduledJobsView
                  workspaceId={workspace?.id}
                  workspaceKind={workspace?.workspaceKind}
                  assistantName={identityName}
                  assistantWorkspaceMode
                />
              </Suspense>
            )}
          </ScrollArea>
        </div>
      </Card>
    </div>
  );

  // ── Right panel: persona doc editor ────────────────────────────────────

  const renderPersonaDocPanel = () => {
    if (!personaDoc) return null;
    const { fileName, content, loading, error } = personaDoc;
    const docLabelKey = fileName.replace(/\.md$/i, '') as 'SOUL' | 'USER' | 'IDENTITY';
    const sections = personaDocSections ?? splitMarkdownFrontmatter(content);
    const bodyEditability = analyzeMarkdownEditability(sections.body);
    const usesHybridEditor = sections.hasFrontmatter;
    const usesSourceBodyEditor = bodyEditability.mode === 'unsafe';
    return (
      <div className="acp-right-info" data-openbitfun-component="assistant-config-page" data-openbitfun-part="details">
        <Card className="acp-right-shell acp-right-shell--editor" appearance="subtle" radius="md" clip>
          <div className="acp-persona-editor" data-openbitfun-component="assistant-config-page" data-openbitfun-part="editor">
            <div className="acp-persona-editor__head" data-openbitfun-component="assistant-config-page" data-openbitfun-part="editorHeader">
              <PageHeader
                className="acp-persona-editor__heading"
                size="sm"
                level={3}
                title={t(`nursery.assistant.personaDocs.${docLabelKey}`)}
                description={fileName}
                leading={(
                  <Tooltip content={t('nursery.template.closeDetail')}>
                    <IconButton
                      type="button"
                      size="sm"
                      onClick={closePersonaDoc}
                      aria-label={t('nursery.template.closeDetail')}
                      icon={<Icon name="arrow-left" size="sm" />}
                    />
                  </Tooltip>
                )}
              />
            </div>
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
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div
      className="nursery-page acp-page"
      data-openbitfun-component="assistant-config-page"
      data-openbitfun-part="root"
    >
      <header className="nursery-page__header" data-openbitfun-component="assistant-config-page" data-openbitfun-part="toolbar">
        <PageHeader
          className="nursery-page__heading"
          level={2}
          title={t('nursery.card.configure')}
          leading={(
            <Tooltip content={t('nursery.backToGallery')}>
              <IconButton
                type="button"
                size="sm"
                data-openbitfun-component="assistant-config-page"
                data-openbitfun-part="back"
                onClick={openGallery}
                aria-label={t('nursery.backToGallery')}
                icon={<Icon name="arrow-left" size="sm" />}
              />
            </Tooltip>
          )}
        />
      </header>

      {/* Two-column layout */}
      <div className="acp-layout" data-openbitfun-component="assistant-config-page" data-openbitfun-part="layout">
        {/* Left: identity header + quick input + sessions */}
        <div className="acp-layout__left">
          {/* Identity header above the input */}
          <div className="acp-left-header" data-openbitfun-component="assistant-config-page" data-openbitfun-part="identity">
            <AssistantAvatarPicker
              presetValue={displayIdentity.avatar}
              value={displayIdentity.emoji}
              stableKey={workspace?.assistantId || workspace?.id}
              assistantName={displayIdentity.name || DEFAULT_AGENT_NAME}
              saveStatus={identitySaveStatus}
              saveError={identitySaveError}
              onPresetChange={(avatar) => updateIdentityField('avatar', avatar)}
              onChange={(emoji) => updateIdentityField('emoji', emoji)}
            />
            <div className="acp-left-header__info">
              {editingField === 'name' ? (
                <Input
                  ref={nameInputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={onEditKey}
                  className="acp-left-header__name-input"
                  aria-label={t('hero.editNameTitle')}
                />
              ) : (
                <button
                  type="button"
                  data-overflow-trigger
                  className="acp-left-header__name"
                  onClick={() => startEdit('name')}
                  title={t('hero.editNameTitle')}
                >
                  <OverflowText>{identityName}</OverflowText>
                </button>
              )}
              <div className="acp-left-header__meta">
                {editingField === 'creature' ? (
                  <Input
                    ref={metaInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={onEditKey}
                    className="acp-left-header__meta-input"
                    aria-label={t('identity.creaturePlaceholderShort')}
                    size="sm"
                  />
                ) : (
                  <button
                    type="button"
                    data-overflow-trigger
                    className={`acp-left-header__meta-tag${!displayIdentity.creature ? ' is-empty' : ''}`}
                    onClick={() => startEdit('creature')}
                  >
                    <OverflowText>{displayIdentity.creature || t('identity.creaturePlaceholderShort')}</OverflowText>
                  </button>
                )}
                {(displayIdentity.creature || displayIdentity.vibe) && (
                  <span className="acp-left-header__meta-dot" aria-hidden>·</span>
                )}
                {editingField === 'vibe' ? (
                  <Input
                    ref={metaInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={onEditKey}
                    className="acp-left-header__meta-input"
                    aria-label={t('identity.vibePlaceholderShort')}
                    size="sm"
                  />
                ) : (
                  <button
                    type="button"
                    data-overflow-trigger
                    className={`acp-left-header__meta-tag${!displayIdentity.vibe ? ' is-empty' : ''}`}
                    onClick={() => startEdit('vibe')}
                  >
                    <OverflowText>{displayIdentity.vibe || t('identity.vibePlaceholderShort')}</OverflowText>
                  </button>
                )}
              </div>
            </div>
          </div>

          <AssistantQuickInput
            workspacePath={workspacePath}
            workspaceId={workspace?.id}
            assistantName={identityName}
          />
          <ScrollArea className="acp-sessions-area" data-openbitfun-component="assistant-config-page" data-openbitfun-part="sessions">
            <PageHeader className="acp-sessions-area__title" size="sm" level={3} title={t('nursery.assistant.sessionsSectionTitle')} />
            <SessionsSection
              workspaceId={workspace?.id}
              workspacePath={workspacePath}
              presentation={{
                kind: 'assistant',
                assistant: {
                  id: workspace?.assistantId || workspace?.id || '',
                  name: identityName,
                  avatar: displayIdentity.avatar,
                  emoji: displayIdentity.emoji,
                },
              }}
              isActiveWorkspace
            />
          </ScrollArea>
        </div>

        {/* Right: persona docs + schedule */}
        <div className="acp-layout__right">
          {rightView === 'personaDoc' ? renderPersonaDocPanel() : renderInfoPanel()}
        </div>
      </div>
    </div>
  );
};

export default AssistantConfigPage;
