import { OverflowText, Button, Icon, Input, ScrollArea, Switch, Textarea, Tooltip, type IconSource } from '@openbitfun/ui';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  FolderTree,
  Minus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CustomAgentAPI,
  type CustomAgentKind,
  type CustomAgentLevel,
  type UserContextSection,
} from '@/infrastructure/api/service-api/CustomAgentAPI';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useNotification } from '@/shared/notification-system';
import { isUserSelectableToolName } from '@/shared/utils/toolVisibility';
import { useAgentsStore } from '../agentsStore';
import {
  filterToolsForReviewMode,
  normalizeReviewModeState,
  type SubagentEditorToolInfo,
} from './subagentEditorUtils';
import { ToolGroupPicker, ToolGroupSummary } from './ToolGroupPicker';
import { useUserToolGroups } from './useUserToolGroups';
import '../AgentsView.scss';
import './CreateAgentPage.scss';

const ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_MODE_POLICY: UserContextSection[] = [
  'workspace_context',
  'workspace_instructions',
  'project_layout',
];
const DEFAULT_SUBAGENT_POLICY: UserContextSection[] = [
  'workspace_context',
  'workspace_instructions',
  'project_layout',
];
const DEFAULT_CUSTOM_MODE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Delete',
  'ExecCommand',
  'WriteStdin',
  'ExecControl',
  'Task',
  'Skill',
  'WebSearch',
  'WebFetch',
  'get_goal',
  'create_goal',
  'update_goal',
] as const;
const DEFAULT_CUSTOM_SUBAGENT_TOOLS = ['LS', 'Read', 'Glob', 'Grep'] as const;
const VISIBLE_CONTEXT_SECTIONS: UserContextSection[] = [
  'workspace_context',
  'workspace_instructions',
  'project_layout',
];
const CONTEXT_SECTION_ICONS: Record<UserContextSection, IconSource> = {
  workspace_context: { name: 'terminal' },
  workspace_instructions: { glyph: FileText },
  project_layout: { glyph: FolderTree },
};
const TOOL_SUMMARY_MIN_HEIGHT = 96;
const TOOL_SUMMARY_MAX_HEIGHT = 360;

function defaultReadonlyForKind(kind: CustomAgentKind): boolean {
  return kind === 'subagent';
}

function defaultPolicyForKind(kind: CustomAgentKind): UserContextSection[] {
  return kind === 'mode' ? DEFAULT_MODE_POLICY : DEFAULT_SUBAGENT_POLICY;
}

function defaultSelectedTools(
  tools: SubagentEditorToolInfo[],
  kind: CustomAgentKind,
  review: boolean,
): Set<string> {
  const defaultTools =
    kind === 'mode' ? DEFAULT_CUSTOM_MODE_TOOLS : DEFAULT_CUSTOM_SUBAGENT_TOOLS;
  const selectableToolNames = new Set(
    filterToolsForReviewMode(tools, kind === 'subagent' && review).map((tool) => tool.name),
  );

  return new Set(
    defaultTools.filter((toolName) => selectableToolNames.has(toolName)),
  );
}

