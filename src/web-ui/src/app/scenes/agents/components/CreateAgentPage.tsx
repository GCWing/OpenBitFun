import { Button, Checkbox, DialogBody, DialogClose, Icon, IconButton, Input, PageHeader, ScrollArea, SetupWizard, Switch, Tooltip, type IconSource } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  FolderTree,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  CustomAgentAPI,
  type CustomAgentKind,
  type CustomAgentLevel,
  type UserContextSection,
} from '@/infrastructure/api/service-api/CustomAgentAPI';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import type { WorkspaceInfo } from '@/shared/types';
import { useNotification } from '@/shared/notification-system';
import { isUserSelectableToolName } from '@/shared/utils/toolVisibility';
import { useAgentsStore } from '../agentsStore';
import { isAgentProfileConfigurableToolName } from '../agentToolVisibility';
import {
  filterToolsForReadonlyMode,
  normalizeToolPermissionState,
  type SubagentEditorToolInfo,
} from './subagentEditorUtils';
import { createSuggestedAgentId } from './suggestAgentId';
import { ToolGroupPicker, ToolGroupSummary } from './ToolGroupPicker';
import { setToolGroupSelection } from './toolGroups';
import { useUserToolGroups } from './useUserToolGroups';
import '../AgentsView.scss';
import './CreateAgentPage.scss';

const MEditor = React.lazy(() => import('@/tools/editor/meditor/components/MEditor').then((module) => ({ default: module.MEditor })));

