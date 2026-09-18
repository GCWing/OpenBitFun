/**
 * Plan display components.
 *
 * PlanDisplay renders plan file data and supports view/build/refresh.
 * CreatePlanDisplay maps legacy persisted tool data into PlanDisplay.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { OverflowText, Button, IconButton } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Loader2, PlayCircle, XCircle, ChevronsUpDown, ChevronsDownUp, FolderOpen, Save, AlertCircle } from 'lucide-react';
import type { ToolCardProps } from '../types/flow-chat';
import { ideControl } from '@/shared/services/ide-control/api';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { fileSystemService } from '@/tools/file-system/services/FileSystemService';
import { planBuildStateService } from '@/shared/services/PlanBuildStateService';
import { Tooltip, Icon } from '@openbitfun/ui';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '@/shared/notification-system';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { basenamePath, dirnameAbsolutePath, joinPath } from '@/shared/utils/pathUtils';
import { createTodoRenderItems } from './todoRenderItems';
import { useOptionalCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { isRemoteWorkspace } from '@/shared/types';
import { parsePlanMarkdown, type PlanTodo } from '@/shared/plan/planDocument';
import './CreatePlanDisplay.scss';

const log = createLogger('PlanDisplay');

interface PlanData {
  name: string;
  overview: string;
  todos: PlanTodo[];
  planFilePath: string;
  planContent?: string;
}

// Module-level cache to keep refreshed data after unmount.
// key: cacheKey (toolId or planFilePath), value: PlanData
const planDataCache = new Map<string, PlanData>();

// ==================== PlanDisplay core component ====================

export interface PlanDisplayProps {
  /** Full plan file path. */
  planFilePath: string;
  /** Initial name (optional, first render optimization). */
  initialName?: string;
  /** Initial overview (optional, first render optimization). */
  initialOverview?: string;
  /** Initial todos (optional, first render optimization). */
  initialTodos?: PlanTodo[];
  /** Tool status (used for loading state). */
  status?: 'pending' | 'preparing' | 'receiving' | 'streaming' | 'running' | 'completed' | 'cancelled' | 'error' | 'analyzing';
  /** Cache key (defaults to planFilePath). */
  cacheKey?: string;
  /** Initial complete plan markdown, when already available from Write input. */
  initialContent?: string;
  /** The tool identity used by the card height contract. */
  toolName?: string;
  /** Runtime artifacts may still be copied into the project by legacy cards. */
  storageKind?: 'runtime-artifact' | 'project-file';
  /** Explicit workspace scope for remote-safe reads and status updates. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
}

export const PlanDisplay: React.FC<PlanDisplayProps> = ({
  planFilePath,
  initialName = '',
  initialOverview = '',
  initialTodos = [],
  status = 'completed',
  cacheKey,
  initialContent,
  toolName = 'CreatePlan',
  storageKind = 'runtime-artifact',
  workspaceId,
  workspacePath,
  remoteConnectionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { workspace: currentWorkspace } = useOptionalCurrentWorkspace();
  const effectiveCacheKey = cacheKey || planFilePath;
  const effectiveWorkspaceId = workspaceId ?? currentWorkspace?.id;
  const effectiveWorkspacePath = workspacePath ?? currentWorkspace?.rootPath ?? '';
  const effectiveRemoteConnectionId = remoteConnectionId ?? currentWorkspace?.connectionId;
  const planFileRef = useMemo(() => ({
    planFilePath,
    workspaceId: effectiveWorkspaceId,
    workspacePath: effectiveWorkspacePath,
    remoteConnectionId: effectiveRemoteConnectionId,
  }), [effectiveRemoteConnectionId, effectiveWorkspaceId, effectiveWorkspacePath, planFilePath]);
  /** Plan file IO is routed by the owning workspace ID; the connection is only a pre-ID fallback. */
  const readPlanContent = useCallback((): Promise<string> => (
    effectiveWorkspaceId
      ? workspaceAPI.readWorkspaceFile(effectiveWorkspaceId, planFilePath)
      : workspaceAPI.readFileContent(planFilePath, undefined, effectiveRemoteConnectionId)
  ), [effectiveRemoteConnectionId, effectiveWorkspaceId, planFilePath]);
  
  const [refreshedData, setRefreshedData] = useState<PlanData | null>(() => {
    return planDataCache.get(effectiveCacheKey) || null;
  });
  
  // Initialize build state from the shared service to survive unmounts.
  const [isBuildStarted, setIsBuildStarted] = useState(() => {
    return planFilePath ? planBuildStateService.isBuildActive(planFileRef) : false;
  });
  const [isSavingToProject, setIsSavingToProject] = useState(false);
  const [hasSavedToProject, setHasSavedToProject] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  const [isTodosExpanded, setIsTodosExpanded] = useState(false);
  const toolCardId = cacheKey ?? planFilePath;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId: toolCardId,
    toolName,
  });

  const hasAutoLoaded = useRef(false);
  const hasLoadedCompletedFile = useRef(false);
  const saveSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (saveSuccessTimerRef.current) {
      clearTimeout(saveSuccessTimerRef.current);
    }
  }, []);

  // Streaming may provide partial data before planFilePath is available.
  const initialPlanData = useMemo((): PlanData | null => {
    if (initialContent) {
      try {
        const parsed = parsePlanMarkdown(initialContent);
        return {
          name: parsed.name,
          overview: parsed.overview,
          todos: parsed.todos,
          planFilePath,
          planContent: parsed.planContent,
        };
      } catch {
        // Streaming Write input may not contain the closing frontmatter delimiter yet.
      }
    }
    const hasAnyData = initialName || initialOverview || initialTodos.length > 0;
    if (!hasAnyData) return null;
    
    return {
      name: initialName,
      overview: initialOverview,
      todos: initialTodos,
      planFilePath: planFilePath,
      planContent: undefined,
    };
  }, [initialContent, planFilePath, initialName, initialOverview, initialTodos]);

  const planData = refreshedData || initialPlanData;
  const todoRenderItems = useMemo(
    () => createTodoRenderItems(planData?.todos ?? []),
    [planData?.todos],
  );
  const planDirectoryPath = useMemo(() => dirnameAbsolutePath(planFilePath), [planFilePath]);
  const isRevealPlanDisabled = !planFilePath || isRemoteWorkspace(currentWorkspace);

  // Subscribe to shared build state service for cross-component sync.
  useEffect(() => {
    if (!planFilePath) return;
    
    // Sync initial state (in case planFilePath just became available).
    setIsBuildStarted(planBuildStateService.isBuildActive(planFileRef));
    
    const unsubscribe = planBuildStateService.subscribe(planFileRef, (event) => {
      setIsBuildStarted(event.isBuilding);
      
      if (event.updatedTodos) {
        const cached = planDataCache.get(effectiveCacheKey);
        const newPlanData: PlanData = {
          name: cached?.name || initialName,
          overview: cached?.overview || initialOverview,
          todos: event.updatedTodos,
          planFilePath: planFilePath,
          planContent: event.planContent || cached?.planContent,
        };
        setRefreshedData(newPlanData);
        planDataCache.set(effectiveCacheKey, newPlanData);
      }
    });
    
    return unsubscribe;
  }, [planFilePath, planFileRef, effectiveCacheKey, initialName, initialOverview]);

  // Load latest content on mount and refresh on file changes.
  useEffect(() => {
    if (!planFilePath) {
      return;
    }

    const normalizedPlanPath = planFilePath.replace(/\\/g, '/');

    const loadFromFile = async () => {
      // Skip refresh while writing to avoid feedback loops.
      if (planBuildStateService.isFileWriting(planFileRef)) {
        return;
      }

      try {
        const content = await readPlanContent();
        const parsed = parsePlanMarkdown(content);
        const newPlanData: PlanData = {
          name: parsed.name || initialName,
          overview: parsed.overview || initialOverview,
          todos: parsed.todos || initialTodos,
          planFilePath,
          planContent: parsed.planContent,
        };

        setLoadError(null);
        setRefreshedData(newPlanData);
        planDataCache.set(effectiveCacheKey, newPlanData);
      } catch (error) {
        log.warn('Failed to load plan file', { planFilePath, error });
        if (status === 'completed') {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    // Always load once on mount to capture changes during unmount.
    if (!hasAutoLoaded.current || (status === 'completed' && !hasLoadedCompletedFile.current)) {
      hasAutoLoaded.current = true;
      if (status === 'completed') {
        hasLoadedCompletedFile.current = true;
      }
      loadFromFile();
    }

    if (!planDirectoryPath) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unwatch = fileSystemService.watchFileChanges(planDirectoryPath, (event) => {
      const eventPath = event.path.replace(/\\/g, '/');
      if (eventPath !== normalizedPlanPath) {
        return;
      }
      
      if (event.type !== 'modified') {
        return;
      }

      // Extra 300ms debounce on the client (server already debounces 500ms).
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        loadFromFile();
      }, 300);
    });

    return () => {
      unwatch();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [effectiveCacheKey, planFilePath, planFileRef, planDirectoryPath, readPlanContent, initialName, initialOverview, initialTodos, status]);

  // Build button status transitions: build -> building -> built.
  const buildStatus = useMemo((): 'build' | 'building' | 'built' => {
    if (planData?.todos?.length) {
      const statuses = planData.todos.map(t => t.status);
      if (statuses.every(s => s === 'completed')) {
        return 'built';
      }
    }
    if (isBuildStarted) {
      return 'building';
    }
    return 'build';
  }, [planData, isBuildStarted]);

  useEffect(() => {
    if (buildStatus === 'built') {
      if (isBuildStarted) {
        setIsBuildStarted(false);
      }
    }
  }, [buildStatus, isBuildStarted]);

  const planFileName = useMemo(() => {
    return basenamePath(planFilePath);
  }, [planFilePath]);

  const handleViewPlan = useCallback(() => {
    if (planFilePath) {
      ideControl.navigation.goToFile(planFilePath);
    }
  }, [planFilePath]);

  const handleRevealPlanInExplorer = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (isRevealPlanDisabled || !planFilePath) {
      return;
    }

    try {
      await workspaceAPI.revealInExplorer(planFilePath);
    } catch (error) {
      log.warn('Failed to reveal plan file in explorer', {
        planFilePath,
        error,
      });
    }
  }, [isRevealPlanDisabled, planFilePath]);

  const handleSavePlanToProject = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!planFilePath || !currentWorkspace || isSavingToProject) {
      return;
    }

    const projectPlansDirectory = joinPath(currentWorkspace.rootPath, '.openbitfun/plans');
    const projectPlanPath = joinPath(projectPlansDirectory, basenamePath(planFilePath));
    if (saveSuccessTimerRef.current) {
      clearTimeout(saveSuccessTimerRef.current);
      saveSuccessTimerRef.current = null;
    }
    setHasSavedToProject(false);
    setIsSavingToProject(true);
    try {
      const content = await readPlanContent();
      // The destination is the current workspace, addressed by ID.
      await workspaceAPI.createWorkspaceDirectory(currentWorkspace.id, projectPlansDirectory);
      await workspaceAPI.writeWorkspaceFile(currentWorkspace.id, projectPlanPath, content);
      globalEventBus.emit('file-tree:refresh');
      setHasSavedToProject(true);
      saveSuccessTimerRef.current = setTimeout(() => {
        setHasSavedToProject(false);
        saveSuccessTimerRef.current = null;
      }, 1600);
    } catch (error) {
      log.error('Failed to save plan to project', {
        planFilePath,
        workspacePath: currentWorkspace.rootPath,
        error: String(error),
      });
      notificationService.error(t('toolCards.plan.saveToProjectFailed'));
    } finally {
      setIsSavingToProject(false);
    }
  }, [currentWorkspace, isSavingToProject, planFilePath, readPlanContent, t]);

  const handleBuild = useCallback(async () => {
    if (!planFilePath || buildStatus !== 'build') return;
    
    try {
      const sessionId = flowChatManager.getCurrentSession()?.sessionId;
      if (!sessionId) {
        throw new Error('No active session');
      }
      const content = await readPlanContent();
      const parsed = parsePlanMarkdown(content);
      
      const latestPlanData: PlanData = {
        name: parsed.name || initialName,
        overview: parsed.overview || initialOverview,
        todos: parsed.todos || initialTodos,
        planFilePath,
        planContent: parsed.planContent,
      };
      
      setRefreshedData(latestPlanData);
      planDataCache.set(effectiveCacheKey, latestPlanData);

      // Register build in shared service (notifies all subscribers including PlanViewer).
      const todoIds = latestPlanData.todos.map(t => t.id);
      const turnId = planBuildStateService.startBuild({
        sessionId,
        planFilePath,
        todoIds,
        workspaceId: effectiveWorkspaceId,
        workspacePath: effectiveWorkspacePath,
        remoteConnectionId: effectiveRemoteConnectionId,
      });
      if (!turnId) return;

      const message = `Implement the plan at \`${latestPlanData.planFilePath}\`.

Read the plan file before making changes and treat it as the source of truth. Do not edit the plan file directly. Track progress with TodoWrite using the existing todo IDs from the plan frontmatter; do not rename or invent IDs. Start with the first pending todo and continue until all todos are completed.`;

      const displayMessage = `Build Plan: ${latestPlanData.name}`;
      await flowChatManager.sendMessage(
        message,
        sessionId,
        displayMessage,
        undefined,
        undefined,
        { turnId },
      );
    } catch (error) {
      log.error('Build failed', { cacheKey: effectiveCacheKey, planFilePath, error });
      planBuildStateService.cancelBuild(planFileRef);
    }
  }, [planFilePath, planFileRef, buildStatus, effectiveCacheKey, effectiveRemoteConnectionId, effectiveWorkspaceId, effectiveWorkspacePath, initialName, initialOverview, initialTodos, readPlanContent]);

  const handleToggleTodos = useCallback(() => {
    applyExpandedState(isTodosExpanded, !isTodosExpanded, setIsTodosExpanded);
  }, [applyExpandedState, isTodosExpanded]);

  const isLoading = status === 'preparing' || status === 'receiving' || status === 'streaming' || status === 'running';
  const revealPlanTooltip = isRevealPlanDisabled
    ? t('toolCards.plan.revealPlanUnavailable')
    : t('toolCards.plan.revealPlanInExplorer');
  const savePlanTooltip = !currentWorkspace
    ? t('toolCards.plan.saveToProjectUnavailable')
    : isSavingToProject
      ? t('toolCards.plan.savingToProject')
      : hasSavedToProject
        ? t('toolCards.plan.saveToProjectSuccess')
      : t('toolCards.plan.saveToProject');

  if (!planData && loadError && status === 'completed') {
    return (
      <div data-openbitfun-component="create-plan-display" data-openbitfun-part="root" className="create-plan-display status-error">
        <div className="create-plan-header" data-openbitfun-component="create-plan-display" data-openbitfun-part="header">
          <button data-overflow-trigger
            type="button"
            className="create-plan-header-main create-plan-header-main--clickable"
            onClick={handleViewPlan}
          >
            <div className="header-left">
              <div className="file-icon-wrapper"><AlertCircle size={14} /></div>
              <OverflowText className="file-name">{planFileName}</OverflowText>
            </div>
          </button>
        </div>
        <div className="create-plan-content" data-openbitfun-component="create-plan-display" data-openbitfun-part="content">
          <div className="plan-content-left" data-openbitfun-component="create-plan-display" data-openbitfun-part="overview">
            <h3 className="plan-title">{t('toolCards.plan.invalidFormat')}</h3>
            <p className="plan-overview">{t('toolCards.plan.invalidFormatDescription')}</p>
          </div>
        </div>
        <div className="create-plan-footer" data-openbitfun-component="create-plan-display" data-openbitfun-part="footer">
          <Button variant="outline" size="sm" type="button" onClick={handleViewPlan}>
            {t('toolCards.plan.viewPlan')}
          </Button>
          <Button type="button" variant="primary" size="sm" disabled>
            {t('toolCards.plan.build')}
          </Button>
        </div>
      </div>
    );
  }

  if (!planData) {
    return (
      <div data-openbitfun-component="create-plan-display" data-openbitfun-part="loading" data-openbitfun-state="loading" className={`create-plan-display create-plan-display--loading create-plan-display--loading-shimmer status-${status}`}>
        <div className="create-plan-header create-plan-header--loading-shimmer" data-openbitfun-component="create-plan-display" data-openbitfun-part="header">
          <span>{t('toolCards.plan.loadingPlan')}</span>
        </div>
      </div>
    );
  }

  return (
    <div data-openbitfun-component="create-plan-display" data-openbitfun-part="root"
      ref={cardRootRef}
      data-tool-card-id={toolCardId ?? ''}
      className={`create-plan-display status-${status}${isLoading ? ' create-plan-display--plan-generating' : ''}`}
    >
      <div
        className={`create-plan-header${isLoading ? ' create-plan-header--loading-shimmer' : ''}`}
        data-openbitfun-component="create-plan-display"
        data-openbitfun-part="header"
      >
        <Tooltip content={t('toolCards.plan.clickToOpenPlan')}>
          <button data-overflow-trigger
            type="button"
            className="create-plan-header-main create-plan-header-main--clickable"
            data-openbitfun-component="create-plan-display"
            data-openbitfun-part="headerMain"
            onClick={handleViewPlan}
          >
            <div className="header-left">
              <div className="file-icon-wrapper">
                <ClipboardList size={14} />
              </div>
              <OverflowText className="file-name">{planFileName}</OverflowText>
            </div>
          </button>
        </Tooltip>
        <div className="create-plan-header-actions">
          {storageKind === 'runtime-artifact' && (
            <Tooltip content={savePlanTooltip}>
              <span className="create-plan-header-folder-btn-wrapper">
                <IconButton
                  type="button"
                  size="sm"
                  variant={hasSavedToProject ? 'fill' : 'quiet'}
                  loading={isSavingToProject}
                  onClick={handleSavePlanToProject}
                  disabled={!planFilePath || !currentWorkspace || isSavingToProject || hasSavedToProject}
                  aria-label={savePlanTooltip}
                  icon={hasSavedToProject ? <Icon name="check-line" size="sm" /> : <Save size={14} />}
                />
              </span>
            </Tooltip>
          )}
          <Tooltip content={revealPlanTooltip}>
            <span className="create-plan-header-folder-btn-wrapper">
              <IconButton
                type="button"
                size="sm"
                onClick={handleRevealPlanInExplorer}
                disabled={isRevealPlanDisabled}
                aria-label={revealPlanTooltip}
                icon={<FolderOpen size={14} />}
              />
            </span>
          </Tooltip>
        </div>
      </div>

      <div className="create-plan-content" data-openbitfun-component="create-plan-display" data-openbitfun-part="content">
        <div className="plan-content-left" data-openbitfun-component="create-plan-display" data-openbitfun-part="overview">
          <h3 className="plan-title">{planData.name}</h3>
          <p className="plan-overview">{planData.overview}</p>
        </div>
        {planData.todos && planData.todos.length > 0 && (
          <Tooltip content={t(isTodosExpanded ? 'toolCards.common.collapse' : 'toolCards.common.expand')}>
            <IconButton
              type="button"
              size="sm"
              onClick={handleToggleTodos}
              aria-label={t(isTodosExpanded ? 'toolCards.common.collapse' : 'toolCards.common.expand')}
              icon={isTodosExpanded ? <ChevronsDownUp size={22} /> : <ChevronsUpDown size={22} />}
            />
          </Tooltip>
        )}
      </div>

      {planData.todos && planData.todos.length > 0 && isTodosExpanded && (
        <div className="create-plan-todos create-plan-todos--expanded" data-openbitfun-component="create-plan-display" data-openbitfun-part="todos" data-openbitfun-state="expanded">
          <div className="todos-list">
            {todoRenderItems.map(({ todo, key }) => (
              <div
                key={key}
                className={`todo-item status-${todo.status || 'pending'}`}
                data-openbitfun-component="create-plan-display"
                data-openbitfun-part="todo"
              >
                {todo.status === 'completed' && (
                  <Icon name="check-circle" size="xs" className="todo-icon todo-icon--completed" />
                )}
                {todo.status === 'in_progress' && (
                  <PlayCircle size={12} className="todo-icon todo-icon--in-progress" />
                )}
                {(!todo.status || todo.status === 'pending') && (
                  <Icon name="unselected" size="xs" className="todo-icon todo-icon--pending" />
                )}
                {todo.status === 'cancelled' && (
                  <XCircle size={12} className="todo-icon todo-icon--cancelled" />
                )}
                <span className="todo-content">{todo.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={`create-plan-footer${isLoading ? ' create-plan-footer--generating-only' : ''}`} data-openbitfun-component="create-plan-display" data-openbitfun-part="footer">
        {!isLoading && (
          <Button variant="outline" size="sm" type="button" onClick={handleViewPlan}>
            {t('toolCards.plan.viewPlan')}
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          size="sm"
          leadingIcon={
            buildStatus === 'building' || isLoading
              ? <Loader2 size={14} className="animate-spin" />
              : buildStatus === 'built'
                ? <Icon name="check-circle" size="sm" />
                : undefined
          }
          onClick={handleBuild}
          disabled={buildStatus !== 'build' || isLoading}
        >
          {buildStatus === 'building'
            ? t('toolCards.plan.building')
            : buildStatus === 'built'
              ? t('toolCards.plan.built')
              : isLoading
                ? t('toolCards.plan.generating')
                : t('toolCards.plan.build')}
        </Button>
      </div>
    </div>
  );
};

// ==================== Legacy CreatePlan history wrapper ====================

/**
 * Compatibility wrapper that maps persisted CreatePlan data into PlanDisplay.
 */
export const CreatePlanDisplay: React.FC<ToolCardProps> = ({
  toolItem,
}) => {
  const { status, toolResult, partialParams, isParamsStreaming, toolCall } = toolItem;
  const toolInput = toolCall?.input as Record<string, unknown> | undefined;
  const useStreamingInputFallback =
    Boolean(isParamsStreaming) ||
    status === 'streaming' ||
    status === 'preparing' ||
    status === 'running';

  const planFilePath = useMemo(() => {
    if (isParamsStreaming && partialParams?.plan_file_path) {
      return String(partialParams.plan_file_path);
    }
    const fromResult = toolResult?.result?.plan_file_path;
    if (fromResult) return String(fromResult);
    if (useStreamingInputFallback && toolInput?.plan_file_path != null) {
      return String(toolInput.plan_file_path);
    }
    return '';
  }, [isParamsStreaming, partialParams, toolResult, useStreamingInputFallback, toolInput]);

  const initialName = useMemo(() => {
    if (isParamsStreaming && partialParams?.name != null) {
      return String(partialParams.name);
    }
    const fromResult = toolResult?.result?.name;
    if (fromResult != null) return String(fromResult);
    if (useStreamingInputFallback && toolInput?.name != null) {
      return String(toolInput.name);
    }
    return '';
  }, [isParamsStreaming, partialParams, toolResult, useStreamingInputFallback, toolInput]);

  const initialOverview = useMemo(() => {
    if (isParamsStreaming && partialParams?.overview != null) {
      return String(partialParams.overview);
    }
    const fromResult = toolResult?.result?.overview;
    if (fromResult != null) return String(fromResult);
    if (useStreamingInputFallback && toolInput?.overview != null) {
      return String(toolInput.overview);
    }
    return '';
  }, [isParamsStreaming, partialParams, toolResult, useStreamingInputFallback, toolInput]);

  const initialTodos = useMemo(() => {
    if (isParamsStreaming && partialParams?.todos && Array.isArray(partialParams.todos)) {
      return partialParams.todos;
    }
    if (toolResult?.result?.todos && Array.isArray(toolResult.result.todos)) {
      return toolResult.result.todos;
    }
    if (useStreamingInputFallback && toolInput?.todos && Array.isArray(toolInput.todos)) {
      return toolInput.todos as PlanTodo[];
    }
    return [];
  }, [isParamsStreaming, partialParams, toolResult, useStreamingInputFallback, toolInput]);

  return (
    <PlanDisplay
      planFilePath={planFilePath}
      initialName={initialName}
      initialOverview={initialOverview}
      initialTodos={initialTodos}
      status={status as PlanDisplayProps['status']}
      cacheKey={toolItem.id}
    />
  );
};