const CreateAgentPage: React.FC = () => {
  const { t } = useTranslation('scenes/agents');
  const notification = useNotification();
  const { hasWorkspace, workspacePath } = useCurrentWorkspace();
  const { openHome, agentEditorMode, editingAgentId } = useAgentsStore();
  const {
    groups: userToolGroups,
    saveGroups: saveUserToolGroups,
  } = useUserToolGroups();

  const isEdit = agentEditorMode === 'edit' && Boolean(editingAgentId);

  const [kind, setKind] = useState<CustomAgentKind>('mode');
  const [level, setLevel] = useState<CustomAgentLevel>('user');
  const [agentId, setAgentId] = useState('');
  const [agentIdError, setAgentIdError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [readonly, setReadonly] = useState(defaultReadonlyForKind('mode'));
  const [review, setReview] = useState(false);
  const [toolInfos, setToolInfos] = useState<SubagentEditorToolInfo[]>([]);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [toolsEditing, setToolsEditing] = useState(false);
  const [pendingTools, setPendingTools] = useState<Set<string> | null>(null);
  const [toolSummaryHeight, setToolSummaryHeight] = useState<number | null>(null);
  const [userContextPolicy, setUserContextPolicy] = useState<Set<UserContextSection>>(
    () => new Set(defaultPolicyForKind('mode')),
  );
  const [submitting, setSubmitting] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const definitionColumnRef = useRef<HTMLDivElement>(null);
  const capabilitiesColumnRef = useRef<HTMLDivElement>(null);
  const toolSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    toolAPI
      .getAllToolsInfo()
      .then((tools) => {
        const normalizedTools = tools
          .map((tool): SubagentEditorToolInfo | null => {
            const toolName = typeof tool?.name === 'string' ? tool.name : '';
            if (!toolName || !isUserSelectableToolName(toolName)) {
              return null;
            }
            return {
              name: toolName,
              description: typeof tool?.description === 'string' ? tool.description : '',
              isReadonly: Boolean(tool?.is_readonly),
              needsPermissions: !tool?.is_readonly,
              dynamicInfo: tool?.dynamic_info,
            };
          })
          .filter((tool): tool is SubagentEditorToolInfo => Boolean(tool));
        setToolInfos(normalizedTools);
      })
      .catch(() => setToolInfos([]));
  }, []);

  useEffect(() => {
    if (!hasWorkspace && level === 'project') {
      setLevel('user');
    }
  }, [hasWorkspace, level]);

  useEffect(() => {
    if (isEdit) {
      return;
    }
    setLevel('user');
    setReadonly(defaultReadonlyForKind(kind));
    setReview(false);
    setUserContextPolicy(new Set(defaultPolicyForKind(kind)));
    setSelectedTools(defaultSelectedTools(toolInfos, kind, false));
    setToolsEditing(false);
    setPendingTools(null);
  }, [isEdit, kind, toolInfos]);

  useEffect(() => {
    if (isEdit || toolInfos.length === 0) {
      return;
    }

    setSelectedTools((prev) => {
      if (prev.size > 0) {
        return prev;
      }
      return defaultSelectedTools(toolInfos, kind, review);
    });
  }, [isEdit, kind, review, toolInfos]);

  useEffect(() => {
    if (!isEdit || !editingAgentId) {
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    (async () => {
      try {
        const detail = await CustomAgentAPI.getCustomAgentDetail({
          agentId: editingAgentId,
          workspacePath: workspacePath || undefined,
        });
        if (cancelled) {
          return;
        }
        setKind(detail.kind);
        setLevel(detail.level);
        setAgentId(detail.agentId);
        setName(detail.name);
        setDescription(detail.description);
        setPrompt(detail.prompt);
        setReadonly(detail.readonly);
        setReview(detail.review);
        setSelectedTools(new Set(detail.tools ?? []));
        setToolsEditing(false);
        setPendingTools(null);
        setUserContextPolicy(new Set(detail.userContextPolicy));
        setAgentIdError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setDetailError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editingAgentId, isEdit, workspacePath]);

  const validateAgentId = useCallback(
    (value: string) => {
      if (!value.trim()) {
        return t('agentsOverview.form.idRequired');
      }
      if (!ID_REGEX.test(value.trim())) {
        return t('agentsOverview.form.idFormat');
      }
      return null;
    },
    [t],
  );

  const toggleContextSection = useCallback((section: UserContextSection) => {
    setUserContextPolicy((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  const handleReviewChange = useCallback(
    (nextReview: boolean) => {
      setReview(nextReview);
      const next = normalizeReviewModeState({
        review: nextReview,
        readonly,
        selectedTools,
        availableTools: toolInfos,
      });
      setReadonly(next.readonly);
      setSelectedTools(next.selectedTools);
      setPendingTools((current) => current ? new Set(next.selectedTools) : null);
    },
    [readonly, selectedTools, toolInfos],
  );

  const handleReadonlyChange = useCallback(
    (nextReadonly: boolean) => {
      if (review) {
        setReadonly(true);
        return;
      }
      setReadonly(nextReadonly);
    },
    [review],
  );

  const selectableTools = useMemo(
    () => filterToolsForReviewMode(toolInfos, kind === 'subagent' && review),
    [kind, review, toolInfos],
  );
  const selectableGroupTools = useMemo(() => selectableTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    is_readonly: tool.isReadonly,
    needs_permissions: tool.needsPermissions,
    dynamic_info: tool.dynamicInfo,
  })), [selectableTools]);
  const managementGroupTools = useMemo(() => toolInfos.map((tool) => ({
    name: tool.name,
    description: tool.description,
    is_readonly: tool.isReadonly,
    needs_permissions: tool.needsPermissions,
    dynamic_info: tool.dynamicInfo,
  })), [toolInfos]);

  useLayoutEffect(() => {
    const desktopMediaQuery = window.matchMedia('(min-width: 961px)');

    const updateToolSummaryHeight = () => {
      if (toolsEditing || !desktopMediaQuery.matches) {
        setToolSummaryHeight(null);
        return;
      }

      const definitionColumn = definitionColumnRef.current;
      const capabilitiesColumn = capabilitiesColumnRef.current;
      const toolSummary = toolSummaryRef.current;
      if (!definitionColumn || !capabilitiesColumn || !toolSummary) {
        setToolSummaryHeight(null);
        return;
      }

      const availableHeight =
        capabilitiesColumn.getBoundingClientRect().bottom
        - toolSummary.getBoundingClientRect().top;
      const nextHeight = Math.min(
        TOOL_SUMMARY_MAX_HEIGHT,
        Math.max(TOOL_SUMMARY_MIN_HEIGHT, Math.floor(availableHeight)),
      );
      setToolSummaryHeight((currentHeight) => (
        currentHeight === nextHeight ? currentHeight : nextHeight
      ));
    };

    updateToolSummaryHeight();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateToolSummaryHeight);
    if (definitionColumnRef.current) {
      resizeObserver?.observe(definitionColumnRef.current);
    }
    if (capabilitiesColumnRef.current) {
      resizeObserver?.observe(capabilitiesColumnRef.current);
    }
    window.addEventListener('resize', updateToolSummaryHeight);
    desktopMediaQuery.addEventListener('change', updateToolSummaryHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateToolSummaryHeight);
      desktopMediaQuery.removeEventListener('change', updateToolSummaryHeight);
    };
  }, [selectableTools.length, toolsEditing]);

  const contextSectionLabels: Record<UserContextSection, string> = {
    workspace_context: t('agentsOverview.form.contextWorkspaceContext'),
    workspace_instructions: t('agentsOverview.form.contextWorkspaceInstructions'),
    project_layout: t('agentsOverview.form.contextProjectLayout'),
  };
  const contextSectionTooltips: Record<UserContextSection, string> = {
    workspace_context: t('agentsOverview.form.contextWorkspaceContextTooltip'),
    workspace_instructions: t('agentsOverview.form.contextWorkspaceInstructionsTooltip'),
    project_layout: t('agentsOverview.form.contextProjectLayoutTooltip'),
  };
  const selectedContextSections = VISIBLE_CONTEXT_SECTIONS.filter((section) => (
    userContextPolicy.has(section)
  ));

  const handleSubmit = useCallback(async () => {
    const nextAgentIdError = validateAgentId(agentId);
    setAgentIdError(nextAgentIdError);
    if (nextAgentIdError) {
      return;
    }
    if (!description.trim()) {
      notification.error(t('agentsOverview.form.descRequired'));
      return;
    }
    if (!prompt.trim()) {
      notification.error(t('agentsOverview.form.promptRequired'));
      return;
    }
    if (kind === 'subagent' && level === 'project' && !workspacePath) {
      notification.error(t('agentsOverview.form.noWorkspace'));
      return;
    }
    if (kind === 'mode' && level === 'project') {
      notification.error(t('agentsOverview.form.modeUserOnly'));
      return;
    }
    if (isEdit && !editingAgentId) {
      return;
    }

    setSubmitting(true);
    try {
      const normalizedId = agentId.trim();
      const effectiveName = name.trim() || normalizedId;
      const payload = {
        kind,
        level: kind === 'subagent' ? level : 'user',
        id: normalizedId,
        name: effectiveName,
        description: description.trim(),
        prompt: prompt.trim(),
        readonly,
        review: kind === 'subagent' ? review : false,
        tools: selectedTools.size > 0 ? Array.from(selectedTools) : undefined,
        userContextPolicy: Array.from(userContextPolicy),
        workspacePath: kind === 'subagent' && level === 'project' ? workspacePath : undefined,
      } as const;

      if (isEdit && editingAgentId) {
        await CustomAgentAPI.updateCustomAgent({
          agentId: editingAgentId,
          name: payload.name,
          description: payload.description,
          prompt: payload.prompt,
          readonly: payload.readonly,
          review: payload.review,
          tools: payload.tools,
          userContextPolicy: payload.userContextPolicy,
          workspacePath: payload.workspacePath,
        });
        notification.success(t('agentsOverview.form.updateSuccess', { name: payload.name }));
      } else {
        await CustomAgentAPI.createCustomAgent(payload);
        notification.success(t('agentsOverview.form.createSuccess', { name: payload.name }));
      }
      openHome();
    } catch (error) {
      notification.error(
        `${
          isEdit
            ? t('agentsOverview.form.updateFailed')
            : t('agentsOverview.form.createFailed')
        }${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    agentId,
    description,
    editingAgentId,
    isEdit,
    kind,
    level,
    name,
    notification,
    openHome,
    prompt,
    readonly,
    review,
    selectedTools,
    t,
    userContextPolicy,
    validateAgentId,
    workspacePath,
  ]);

  const formTitle = isEdit
    ? t('agentsOverview.form.titleEdit')
    : t('agentsOverview.form.title');
  const formSubtitle = isEdit
    ? t(
        kind === 'subagent'
          ? 'agentsOverview.form.subtitleEditSubagent'
          : 'agentsOverview.form.subtitleEditMode',
      )
    : t('agentsOverview.form.subtitle');
  const submitLabel = isEdit
    ? t('agentsOverview.form.save')
    : t('agentsOverview.form.submit');
  if (isEdit && detailLoading) {
    return (
      <div className="tv" data-openbitfun-component="create-agent-page" data-openbitfun-part="root" data-openbitfun-state="loading">
        <div className="tv__editor-bar" data-openbitfun-component="create-agent-page" data-openbitfun-part="editorBar">
          <Button
            variant="outline"
            size="sm"
            leadingIcon={<Icon name="arrow-left" size="lg" />}
            onClick={openHome}
          >
            {t('agentsOverview.backToOverview')}
          </Button>
        </div>
        <ScrollArea className="th__list-body">
          <div className="th__list-inner" data-openbitfun-component="create-agent-page" data-openbitfun-part="body">
            <p className="th__title-sub">{t('agentsOverview.form.loadingDetail')}</p>
          </div>
        </ScrollArea>
      </div>
    );
  }

  if (isEdit && detailError) {
    return (
      <div className="tv" data-openbitfun-component="create-agent-page" data-openbitfun-part="root" data-openbitfun-state="error">
        <div className="tv__editor-bar" data-openbitfun-component="create-agent-page" data-openbitfun-part="editorBar">
          <Button
            variant="outline"
            size="sm"
            leadingIcon={<Icon name="arrow-left" size="lg" />}
            onClick={openHome}
          >
            {t('agentsOverview.backToOverview')}
          </Button>
        </div>
        <ScrollArea className="th__list-body">
          <div className="th__list-inner">
            <p className="th-create-panel__error" data-openbitfun-component="create-agent-page" data-openbitfun-part="error" role="alert">{detailError}</p>
            <Button variant="fill" size="sm" onClick={openHome}>
              {t('agentsOverview.form.cancel')}
            </Button>
          </div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div className="tv th-create-page" data-openbitfun-component="create-agent-page" data-openbitfun-part="root">
      <ScrollArea className="th__list-body th-create-page__body">
        <div className="th__list-inner th-create-page__inner" data-openbitfun-component="create-agent-page" data-openbitfun-part="body">
          <header className="th-create-page__head" data-openbitfun-component="create-agent-page" data-openbitfun-part="heading">
            <div className="th-create-page__heading">
              <h2 className="th__title">{formTitle}</h2>
              <p className="th__title-sub">{formSubtitle}</p>
              {!isEdit && (
                <p className="th__title-sub">{t('agentsOverview.form.createThroughChatHint')}</p>
              )}
            </div>
            <div className="th-create-page__actions" data-openbitfun-component="create-agent-page" data-openbitfun-part="actions">
              <Button
                className="th-create-page__action"
                type="button"
                variant="fill"
                size="sm"
                onClick={openHome}
                disabled={submitting}
              >
                {t('agentsOverview.form.cancel')}
              </Button>
              <Button
                className="th-create-page__action"
                type="submit"
                form="custom-agent-form"
                variant="primary"
                size="sm"
                disabled={submitting || toolsEditing}
                aria-busy={submitting}
              >
                {submitting ? '…' : submitLabel}
              </Button>
            </div>
          </header>

          <form
            id="custom-agent-form"
            className="th-create-page__form"
            data-openbitfun-component="create-agent-page"
            data-openbitfun-part="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (submitting || toolsEditing) {
                return;
              }
              void handleSubmit();
            }}
          >
            <div className="th-create-page__columns" data-openbitfun-component="create-agent-page" data-openbitfun-part="columns">
              <section
                ref={definitionColumnRef}
                className="th-create-page__panel th-create-page__panel--definition"
                data-openbitfun-component="create-agent-page"
                data-openbitfun-part="column"
              >
                <div className="th-create-page__section">
                  <div className="th-create-page__section-heading" data-openbitfun-component="create-agent-page" data-openbitfun-part="sectionHeading">
                    <span className="th-create-page__section-marker" aria-hidden="true">
                      <Minus size={18} strokeWidth={5} />
                    </span>
                    <h3>{t('agentsOverview.form.basicInformation')}</h3>
                  </div>

                  <div className="th-create-panel__field" data-openbitfun-component="create-agent-page" data-openbitfun-part="field">
                    <span className="th-create-panel__label">{t('agentsOverview.form.kind')}</span>
                    <div
                      className="th-create-panel__level-group"
                      data-openbitfun-component="create-agent-page"
                      data-openbitfun-part="levelGroup"
                      role="group"
                      aria-label={t('agentsOverview.form.kind')}
                    >
                      {(['mode', 'subagent'] as CustomAgentKind[]).map((candidateKind) => (
                        <Tooltip
                          key={candidateKind}
                          content={t(
                            candidateKind === 'mode'
                              ? 'agentsOverview.form.kindAgentTooltip'
                              : 'agentsOverview.form.kindSubagentTooltip',
                          )}
                          placement="top"
                        >
                          <button
                            type="button"
                            disabled={isEdit}
                            className={`th-create-panel__level-btn${kind === candidateKind ? ' is-active' : ''}`}
                            data-openbitfun-component="create-agent-page"
                            data-openbitfun-part="levelOption"
                            data-openbitfun-state={kind === candidateKind ? 'active' : undefined}
                            aria-pressed={kind === candidateKind}
                            onClick={() => setKind(candidateKind)}
                          >
                            {candidateKind === 'mode'
                              ? t('filters.agent')
                              : t('filters.subagent')}
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                  </div>

                  <div className="th-create-panel__identity-fields">
                    <div className="th-create-panel__field">
                      <label className="th-create-panel__label" htmlFor="custom-agent-id">
                        {t('agentsOverview.form.id')}
                      </label>
                      <Input
                        id="custom-agent-id"
                        value={agentId}
                        onChange={(event) => {
                          setAgentId(event.target.value);
                          setAgentIdError(validateAgentId(event.target.value));
                        }}
                        onBlur={() => setAgentIdError(validateAgentId(agentId))}
                        placeholder={t('agentsOverview.form.idPlaceholder')}
                        invalid={!!agentIdError}
                        disabled={isEdit}
                        size="sm"
                      />
                      {agentIdError ? (
                        <span className="th-create-panel__error" data-openbitfun-component="create-agent-page" data-openbitfun-part="error" role="alert">{agentIdError}</span>
                      ) : null}
                    </div>

                    <div className="th-create-panel__field">
                      <label className="th-create-panel__label" htmlFor="custom-agent-name">
                        {t('agentsOverview.form.name')}
                      </label>
                      <Input
                        id="custom-agent-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={t('agentsOverview.form.namePlaceholder')}
                        size="sm"
                      />
                    </div>
                  </div>

                  <div className="th-create-panel__field">
                    <label className="th-create-panel__label" htmlFor="custom-agent-description">
                      {t('agentsOverview.form.description')}
                    </label>
                    <Input
                      id="custom-agent-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={t('agentsOverview.form.descPlaceholder')}
                      size="sm"
                    />
                  </div>

                  {kind === 'subagent' ? (
                    <div className="th-create-panel__field">
                      <span className="th-create-panel__label">{t('agentsOverview.form.level')}</span>
                      <div
                        className="th-create-panel__level-group"
                        data-openbitfun-component="create-agent-page"
                        data-openbitfun-part="levelGroup"
                        role="group"
                        aria-label={t('agentsOverview.form.level')}
                      >
                        {(['user', 'project'] as CustomAgentLevel[]).map((candidateLevel) => {
                          const disabled =
                            (candidateLevel === 'project' && !hasWorkspace) || isEdit;
                          return (
                            <button
                              data-openbitfun-component="create-agent-page"
                              data-openbitfun-part="levelOption"
                              key={candidateLevel}
                              type="button"
                              disabled={disabled}
                              className={`th-create-panel__level-btn${level === candidateLevel ? ' is-active' : ''}`}
                              data-openbitfun-state={level === candidateLevel ? 'active' : undefined}
                              aria-pressed={level === candidateLevel}
                              onClick={() => setLevel(candidateLevel)}
                              title={
                                disabled && !isEdit && candidateLevel === 'project'
                                  ? t('agentsOverview.form.noWorkspace')
                                  : undefined
                              }
                            >
                              {candidateLevel === 'user'
                                ? t('agentsOverview.filterUser')
                                : t('agentsOverview.filterProject')}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="th-create-panel__field th-create-panel__field--row">
                    <div className="th-create-panel__readonly-row">
                      <span className="th-create-panel__label">
                        {t('agentsOverview.form.readonly')}
                      </span>
                      <Switch
                        checked={readonly}
                        disabled={kind === 'subagent' && review}
                        onChange={(event) => handleReadonlyChange(event.target.checked)}
                        aria-label={t('agentsOverview.form.readonly')}
                      />
                    </div>
                    {kind === 'subagent' ? (
                      <div className="th-create-panel__readonly-row">
                        <span className="th-create-panel__label">
                          {t('agentsOverview.form.review')}
                        </span>
                        <Switch
                          checked={review}
                          onChange={(event) => handleReviewChange(event.target.checked)}
                          aria-label={t('agentsOverview.form.review')}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                {selectableTools.length > 0 ? (
                  <>
                    <div className="th-create-page__divider" aria-hidden="true" />
                    <div className="th-create-page__section th-create-page__section--tools">
                      <div className="th-create-panel__field-head">
                        <div
                          className="th-create-page__section-heading th-create-page__section-heading--tools"
                          data-openbitfun-component="create-agent-page"
                          data-openbitfun-part="sectionHeading"
                        >
                          <h3>{t('agentsOverview.form.tools')}</h3>
                          <span className="th-create-panel__label-hint">
                            {kind === 'subagent' && review
                              ? t('agentsOverview.form.reviewToolsHint')
                              : t('agentsOverview.form.toolsHint', {
                                  optionalLabel: t('agentsOverview.form.toolsOptional'),
                                })}
                          </span>
                        </div>
                        {toolsEditing ? (
                          <div className="th-create-panel__tool-edit-actions">
                            <Button
                              type="button"
                              variant="fill"
                              size="sm"
                              onClick={() => {
                                setToolsEditing(false);
                                setPendingTools(null);
                              }}
                              disabled={submitting}
                            >
                              {t('agentsOverview.cancel')}
                            </Button>
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              onClick={() => {
                                setSelectedTools(new Set(pendingTools ?? selectedTools));
                                setToolsEditing(false);
                                setPendingTools(null);
                              }}
                              disabled={submitting}
                            >
                              {t('agentsOverview.save')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setPendingTools(new Set(selectedTools));
                              setToolsEditing(true);
                            }}
                            disabled={submitting}
                            leadingIcon={<Icon name="settings" size="sm" aria-hidden="true" />}
                          >

                            {t('agentsOverview.toolsEdit')}
                          </Button>
                        )}
                      </div>
                      {toolsEditing ? (
                        <ToolGroupPicker
                          tools={selectableGroupTools}
                          managementTools={managementGroupTools}
                          selectedToolNames={Array.from(pendingTools ?? selectedTools)}
                          userGroups={userToolGroups}
                          onSelectionChange={(toolNames) => setPendingTools(new Set(toolNames))}
                          onSaveUserGroups={saveUserToolGroups}
                          disabled={submitting}
                          testId="custom-agent-tool-groups"
                        />
                      ) : (
                        <ScrollArea
                          ref={toolSummaryRef}
                          className="th-create-panel__tool-summary"
                          style={toolSummaryHeight === null ? undefined : { height: toolSummaryHeight }}
                        >
                          <ToolGroupSummary
                            tools={selectableGroupTools}
                            selectedToolNames={Array.from(selectedTools)}
                            userGroups={userToolGroups}
                          />
                        </ScrollArea>
                      )}
                    </div>
                  </>
                ) : null}
              </section>

              <section
                ref={capabilitiesColumnRef}
                className="th-create-page__panel th-create-page__panel--capabilities"
                data-openbitfun-component="create-agent-page"
                data-openbitfun-part="column"
              >
                <div className="th-create-page__section th-create-page__section--context">
                  <div
                    className="th-create-page__context-heading"
                    data-openbitfun-component="create-agent-page"
                    data-openbitfun-part="sectionHeading"
                  >
                    <h3>{t('agentsOverview.form.contextPolicy')}</h3>
                    <span className="th-create-panel__label-hint">
                      {t('agentsOverview.form.contextPolicyHint')}
                    </span>
                  </div>
                  <div className="th-create-panel__context-options" data-openbitfun-component="create-agent-page" data-openbitfun-part="tools">
                    {VISIBLE_CONTEXT_SECTIONS.map((section) => {
                      const label = contextSectionLabels[section];
                      const tooltipContent = contextSectionTooltips[section];
                      const contextIcon = CONTEXT_SECTION_ICONS[section];
                      const isSelected = userContextPolicy.has(section);
                      return (
                        <Tooltip
                          key={section}
                          content={<span className="th-create-panel__tooltip-content">{tooltipContent}</span>}
                          placement="top"
                          interactive
                        >
                          <button data-overflow-trigger
                            type="button"
                            className={`th-create-panel__context-option${isSelected ? ' is-on' : ''}`}
                            data-openbitfun-component="create-agent-page"
                            data-openbitfun-part="tool"
                            data-openbitfun-state={isSelected ? 'active' : undefined}
                            onClick={() => toggleContextSection(section)}
                            aria-label={`${label}: ${tooltipContent}`}
                            aria-pressed={isSelected}
                          >
                            <Icon {...contextIcon} size="sm" />
                            <OverflowText>{label}</OverflowText>
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>

                <div className="th-create-panel__field th-create-panel__field--prompt">
                  <label className="th-create-panel__label th-create-panel__label--strong" htmlFor="custom-agent-prompt">
                    {t('agentsOverview.form.prompt')}
                  </label>
                  <div
                    className="th-create-panel__prompt-editor"
                    data-openbitfun-component="create-agent-page"
                    data-openbitfun-part="promptEditor"
                  >
                    <div
                      id="custom-agent-runtime-context-preview"
                      className="th-create-panel__prompt-context-preview"
                      data-openbitfun-component="create-agent-page"
                      data-openbitfun-part="contextPreview"
                      aria-live="polite"
                    >
                      <span className="th-create-panel__prompt-context-label">
                        {t('agentsOverview.form.contextPreviewLabel')}
                      </span>
                      {selectedContextSections.length > 0 ? (
                        <span className="th-create-panel__prompt-context-items">
                          {selectedContextSections.map((section) => {
                            const contextIcon = CONTEXT_SECTION_ICONS[section];
                            return (
                              <span
                                key={section}
                                className="th-create-panel__prompt-context-item"
                              >
                                <Icon {...contextIcon} size="xs" />
                                <span>{contextSectionLabels[section]}</span>
                              </span>
                            );
                          })}
                        </span>
                      ) : (
                        <span className="th-create-panel__prompt-context-empty">
                          {t('agentsOverview.form.contextPreviewEmpty')}
                        </span>
                      )}
                    </div>
                    <div
                      data-openbitfun-component="create-agent-page"
                      data-openbitfun-part="prompt"
                      className="th-create-panel__prompt-control"
                    >
                      <Textarea
                        id="custom-agent-prompt"
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder={t('agentsOverview.form.promptPlaceholder')}
                        aria-describedby="custom-agent-runtime-context-preview"
                        layout="fill"
                        resize="none"
                        rows={20}
                      />
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </form>
        </div>
      </ScrollArea>
    </div>
  );
};

export default CreateAgentPage;