const DEFAULT_MODE_POLICY: UserContextSection[] = [
  'workspace_context',
  'workspace_instructions',
];
const DEFAULT_SUBAGENT_POLICY: UserContextSection[] = [
  'workspace_context',
  'workspace_instructions',
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
  'AgentSpawn',
  'AgentSendInput',
  'AgentControl',
  'AgentWait',
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

function defaultReadonlyForKind(kind: CustomAgentKind): boolean {
  return kind === 'subagent';
}

function defaultPolicyForKind(kind: CustomAgentKind): UserContextSection[] {
  return kind === 'mode' ? DEFAULT_MODE_POLICY : DEFAULT_SUBAGENT_POLICY;
}

function defaultSelectedTools(
  tools: SubagentEditorToolInfo[],
  kind: CustomAgentKind,
  readonly: boolean,
): Set<string> {
  const defaultTools =
    kind === 'mode' ? DEFAULT_CUSTOM_MODE_TOOLS : DEFAULT_CUSTOM_SUBAGENT_TOOLS;
  const selectableToolNames = new Set(
    filterToolsForReadonlyMode(tools, readonly).map((tool) => tool.name),
  );

  return new Set(
    defaultTools.filter((toolName) => selectableToolNames.has(toolName)),
  );
}

interface CreateAgentPageProps {
  workspace?: WorkspaceInfo;
  initialLevel?: CustomAgentLevel;
  standalone?: boolean;
  titleId?: string;
  onCancel?: () => void;
  onCreated?: () => void;
}

const CreateAgentPage: React.FC<CreateAgentPageProps> = ({ standalone = false, titleId, onCancel, onCreated, workspace: targetWorkspace, initialLevel = 'user' }) => {
  const { t, formatNumber } = useI18n('scenes/agents');
  const notification = useNotification();
  const current = useCurrentWorkspace();
  const workspace = targetWorkspace ?? current.workspace;
  const hasWorkspace = Boolean(workspace);
  const workspaceId = workspace?.id;
  const { openHome, agentEditorMode, editingAgentId } = useAgentsStore();
  const closeEditor = onCancel ?? openHome;
  const formInstanceId = React.useId();
  const formId = `${formInstanceId}-custom-agent-form`;
  const fieldId = useCallback((field: string) => `${formInstanceId}-custom-agent-${field}`, [formInstanceId]);
  const formRef = useRef<HTMLFormElement>(null);
  const promptControlRef = useRef<HTMLDivElement>(null);
  const toolEditButtonRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState(0);
  const steps = [
    {
      id: 'basics',
      label: t('agentsOverview.form.basicInformation'),
      title: t('agentsOverview.form.wizard.basicsTitle'),
      description: t('agentsOverview.form.wizard.basicsDescription'),
    },
    {
      id: 'prompt',
      label: t('agentsOverview.form.prompt'),
      title: t('agentsOverview.form.wizard.promptTitle'),
      description: t('agentsOverview.form.wizard.promptDescription'),
    },
    {
      id: 'tools',
      label: t('agentsOverview.form.tools'),
      title: t('agentsOverview.form.wizard.toolsTitle'),
      description: t('agentsOverview.form.wizard.toolsDescription'),
    },
  ];

  useEffect(() => {
    if (!standalone) return;
    // The Markdown editor owns focus once its lazy-loaded editing surface mounts.
    if (step === 1) return;
    const firstControl = formRef.current?.querySelector<HTMLElement>('input:not(:disabled), textarea')
      ?? formRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
    firstControl?.focus();
  }, [standalone, step]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const {
    groups: userToolGroups,
    saveGroups: saveUserToolGroups,
  } = useUserToolGroups();

  const isEdit = !standalone && agentEditorMode === 'edit' && Boolean(editingAgentId);

  const [kind, setKind] = useState<CustomAgentKind>(initialLevel === 'project' ? 'subagent' : 'mode');
  const [level, setLevel] = useState<CustomAgentLevel>(initialLevel);
  const [agentId, setAgentId] = useState(createSuggestedAgentId);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  const [description, setDescription] = useState('');
  const [descriptionError, setDescriptionError] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState(false);
  const [readonly, setReadonly] = useState(defaultReadonlyForKind('mode'));
  const [review, setReview] = useState(false);
  const [toolInfos, setToolInfos] = useState<SubagentEditorToolInfo[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsLoadError, setToolsLoadError] = useState(false);
  const [toolsAttempt, setToolsAttempt] = useState(0);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [toolsEditing, setToolsEditing] = useState(false);
  const [pendingTools, setPendingTools] = useState<Set<string> | null>(null);
  const [pendingReadonly, setPendingReadonly] = useState<boolean | null>(null);
  const toolSelectionInitialized = useRef(false);
  const [userContextPolicy, setUserContextPolicy] = useState<Set<UserContextSection>>(
    () => new Set(defaultPolicyForKind('mode')),
  );
  const [submitting, setSubmitting] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setToolsLoading(true);
    setToolsLoadError(false);
    toolAPI
      .getAllToolsInfo()
      .then((tools) => {
        if (cancelled) return;
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
      .catch(() => {
        if (cancelled) return;
        setToolInfos([]);
        setToolsLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => { cancelled = true; };
  }, [toolsAttempt]);

  useEffect(() => {
    if (!hasWorkspace && level === 'project') {
      setLevel('user');
    }
  }, [hasWorkspace, level]);

  useEffect(() => {
    if (isEdit) {
      return;
    }
    setLevel(kind === 'subagent' ? initialLevel : 'user');
    setReadonly(defaultReadonlyForKind(kind));
    setReview(false);
    setUserContextPolicy(new Set(defaultPolicyForKind(kind)));
    setSelectedTools(new Set());
    toolSelectionInitialized.current = false;
    setToolsEditing(false);
    setPendingTools(null);
    setPendingReadonly(null);
  }, [isEdit, kind, initialLevel]);

  useEffect(() => {
    if (isEdit || toolInfos.length === 0 || toolSelectionInitialized.current) {
      return;
    }
    toolSelectionInitialized.current = true;
    setSelectedTools(defaultSelectedTools(toolInfos, kind, defaultReadonlyForKind(kind)));
  }, [isEdit, kind, toolInfos]);

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
          workspaceId: workspaceId || undefined,
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
        setPendingReadonly(null);
        setUserContextPolicy(new Set(detail.userContextPolicy));
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
  }, [editingAgentId, isEdit, workspaceId]);

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
      const next = normalizeToolPermissionState({
        review: nextReview,
        readonly,
        selectedTools,
        availableTools: toolInfos,
      });
      setReadonly(next.readonly);
      setSelectedTools(next.selectedTools);
      setPendingTools((current) => current ? normalizeToolPermissionState({
        review: nextReview,
        readonly: pendingReadonly ?? readonly,
        selectedTools: current,
        availableTools: toolInfos,
      }).selectedTools : null);
      if (nextReview && toolsEditing) setPendingReadonly(true);
    },
    [pendingReadonly, readonly, selectedTools, toolInfos, toolsEditing],
  );

  const handleReadonlyChange = useCallback(
    (nextReadonly: boolean) => {
      const next = normalizeToolPermissionState({
        review,
        readonly: nextReadonly,
        selectedTools: pendingTools ?? selectedTools,
        availableTools: toolInfos,
      });
      setPendingReadonly(next.readonly);
      setPendingTools(next.selectedTools);
    },
    [pendingTools, review, selectedTools, toolInfos],
  );

  const toolReadonly = pendingReadonly ?? readonly;
  const selectableTools = useMemo(
    () => filterToolsForReadonlyMode(toolInfos, toolReadonly || (kind === 'subagent' && review))
      .filter((tool) => isAgentProfileConfigurableToolName(tool.name)),
    [kind, review, toolInfos, toolReadonly],
  );
  const selectableGroupTools = useMemo(() => selectableTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    is_readonly: tool.isReadonly,
    needs_permissions: tool.needsPermissions,
    dynamic_info: tool.dynamicInfo,
  })), [selectableTools]);
  const toolSelectionDraft = pendingTools ?? selectedTools;
  const selectedSelectableToolCount = selectableTools.filter((tool) => toolSelectionDraft.has(tool.name)).length;
  const allSelectableToolsSelected = selectableTools.length > 0 && selectedSelectableToolCount === selectableTools.length;
  const readonlyToolsMissing = toolReadonly && selectedSelectableToolCount === 0;
  const managementGroupTools = useMemo(
    () => toolInfos
      .filter((tool) => isAgentProfileConfigurableToolName(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        is_readonly: tool.isReadonly,
        needs_permissions: tool.needsPermissions,
        dynamic_info: tool.dynamicInfo,
      })),
    [toolInfos],
  );

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

  const focusField = useCallback((field: string) => {
    if (field === 'prompt') {
      promptControlRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus({ preventScroll: true });
      return;
    }
    const control = formRef.current?.elements.namedItem(fieldId(field));
    if (control instanceof HTMLElement) control.focus();
  }, [fieldId]);

  const handleNext = () => {
    if (step === 0) {
      setNameError(!name.trim());
      setDescriptionError(!description.trim());
      if (!name.trim() || !description.trim()) {
        focusField(!name.trim() ? 'name' : 'description');
        return;
      }
    }
    if (step === 1) {
      setPromptError(!prompt.trim());
      if (!prompt.trim()) {
        focusField('prompt');
        return;
      }
    }
    setStep(step + 1);
  };

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) {
      setNameError(true);
      focusField('name');
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
    if (kind === 'subagent' && level === 'project' && !workspaceId) {
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
    const submittedTools = normalizeToolPermissionState({
      review: kind === 'subagent' && review,
      readonly,
      selectedTools,
      availableTools: toolInfos,
    }).selectedTools;
    // Empty selections use host defaults, which may include writable tools.
    if (readonly && submittedTools.size === 0) {
      notification.error(t('agentsOverview.form.readonlyToolsRequired'));
      return;
    }

    const scope = getActiveSurfaceScope();
    setSubmitting(true);
    try {
      const normalizedId = agentId.trim();
      const payload = {
        kind,
        level: kind === 'subagent' ? level : 'user',
        id: normalizedId,
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        readonly,
        review: kind === 'subagent' ? review : false,
        tools: submittedTools.size > 0 ? Array.from(submittedTools) : undefined,
        userContextPolicy: Array.from(userContextPolicy),
        workspaceId: kind === 'subagent' && level === 'project' ? workspaceId : undefined,
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
          workspaceId: payload.workspaceId,
        });
        if (!mountedRef.current || !scope.isCurrent()) return;
        notification.success(t('agentsOverview.form.updateSuccess', { name: payload.name }));
      } else {
        await CustomAgentAPI.createCustomAgent(payload);
        if (!mountedRef.current || !scope.isCurrent()) return;
        notification.success(t('agentsOverview.form.createSuccess', { name: payload.name }));
      }
      if (onCreated) onCreated();
      else openHome();
    } catch (error) {
      if (!mountedRef.current || !scope.isCurrent()) return;
      notification.error(
        `${
          isEdit
            ? t('agentsOverview.form.updateFailed')
            : t('agentsOverview.form.createFailed')
        }${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (mountedRef.current && scope.isCurrent()) setSubmitting(false);
    }
  }, [
    agentId,
    description,
    editingAgentId,
    focusField,
    isEdit,
    kind,
    level,
    name,
    notification,
    onCreated,
    openHome,
    prompt,
    readonly,
    review,
    selectedTools,
    toolInfos,
    t,
    userContextPolicy,
    workspaceId,
  ]);

  const formTitle = isEdit
    ? t('agentsOverview.form.titleEdit')
    : t('agentsOverview.form.title');
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
            onClick={closeEditor}
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
            onClick={closeEditor}
          >
            {t('agentsOverview.backToOverview')}
          </Button>
        </div>
        <ScrollArea className="th__list-body">
          <div className="th__list-inner">
            <p className="th-create-panel__error" data-openbitfun-component="create-agent-page" data-openbitfun-part="error" role="alert">{detailError}</p>
            <Button variant="fill" size="sm" onClick={closeEditor}>
              {t('agentsOverview.form.cancel')}
            </Button>
          </div>
        </ScrollArea>
      </div>
    );
  }

  const permissionControls = kind === 'subagent' ? (
    <details className="th-create-panel__field">
      <summary>{t('agentsOverview.form.review')}</summary>
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
    </details>
  ) : null;
  const basicInformation = (
    <div className="th-create-page__section">
      <div className="th-create-page__section-heading" data-openbitfun-component="create-agent-page" data-openbitfun-part="sectionHeading">
        <h3>{t('agentsOverview.form.basicInformation')}</h3>
      </div>

      <div className="th-create-panel__field">
        <label className="th-create-panel__label" htmlFor={fieldId('name')}>
          {t('agentsOverview.form.name')}
        </label>
        <Input
          id={fieldId('name')}
          value={name}
          onChange={(event) => {
            const nextName = event.target.value;
            setName(nextName);
            setNameError(false);
          }}
          invalid={nameError}
          aria-describedby={nameError ? fieldId('name-error') : undefined}
          placeholder={t(isEdit ? 'agentsOverview.form.namePlaceholder' : 'agentsOverview.form.createNamePlaceholder')}
          size="sm"
        />
        {nameError && <span id={fieldId('name-error')} className="th-create-panel__error" role="alert">{t('agentsOverview.form.nameRequired')}</span>}
      </div>

      <div className="th-create-panel__field">
        <label className="th-create-panel__label" htmlFor={fieldId('description')}>
          {t('agentsOverview.form.description')}
        </label>
        <Input
          id={fieldId('description')}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setDescriptionError(false);
          }}
          invalid={descriptionError}
          aria-describedby={descriptionError ? fieldId('description-error') : undefined}
          placeholder={t('agentsOverview.form.descPlaceholder')}
          size="sm"
        />
        {descriptionError && (
          <span id={fieldId('description-error')} className="th-create-panel__error" role="alert">
            {t('agentsOverview.form.descRequired')}
          </span>
        )}
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
    </div>
  );
  const toolSelection = toolInfos.some((tool) => isAgentProfileConfigurableToolName(tool.name)) ? (
    <div className="th-create-page__section th-create-page__section--tools">
      <div className="th-create-panel__field-head">
        <div
          className="th-create-page__section-heading th-create-page__section-heading--tools"
          data-openbitfun-component="create-agent-page"
          data-openbitfun-part="sectionHeading"
        >
          <h3>{t('agentsOverview.form.tools')}</h3>
        </div>
        {toolsEditing ? (
          <div className="th-create-panel__tool-edit-actions">
            <div className="th-create-panel__readonly-row">
              <span className="th-create-panel__label">{t('agentsOverview.form.readonly')}</span>
              <Switch
                checked={toolReadonly}
                disabled={submitting || (kind === 'subagent' && review)}
                onChange={(event) => handleReadonlyChange(event.target.checked)}
                aria-label={t('agentsOverview.form.readonly')}
              />
            </div>
            <Checkbox
              size="sm"
              label={t('agentsOverview.selectAll')}
              aria-label={t('agentsOverview.selectAll')}
              checked={allSelectableToolsSelected}
              indeterminate={selectedSelectableToolCount > 0 && !allSelectableToolsSelected}
              onCheckedChange={(checked) => setPendingTools(new Set(setToolGroupSelection(
                Array.from(toolSelectionDraft), selectableTools.map((tool) => tool.name), checked,
              )))}
              disabled={submitting || selectableTools.length === 0}
            />
            <Button
              type="button"
              variant="fill"
              size="sm"
              onClick={() => {
                setToolsEditing(false);
                setPendingTools(null);
                setPendingReadonly(null);
                requestAnimationFrame(() => toolEditButtonRef.current?.focus());
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
                setReadonly(toolReadonly);
                setToolsEditing(false);
                setPendingTools(null);
                setPendingReadonly(null);
                requestAnimationFrame(() => toolEditButtonRef.current?.focus());
              }}
              disabled={submitting}
            >
              {t('agentsOverview.save')}
            </Button>
          </div>
        ) : (
          <Tooltip content={t('agentsOverview.form.customizeTools')}>
            <IconButton
              ref={toolEditButtonRef}
              type="button"
              variant="quiet"
              size="sm"
              aria-label={t('agentsOverview.form.customizeTools')}
              aria-controls={fieldId('tools')}
              aria-expanded={toolsEditing}
              onClick={() => {
                setPendingTools(new Set(selectedTools));
                setPendingReadonly(readonly);
                setToolsEditing(true);
              }}
              disabled={submitting}
              icon={<Icon name="edit" size="sm" />}
            />
          </Tooltip>
        )}
      </div>
      <ScrollArea
        id={fieldId('tools')}
        className="th-create-panel__tool-summary"
        overscrollBehaviorY="contain"
      >
        {toolsEditing ? (
          <ToolGroupPicker
            grouped={false}
            tools={selectableGroupTools}
            managementTools={managementGroupTools}
            selectedToolNames={Array.from(toolSelectionDraft)}
            userGroups={userToolGroups}
            onSelectionChange={(toolNames) => setPendingTools(new Set(toolNames))}
            onSaveUserGroups={saveUserToolGroups}
            disabled={submitting}
            testId="custom-agent-tool-groups"
          />
        ) : (
          <ToolGroupSummary
            grouped={false}
            tools={selectableGroupTools}
            selectedToolNames={Array.from(selectedTools)}
            userGroups={userToolGroups}
          />
        )}
      </ScrollArea>
      {readonlyToolsMissing && (
        <p className="th-create-panel__error" role="alert">{t('agentsOverview.form.readonlyToolsRequired')}</p>
      )}
    </div>
  ) : null;
  const promptEditor = (
    <div className="th-create-panel__field th-create-panel__field--prompt">
      <h3 id={fieldId('prompt-label')} className="th-create-page__prompt-heading" data-openbitfun-component="create-agent-page" data-openbitfun-part="sectionHeading">
        <span className="th-create-panel__label th-create-panel__label--strong">
          {t('agentsOverview.form.prompt')}
        </span>
      </h3>
      {!isEdit && !prompt.trim() && (
        <div className="th-create-panel__field">
          <p className="th-create-panel__label-hint">{t('agentsOverview.form.promptGuide')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            setPrompt(t('agentsOverview.form.promptTemplate', { goal: description.trim() }));
            setPromptError(false);
          }}>{t('agentsOverview.form.usePromptTemplate')}</Button>
        </div>
      )}
      <div
        className="th-create-panel__prompt-editor"
        data-openbitfun-component="create-agent-page"
        data-openbitfun-part="promptEditor"
      >
        <div
          id={fieldId('runtime-context-preview')}
          className="th-create-panel__prompt-context-preview"
          data-openbitfun-component="create-agent-page"
          data-openbitfun-part="contextPreview"
        >
          <span className="th-create-panel__prompt-context-label">
            {t('agentsOverview.form.contextPreviewLabel')}
          </span>
          <div className="th-create-panel__context-options" data-openbitfun-component="create-agent-page" data-openbitfun-part="tools" role="group" aria-label={t('agentsOverview.form.contextPolicy')}>
            {VISIBLE_CONTEXT_SECTIONS.map((section) => {
              const label = contextSectionLabels[section];
              const isSelected = userContextPolicy.has(section);
              return (
                <span
                  key={section}
                  className="th-create-panel__context-option"
                  data-openbitfun-component="create-agent-page"
                  data-openbitfun-part="tool"
                  data-openbitfun-state={isSelected ? 'active' : undefined}
                >
                  <Tooltip content={contextSectionTooltips[section]} placement="top">
                    <Button
                      type="button"
                      size="xs"
                      variant={isSelected ? 'fill' : 'outline'}
                      leadingIcon={<Icon {...CONTEXT_SECTION_ICONS[section]} size="xs" />}
                      trailingIcon={isSelected ? <Icon name="check-line" size="xs" tone="success" /> : undefined}
                      onClick={() => toggleContextSection(section)}
                      aria-pressed={isSelected}
                      disabled={submitting}
                    >
                      {label}
                    </Button>
                  </Tooltip>
                </span>
              );
            })}
          </div>
        </div>
        <div
          ref={promptControlRef}
          id={fieldId('prompt')}
          role="group"
          aria-labelledby={fieldId('prompt-label')}
          aria-describedby={`${fieldId('runtime-context-preview')}${promptError ? ` ${fieldId('prompt-error')}` : ''}`}
          aria-invalid={promptError || undefined}
          data-openbitfun-component="create-agent-page"
          data-openbitfun-part="prompt"
          className="th-create-panel__prompt-control"
        >
          <React.Suspense fallback={<p className="th__title-sub" role="status">{t('agentsOverview.form.loadingDetail')}</p>}>
            <MEditor
              value={prompt}
              onChange={(value) => {
                setPrompt(value);
                setPromptError(false);
              }}
              placeholder={t('agentsOverview.form.promptPlaceholder')}
              emptyDocumentPlaceholder={t('agentsOverview.form.promptPlaceholder')}
              mode="ir"
              toolbar={false}
              height="100%"
              readonly={submitting}
              autofocus={standalone}
              className="th-create-panel__markdown-editor"
            />
          </React.Suspense>
        </div>
      </div>
      {promptError && (
        <span id={fieldId('prompt-error')} className="th-create-panel__error" role="alert">
          {t('agentsOverview.form.promptRequired')}
        </span>
      )}
    </div>
  );

  const formActions = (
    <>
      <Button
        className="th-create-page__action"
        type="button"
        variant="fill"
        size="sm"
        onClick={closeEditor}
        disabled={submitting}
      >
        {t('agentsOverview.form.cancel')}
      </Button>
      {standalone && step > 0 && (
        <Button type="button" variant="outline" size="sm" onClick={() => setStep(step - 1)} disabled={submitting}>
          {t('agentsOverview.form.wizard.back')}
        </Button>
      )}
      <Button
        className="th-create-page__action"
        type="submit"
        form={formId}
        variant="primary"
        size="sm"
        disabled={submitting || ((toolsEditing || readonlyToolsMissing) && (!standalone || step === 2)) || (standalone && step === 2 && (toolsLoading || toolsLoadError))}
        loading={submitting}
      >
        {standalone && step < 2 ? t('agentsOverview.form.wizard.next') : submitLabel}
      </Button>
    </>
  );

  const formContent = (
    <form
      ref={formRef}
      id={formId}
      className="th-create-page__form"
      data-openbitfun-component="create-agent-page"
      data-openbitfun-part="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting || (toolsEditing && (!standalone || step === 2))) return;
        if (standalone && step < 2) {
          handleNext();
          return;
        }
        if (standalone && (toolsLoading || toolsLoadError)) return;
        void handleSubmit();
      }}
    >
      <div className="th-create-page__columns" data-openbitfun-component="create-agent-page" data-openbitfun-part="columns">
        {(!standalone || step !== 1) && (
          <section className="th-create-page__panel th-create-page__panel--definition" data-openbitfun-component="create-agent-page" data-openbitfun-part="column">
            {(!standalone || step === 0) && basicInformation}
            {(!standalone || step === 2) && (
              <>
                {permissionControls}
                {standalone && toolsLoading ? (
                  <p className="th__title-sub" role="status">{t('agentsOverview.form.wizard.loadingTools')}</p>
                ) : standalone && toolsLoadError ? (
                  <div className="th-create-page__section">
                    <p className="th-create-panel__error" role="alert">{t('agentsOverview.form.wizard.toolsLoadFailed')}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => setToolsAttempt((value) => value + 1)}>
                      {t('agentsOverview.form.wizard.retry')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {toolSelection}
                    {standalone && !toolInfos.some((tool) => isAgentProfileConfigurableToolName(tool.name)) && (
                      <p className="th__title-sub">{t('agentsOverview.form.wizard.noTools')}</p>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        )}
        {(!standalone || step === 1) && (
          <section className="th-create-page__panel th-create-page__panel--capabilities" data-openbitfun-component="create-agent-page" data-openbitfun-part="column">
            {promptEditor}
          </section>
        )}
      </div>
    </form>
  );

  const page = (
    <div className={`tv th-create-page${standalone ? ' th-create-page--dialog' : ''}${standalone && step === 1 ? ' th-create-page--prompt-step' : ''}`} data-openbitfun-component="create-agent-page" data-openbitfun-part="root">
      {standalone ? (
        <SetupWizard
          title={formTitle}
          titleId={titleId}
          headerActions={<DialogClose />}
          guideLabel={t('agentsOverview.form.wizard.navigation')}
          step={{
            ...steps[step],
            progress: t('agentsOverview.form.wizard.progress', { current: formatNumber(step + 1), total: formatNumber(steps.length) }),
          }}
          contentMode={step === 1 ? 'contained' : 'scroll'}
          footer={<div className="th-create-page__actions" data-openbitfun-component="create-agent-page" data-openbitfun-part="actions">{formActions}</div>}
        >
          {formContent}
        </SetupWizard>
      ) : (
        <>
          <ScrollArea className="th__list-body th-create-page__body">
            <div className="th__list-inner th-create-page__inner" data-openbitfun-component="create-agent-page" data-openbitfun-part="body">
              <header className="th-create-page__head" data-openbitfun-component="create-agent-page" data-openbitfun-part="heading">
                <PageHeader title={formTitle} level={2} />
              </header>
              {formContent}
            </div>
          </ScrollArea>
          <footer className="th-create-page__footer">
            <div className="th-create-page__footer-inner">
              <div className="th-create-page__actions" data-openbitfun-component="create-agent-page" data-openbitfun-part="actions">{formActions}</div>
            </div>
          </footer>
        </>
      )}
    </div>
  );

  return standalone ? <DialogBody inset="none">{page}</DialogBody> : page;
};

export default CreateAgentPage;
