/** Optimized viewer/editor for `.plan.md` files (frontmatter + markdown body). */

import { OverflowText, Button, Icon, IconButton, Input, Tooltip } from '@openbitfun/ui';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Loader2, AlertCircle, FileText } from 'lucide-react';
import yaml from 'yaml';
import { MEditor } from '../meditor';
import type { EditorInstance } from '../meditor';
import { createLogger } from '@/shared/utils/logger';
import { LoadingState } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { fileSystemService } from '@/tools/file-system/services/FileSystemService';
import { planBuildStateService } from '@/shared/services/PlanBuildStateService';
import { globalEventBus } from '@/infrastructure/event-bus';
import { basenamePath, dirnameAbsolutePath } from '@/shared/utils/pathUtils';
import { useOptionalCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import './PlanViewer.scss';

const log = createLogger('PlanViewer');

// Styles used by markdown rendering (math + code highlight).
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

interface PlanTodo {
  id: string;
  content: string;
  status?: string;
}

interface PlanData {
  name: string;
  overview: string;
  todos: PlanTodo[];
}

type YamlEditorPlacement = 'none' | 'inline' | 'trailing';

export interface PlanViewerProps {
  /** File path */
  filePath: string;
  /** Workspace identity that owns the plan file. */
  workspaceId?: string;
  /** Workspace path */
  workspacePath?: string;
  /** File name */
  fileName?: string;
  /** Jump to specified line number */
  jumpToLine?: number;
  /** Jump to specified column number */
  jumpToColumn?: number;
}

const PlanViewer: React.FC<PlanViewerProps> = ({
  filePath,
  workspaceId,
  workspacePath,
  fileName,
  jumpToLine: _jumpToLine,
  jumpToColumn: _jumpToColumn,
}) => {
  const { t } = useI18n('tools');
  const { workspace: currentWorkspace } = useOptionalCurrentWorkspace();
  const effectiveWorkspaceId = workspaceId ?? currentWorkspace?.id;
  const effectiveWorkspacePath = workspacePath ?? currentWorkspace?.rootPath ?? '';
  const effectiveRemoteConnectionId = currentWorkspace?.connectionId;
  const planFileRef = useMemo(() => ({
    planFilePath: filePath,
    workspaceId: effectiveWorkspaceId,
    workspacePath: effectiveWorkspacePath,
    remoteConnectionId: effectiveRemoteConnectionId,
  }), [effectiveRemoteConnectionId, effectiveWorkspaceId, effectiveWorkspacePath, filePath]);
  /** Plan file IO is routed by the owning workspace ID; path + connection is the pre-ID fallback. */
  const readPlanContent = useCallback((): Promise<string> => (
    effectiveWorkspaceId
      ? workspaceAPI.readWorkspaceFile(effectiveWorkspaceId, filePath)
      : workspaceAPI.readFileContent(filePath, undefined, effectiveRemoteConnectionId)
  ), [effectiveRemoteConnectionId, effectiveWorkspaceId, filePath]);
  const writePlanContent = useCallback((fullContent: string): Promise<void> => (
    effectiveWorkspaceId
      ? workspaceAPI.writeWorkspaceFile(effectiveWorkspaceId, filePath, fullContent)
      : workspaceAPI.writeFileContent(effectiveWorkspacePath, filePath, fullContent, effectiveRemoteConnectionId)
  ), [effectiveRemoteConnectionId, effectiveWorkspaceId, effectiveWorkspacePath, filePath]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  // Initialize build state from the shared service to survive unmounts.
  const [isBuildStarted, setIsBuildStarted] = useState(() => {
    return filePath ? planBuildStateService.isBuildActive(planFileRef) : false;
  });
  const [isContentDirty, setIsContentDirty] = useState(false);
  // Edit mode: display raw yaml frontmatter
  const [yamlEditorPlacement, setYamlEditorPlacement] = useState<YamlEditorPlacement>('none');
  const [yamlContent, setYamlContent] = useState<string>('');
  const [originalYamlContent, setOriginalYamlContent] = useState<string>('');
  // Todos list expand/collapse state (collapsed by default)
  const [isTodosExpanded, setIsTodosExpanded] = useState(false);
  const [isInlineTodoEditing, setIsInlineTodoEditing] = useState(false);
  const [inlineTodoDrafts, setInlineTodoDrafts] = useState<Record<string, string>>({});
  const [inlineDeletedTodoKeys, setInlineDeletedTodoKeys] = useState<string[]>([]);
  const [inlineAddedTodos, setInlineAddedTodos] = useState<PlanTodo[]>([]);
  const [isTrailingTodoEditing, setIsTrailingTodoEditing] = useState(false);
  const [trailingTodoDrafts, setTrailingTodoDrafts] = useState<Record<string, string>>({});
  const [trailingDeletedTodoKeys, setTrailingDeletedTodoKeys] = useState<string[]>([]);
  const [trailingAddedTodos, setTrailingAddedTodos] = useState<PlanTodo[]>([]);

  const isEditingYaml = yamlEditorPlacement !== 'none';
  
  const editorRef = useRef<EditorInstance>(null);
  const yamlEditorRef = useRef<EditorInstance>(null);
  const isUnmountedRef = useRef(false);

  const basePath = useMemo(() => {
    if (!filePath) return undefined;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    if (lastSlashIndex >= 0) {
      return normalizedPath.substring(0, lastSlashIndex);
    }
    return undefined;
  }, [filePath]);

  const displayFileName = useMemo(() => {
    if (fileName) return fileName;
    return basenamePath(filePath);
  }, [filePath, fileName]);

  const hasTodos = !!(planData?.todos && planData.todos.length > 0);

  useEffect(() => {
    isUnmountedRef.current = false;
    const editor = editorRef.current;
    const yamlEditor = yamlEditorRef.current;
    return () => {
      isUnmountedRef.current = true;
      editor?.destroy();
      yamlEditor?.destroy();
    };
  }, []);

  const loadFileContent = useCallback(async () => {
    if (!filePath || isUnmountedRef.current) {
      if (!isUnmountedRef.current) setLoading(false);
      return;
    }

    if (planBuildStateService.isFileWriting(planFileRef)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const content = await readPlanContent();

      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const rawYaml = frontmatterMatch[1];
        const parsed = yaml.parse(rawYaml);
        const markdownContent = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();

        if (!isUnmountedRef.current) {
          setPlanData({
            name: parsed.name || '',
            overview: parsed.overview || '',
            todos: parsed.todos || [],
          });
          setPlanContent(markdownContent);
          setIsContentDirty(false);
          setYamlContent(rawYaml);
          setOriginalYamlContent(rawYaml);
        }
      } else {
        if (!isUnmountedRef.current) {
          setPlanData(null);
          setPlanContent(content);
          setIsContentDirty(false);
        }
      }
    } catch (err) {
      if (!isUnmountedRef.current) {
        const errStr = String(err);
        log.error('Failed to load file', err);
        // Simplify error message
        let displayError = t('editor.common.loadFailed');
        if (errStr.includes('does not exist') || errStr.includes('No such file')) {
          displayError = t('editor.common.fileNotFound');
        } else if (errStr.includes('Permission denied') || errStr.includes('permission')) {
          displayError = t('editor.common.permissionDenied');
        }
        setError(displayError);
      }
    } finally {
      if (!isUnmountedRef.current) {
        setLoading(false);
      }
    }
  }, [filePath, planFileRef, readPlanContent, t]);

  useEffect(() => {
    loadFileContent();
  }, [loadFileContent]);

  useEffect(() => {
    if (!filePath) return;

    const normalizedPlanPath = filePath.replace(/\\/g, '/');
    const dirPath = dirnameAbsolutePath(filePath);

    if (!dirPath) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unwatch = fileSystemService.watchFileChanges(dirPath, (event) => {
      const eventPath = event.path.replace(/\\/g, '/');
      if (eventPath !== normalizedPlanPath) return;
      if (event.type !== 'modified') return;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        loadFileContent();
      }, 300);
    });

    return () => {
      unwatch();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [filePath, loadFileContent]);

  // Subscribe to shared build state service for cross-component sync.
  useEffect(() => {
    if (!filePath) return;

    // Sync initial state (in case filePath just became available).
    setIsBuildStarted(planBuildStateService.isBuildActive(planFileRef));

    const unsubscribe = planBuildStateService.subscribe(planFileRef, (event) => {
      setIsBuildStarted(event.isBuilding);

      if (event.updatedTodos) {
        // Update plan data with latest todos.
        setPlanData(prev => prev ? { ...prev, todos: event.updatedTodos! } : null);

        // Update yaml content for edit mode consistency.
        if (event.updatedFrontmatter) {
          setYamlContent(event.updatedFrontmatter);
          setOriginalYamlContent(event.updatedFrontmatter);
        }
      }
    });

    return unsubscribe;
  }, [filePath, planFileRef]);

  const remainingTodos = useMemo(() => {
    if (!planData?.todos) return 0;
    return planData.todos.filter(t => t.status !== 'completed').length;
  }, [planData]);

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
    if (buildStatus === 'built' && isBuildStarted) {
      setIsBuildStarted(false);
    }
  }, [buildStatus, isBuildStarted]);

  const hasUnsavedChanges = useMemo(() => {
    const yamlChanged = yamlContent !== originalYamlContent;
    return yamlChanged || isContentDirty;
  }, [yamlContent, originalYamlContent, isContentDirty]);

  const saveFileContent = useCallback(async () => {
    if (!hasUnsavedChanges || !filePath) return;

    try {
      // Rebuild full content
      let fullContent = '';
      if (yamlContent) {
        fullContent = `---\n${yamlContent}\n---\n\n${planContent}`;
      } else {
        fullContent = planContent;
      }

      await writePlanContent(fullContent);
      editorRef.current?.markSaved?.();
      yamlEditorRef.current?.markSaved?.();
      setIsContentDirty(false);
      setOriginalYamlContent(yamlContent);
      globalEventBus.emit('file-tree:refresh');
      
      // Re-parse yaml to update planData
      if (yamlContent) {
        try {
          const parsed = yaml.parse(yamlContent);
          setPlanData({
            name: parsed.name || '',
            overview: parsed.overview || '',
            todos: parsed.todos || [],
          });
        } catch (e) {
          log.warn('YAML parse failed', e);
        }
      }
    } catch (err) {
      log.error('Failed to save file', err);
    }
  }, [planContent, yamlContent, filePath, hasUnsavedChanges, writePlanContent]);

  const handleContentChange = useCallback((newContent: string) => {
    setPlanContent(newContent);
  }, []);

  const handleYamlChange = useCallback((newContent: string) => {
    setYamlContent(newContent);
  }, []);

  const handleContentDirtyChange = useCallback((isDirty: boolean) => {
    setIsContentDirty(isDirty);
  }, []);

  const handleSave = useCallback((_value: string) => {
    saveFileContent();
  }, [saveFileContent]);

  const buildTodoDraftsFromPlan = useCallback((todos: PlanTodo[]) => {
    const drafts: Record<string, string> = {};
    todos.forEach((todo, index) => {
      const key = todo.id || String(index);
      drafts[key] = todo.content;
    });
    return drafts;
  }, []);

  const startInlineTodoEdit = useCallback(() => {
    if (!planData?.todos?.length) return;
    setInlineTodoDrafts(buildTodoDraftsFromPlan(planData.todos));
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
    setIsInlineTodoEditing(true);
  }, [buildTodoDraftsFromPlan, planData]);

  const cancelInlineTodoEdit = useCallback(() => {
    setIsInlineTodoEditing(false);
    setInlineTodoDrafts({});
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
  }, []);

  const handleAddInlineTodo = useCallback(() => {
    const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTodo: PlanTodo = { id, content: '', status: 'pending' };
    setInlineAddedTodos(prev => [...prev, newTodo]);
    setInlineTodoDrafts(prev => ({ ...prev, [id]: '' }));
  }, []);

  const handleDeleteInlineTodo = useCallback((todoKey: string) => {
    if (todoKey.startsWith('new-')) {
      setInlineAddedTodos(prev => prev.filter(todo => todo.id !== todoKey));
      setInlineTodoDrafts(prev => {
        const { [todoKey]: _removed, ...rest } = prev;
        return rest;
      });
      return;
    }
    setInlineDeletedTodoKeys(prev => (prev.includes(todoKey) ? prev : [...prev, todoKey]));
  }, []);

  const startTrailingTodoEdit = useCallback(() => {
    if (!planData?.todos?.length) return;
    setTrailingTodoDrafts(buildTodoDraftsFromPlan(planData.todos));
    setTrailingDeletedTodoKeys([]);
    setTrailingAddedTodos([]);
    setIsTrailingTodoEditing(true);
  }, [buildTodoDraftsFromPlan, planData]);

  const cancelTrailingTodoEdit = useCallback(() => {
    setIsTrailingTodoEditing(false);
    setTrailingTodoDrafts({});
    setTrailingDeletedTodoKeys([]);
    setTrailingAddedTodos([]);
  }, []);

  const handleAddTrailingTodo = useCallback(() => {
    const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTodo: PlanTodo = { id, content: '', status: 'pending' };
    setTrailingAddedTodos(prev => [...prev, newTodo]);
    setTrailingTodoDrafts(prev => ({ ...prev, [id]: '' }));
  }, []);

  const handleDeleteTrailingTodo = useCallback((todoKey: string) => {
    if (todoKey.startsWith('new-')) {
      setTrailingAddedTodos(prev => prev.filter(todo => todo.id !== todoKey));
      setTrailingTodoDrafts(prev => {
        const { [todoKey]: _removed, ...rest } = prev;
        return rest;
      });
      return;
    }
    setTrailingDeletedTodoKeys(prev => (prev.includes(todoKey) ? prev : [...prev, todoKey]));
  }, []);

  const saveTodoEdits = useCallback(async (nextTodos: PlanTodo[]) => {
    if (!filePath || !planData) return;

    let nextYamlContent = yamlContent;
    if (yamlContent) {
      try {
        const parsed = yaml.parse(yamlContent) || {};
        parsed.todos = nextTodos;
        nextYamlContent = yaml.stringify(parsed).trimEnd();
      } catch (e) {
        log.warn('Failed to parse yaml while saving todo edit', e);
      }
    }

    try {
      const fullContent = nextYamlContent
        ? `---\n${nextYamlContent}\n---\n\n${planContent}`
        : planContent;
      await writePlanContent(fullContent);
      setPlanData(prev => (prev ? { ...prev, todos: nextTodos } : prev));
      setYamlContent(nextYamlContent);
      setOriginalYamlContent(nextYamlContent);
      setIsContentDirty(false);
      globalEventBus.emit('file-tree:refresh');
    } catch (err) {
      log.error('Failed to save todo edit', err);
    }
  }, [filePath, planContent, planData, yamlContent, writePlanContent]);

  const saveInlineTodoEdit = useCallback(async () => {
    if (!planData?.todos?.length) return;
    const nextTodos = planData.todos
      .map((todo, index) => ({ todo, key: todo.id || String(index) }))
      .filter(({ key }) => !inlineDeletedTodoKeys.includes(key))
      .map(({ todo, key }) => {
        const nextContent = (inlineTodoDrafts[key] ?? todo.content).trim();
        return { ...todo, content: nextContent || todo.content };
      })
      .concat(
        inlineAddedTodos
          .map(todo => ({ ...todo, content: (inlineTodoDrafts[todo.id] ?? todo.content).trim() }))
          .filter(todo => !!todo.content)
      );
    await saveTodoEdits(nextTodos);
    setIsInlineTodoEditing(false);
    setInlineTodoDrafts({});
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
  }, [inlineAddedTodos, inlineDeletedTodoKeys, inlineTodoDrafts, planData, saveTodoEdits]);

  const saveTrailingTodoEdit = useCallback(async () => {
    if (!planData?.todos?.length) return;
    const nextTodos = planData.todos
      .map((todo, index) => ({ todo, key: todo.id || String(index) }))
      .filter(({ key }) => !trailingDeletedTodoKeys.includes(key))
      .map(({ todo, key }) => {
        const nextContent = (trailingTodoDrafts[key] ?? todo.content).trim();
        return { ...todo, content: nextContent || todo.content };
      })
      .concat(
        trailingAddedTodos
          .map(todo => ({ ...todo, content: (trailingTodoDrafts[todo.id] ?? todo.content).trim() }))
          .filter(todo => !!todo.content)
      );
    await saveTodoEdits(nextTodos);
    setIsTrailingTodoEditing(false);
    setTrailingTodoDrafts({});
    setTrailingDeletedTodoKeys([]);
    setTrailingAddedTodos([]);
  }, [planData, saveTodoEdits, trailingAddedTodos, trailingDeletedTodoKeys, trailingTodoDrafts]);

  const openYamlEditor = useCallback((source: 'inline' | 'trailing' | 'unknown' = 'unknown') => {
    if (source === 'inline') {
      setIsInlineTodoEditing(false);
      setInlineTodoDrafts({});
      setInlineDeletedTodoKeys([]);
      setInlineAddedTodos([]);
      setIsTodosExpanded(true);
      setYamlEditorPlacement('inline');
      return;
    }
    if (source === 'trailing') {
      setIsTrailingTodoEditing(false);
      setTrailingTodoDrafts({});
      setTrailingDeletedTodoKeys([]);
      setTrailingAddedTodos([]);
      setYamlEditorPlacement('trailing');
      return;
    }
    setYamlEditorPlacement('inline');
  }, []);

  const closeYamlEditor = useCallback(() => {
    setYamlEditorPlacement('none');
  }, []);

  const displayedInlineTodos = useMemo(() => {
    if (!planData?.todos) return [];
    if (!isInlineTodoEditing) return planData.todos;
    return [
      ...planData.todos.filter((todo, index) => !inlineDeletedTodoKeys.includes(todo.id || String(index))),
      ...inlineAddedTodos,
    ];
  }, [inlineAddedTodos, inlineDeletedTodoKeys, isInlineTodoEditing, planData]);

  const displayedTrailingTodos = useMemo(() => {
    if (!planData?.todos) return [];
    if (!isTrailingTodoEditing) return planData.todos;
    return [
      ...planData.todos.filter((todo, index) => !trailingDeletedTodoKeys.includes(todo.id || String(index))),
      ...trailingAddedTodos,
    ];
  }, [isTrailingTodoEditing, planData, trailingAddedTodos, trailingDeletedTodoKeys]);

  const renderSharedTodoPanel = useCallback((placement: 'inline' | 'trailing') => {
    const isInline = placement === 'inline';
    const isYamlEditingInPanel = yamlEditorPlacement === placement;
    const isPanelEditing = isInline ? isInlineTodoEditing : isTrailingTodoEditing;
    const panelTodos = isInline ? displayedInlineTodos : displayedTrailingTodos;
    const panelDrafts = isInline ? inlineTodoDrafts : trailingTodoDrafts;
    const startEdit = isInline ? startInlineTodoEdit : startTrailingTodoEdit;
    const cancelEdit = isInline ? cancelInlineTodoEdit : cancelTrailingTodoEdit;
    const addTodo = isInline ? handleAddInlineTodo : handleAddTrailingTodo;
    const saveEdit = isInline ? saveInlineTodoEdit : saveTrailingTodoEdit;
    const deleteTodo = isInline ? handleDeleteInlineTodo : handleDeleteTrailingTodo;

    const panelClassName = placement === 'trailing'
      ? `plan-viewer-todos plan-viewer-todos--trailing ${isEditingYaml ? 'plan-viewer-todos--yaml-editing' : ''}`
      : `plan-viewer-todos ${isTodosExpanded ? 'plan-viewer-todos--expanded' : ''} ${isEditingYaml ? 'plan-viewer-todos--yaml-editing' : ''}`;
    const toolbarClassName = `${placement === 'trailing' ? 'trailing-todo-toolbar' : 'todo-inline-toolbar'} ${isEditingYaml ? 'todo-toolbar--yaml' : ''}`;

    return (
      <div
        className={panelClassName}
        data-openbitfun-component="plan-viewer"
        data-openbitfun-part="editorPanel"
        data-openbitfun-state={isInline && isTodosExpanded ? 'expanded' : undefined}
      >
        <div className={toolbarClassName}>
          {isYamlEditingInPanel ? (
            <Tooltip content={t('editor.planViewer.toggleYamlEditOff')}>
              <IconButton
                type="button"
                size="sm"
                onClick={closeYamlEditor}
                aria-label={t('editor.planViewer.toggleYamlEditOff')}
                icon={<Icon name="xmark" size="lg" />}
              />
            </Tooltip>
          ) : isPanelEditing ? (
            <>
              <Tooltip content={t('editor.common.add')}>
                <IconButton
                  type="button"
                  size="sm"
                  onClick={addTodo}
                  aria-label={t('editor.common.add')}
                  icon={<Icon name="plus" size="lg" />}
                />
              </Tooltip>
              <Tooltip content={t('editor.common.save')}>
                <IconButton
                  type="button"
                  size="sm"
                  variant="primary"
                  onClick={saveEdit}
                  aria-label={t('editor.common.save')}
                  icon={<Icon name="check-line" size="lg" />}
                />
              </Tooltip>
              <Tooltip content={t('editor.common.cancel')}>
                <IconButton
                  type="button"
                  size="sm"
                  onClick={cancelEdit}
                  aria-label={t('editor.common.cancel')}
                  icon={<Icon name="xmark" size="lg" />}
                />
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip content={t('editor.planViewer.toggleYamlEditOn')}>
                <IconButton
                  type="button"
                  size="sm"
                  onClick={() => openYamlEditor(placement)}
                  aria-label={t('editor.planViewer.toggleYamlEditOn')}
                  icon={<FileText />}
                />
              </Tooltip>
              <Tooltip content={t('editor.common.edit')}>
                <IconButton
                  type="button"
                  size="sm"
                  onClick={startEdit}
                  aria-label={t('editor.common.edit')}
                  icon={<Icon name="edit" size="lg" />}
                />
              </Tooltip>
            </>
          )}
        </div>

        {isYamlEditingInPanel ? (
          <div className="yaml-editor-section" data-openbitfun-component="plan-viewer" data-openbitfun-part="editor">
            <div className="yaml-editor-content">
              <MEditor
                ref={yamlEditorRef}
                value={yamlContent}
                onChange={handleYamlChange}
                onSave={handleSave}
                mode="edit"
                height="200px"
                width="100%"
                placeholder={t('editor.planViewer.yamlPlaceholder')}
                readonly={false}
                toolbar={false}
                autofocus={true}
              />
            </div>
          </div>
        ) : (
          <div className="todos-list" data-openbitfun-component="plan-viewer" data-openbitfun-part="todos">
            {panelTodos.map((todo, index) => (
              <div
                key={todo.id || index}
                className={`todo-item status-${todo.status || 'pending'}`}
                data-openbitfun-component="plan-viewer"
                data-openbitfun-part="todo"
              >
                {getTodoIcon(todo.status)}
                {isPanelEditing ? (
                  <>
                    <Input
                      className="todo-content-input-field"
                      value={panelDrafts[todo.id || String(index)] ?? todo.content}
                      onValueChange={(value) => {
                        const key = todo.id || String(index);
                        if (isInline) {
                          setInlineTodoDrafts(prev => ({ ...prev, [key]: value }));
                        } else {
                          setTrailingTodoDrafts(prev => ({ ...prev, [key]: value }));
                        }
                      }}
                    />
                    <Tooltip content={t('editor.common.delete')}>
                      <IconButton
                        type="button"
                        size="sm"
                        tone="danger"
                        onClick={() => deleteTodo(todo.id || String(index))}
                        aria-label={t('editor.common.delete')}
                        icon={<Icon name="delete" size="lg" />}
                      />
                    </Tooltip>
                  </>
                ) : (
                  <span className="todo-content">{todo.content}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }, [
    cancelInlineTodoEdit,
    cancelTrailingTodoEdit,
    closeYamlEditor,
    displayedInlineTodos,
    displayedTrailingTodos,
    handleAddInlineTodo,
    handleAddTrailingTodo,
    handleDeleteInlineTodo,
    handleDeleteTrailingTodo,
    handleSave,
    handleYamlChange,
    isInlineTodoEditing,
    isEditingYaml,
    isTodosExpanded,
    isTrailingTodoEditing,
    openYamlEditor,
    saveInlineTodoEdit,
    saveTrailingTodoEdit,
    startInlineTodoEdit,
    startTrailingTodoEdit,
    t,
    inlineTodoDrafts,
    trailingTodoDrafts,
    yamlContent,
    yamlEditorPlacement,
  ]);

  // Build button click handler
  const handleBuild = useCallback(async () => {
    if (!filePath || buildStatus !== 'build' || !planData || hasUnsavedChanges) return;

    try {
      const sessionId = flowChatManager.getCurrentSession()?.sessionId;
      if (!sessionId) {
        throw new Error('No active session');
      }
      // Register build in shared service (notifies all PlanDisplay and PlanViewer subscribers).
      const todoIds = planData.todos.map(t => t.id);
      const turnId = planBuildStateService.startBuild({
        sessionId,
        planFilePath: filePath,
        todoIds,
        workspaceId: effectiveWorkspaceId,
        workspacePath: effectiveWorkspacePath,
        remoteConnectionId: effectiveRemoteConnectionId,
      });
      if (!turnId) return;

      const message = `Implement the plan at \`${filePath}\`.

Read the plan file before making changes and treat it as the source of truth. Do not edit the plan file directly. Track progress with TodoWrite using the existing todo IDs from the plan frontmatter; do not rename or invent IDs. Start with the first pending todo and continue until all todos are completed.`;

      const displayMessage = t('editor.planViewer.buildPlanTitle', { name: planData.name });
      await flowChatManager.sendMessage(
        message,
        sessionId,
        displayMessage,
        undefined,
        undefined,
        { turnId },
      );
    } catch (err) {
      log.error('Build failed', err);
      planBuildStateService.cancelBuild(planFileRef);
    }
  }, [filePath, planFileRef, buildStatus, effectiveRemoteConnectionId, effectiveWorkspaceId, effectiveWorkspacePath, hasUnsavedChanges, planData, t]);

  // Get todo status icon
  function getTodoIcon(status?: string) {
    switch (status) {
      case 'completed':
        return <Icon name="check-line" size="sm" className="todo-icon todo-icon--completed" />;
      case 'in_progress':
        return <Icon name="arrow-right" size="sm" className="todo-icon todo-icon--in-progress" />;
      case 'cancelled':
        return <Icon name="xmark" size="sm" className="todo-icon todo-icon--cancelled" />;
      case 'pending':
      default:
        return <Icon name="unselected" size="sm" className="todo-icon todo-icon--pending" />;
    }
  }

  // Render loading state
  if (loading) {
    return (
      <div className="openbitfun-plan-viewer openbitfun-plan-viewer--loading" data-openbitfun-component="plan-viewer" data-openbitfun-part="loading" data-openbitfun-state="loading">
        <LoadingState size="md">{t('editor.planViewer.loadingPlan')}</LoadingState>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="openbitfun-plan-viewer openbitfun-plan-viewer--error" data-openbitfun-component="plan-viewer" data-openbitfun-part="error" data-openbitfun-state="error">
        <div className="error-content">
          <AlertCircle className="error-icon" />
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={loadFileContent}>
            {t('editor.common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="openbitfun-plan-viewer"
      data-openbitfun-component="plan-viewer"
      data-openbitfun-part="root"
      data-openbitfun-state={hasTodos && isTodosExpanded ? 'expanded' : undefined}
    >
      <div data-overflow-trigger
        className={`plan-viewer-header ${hasTodos ? 'plan-viewer-header--collapsible' : ''}`}
        data-openbitfun-component="plan-viewer"
        data-openbitfun-part="header"
        onClick={() => {
          if (hasTodos && !isEditingYaml) {
            setIsTodosExpanded(!isTodosExpanded);
          }
        }}
      >
        <div className="header-left" data-openbitfun-component="plan-viewer" data-openbitfun-part="headerMain">
          {hasTodos && (
            <span
              className={`header-expand-indicator ${isTodosExpanded ? 'header-expand-indicator--expanded' : ''} ${isEditingYaml ? 'header-expand-indicator--disabled' : ''}`}
            >
              <Icon name="chevron-down" size="sm" />
            </span>
          )}
          <FileText size={16} className="file-icon" />
          <OverflowText className="file-name">{displayFileName}</OverflowText>
          {hasUnsavedChanges && <span className="unsaved-indicator">{t('editor.planViewer.unsaved')}</span>}
        </div>
        <div className="header-right" onClick={(e) => e.stopPropagation()} data-openbitfun-component="plan-viewer" data-openbitfun-part="headerActions">
          {hasTodos && (
            <>
              <span className="todos-count">{t('editor.planViewer.remainingTodos', { count: remainingTodos })}</span>

              <Button
                type="button"
                variant="primary"
                size="sm"
                leadingIcon={
                  buildStatus === 'building'
                    ? <Loader2 size={14} className="animate-spin" />
                    : buildStatus === 'built'
                      ? <Icon name="check-circle" size="sm" />
                      : undefined
                }
                onClick={handleBuild}
                disabled={buildStatus !== 'build' || hasUnsavedChanges}
              >
                {buildStatus === 'building'
                  ? t('editor.planViewer.building')
                  : buildStatus === 'built'
                    ? t('editor.planViewer.built')
                    : t('editor.planViewer.build')}
              </Button>
            </>
          )}
        </div>
      </div>

      {hasTodos && (yamlEditorPlacement === 'inline' || isTodosExpanded) && renderSharedTodoPanel('inline')}

      <div className="plan-viewer-content" data-openbitfun-component="plan-viewer" data-openbitfun-part="content">
        <div className="plan-markdown" data-openbitfun-component="plan-viewer" data-openbitfun-part="markdown">
          <MEditor
            ref={editorRef}
            value={planContent}
            onChange={handleContentChange}
            onDirtyChange={handleContentDirtyChange}
            onSave={handleSave}
            mode="ir"
            height="auto"
            width="100%"
            placeholder={t('editor.planViewer.contentPlaceholder')}
            readonly={false}
            toolbar={false}
            filePath={filePath}
            basePath={basePath}
          />
        </div>
        {hasTodos && yamlEditorPlacement !== 'inline' && renderSharedTodoPanel('trailing')}
      </div>
    </div>
  );
};

export default PlanViewer;
