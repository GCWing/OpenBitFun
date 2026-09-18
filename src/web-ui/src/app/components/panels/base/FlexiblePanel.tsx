import React, { useCallback, memo } from 'react';
import { OverflowText, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { AlertCircle } from 'lucide-react';

import { MarkdownRenderer } from '@/infrastructure/markdown';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useEditorDocument } from '@/tools/editor/services/EditorDocument';

const log = createLogger('FlexiblePanel');

function updateGenerativeWidgetResultCode(result: unknown, widgetCode: string): unknown {
  if (!result) {
    return result;
  }

  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          widget_code: widgetCode,
        });
      }
    } catch {
      return result;
    }
  }

  if (typeof result === 'object') {
    return {
      ...(result as Record<string, unknown>),
      widget_code: widgetCode,
    };
  }

  return result;
}

// Stable lazy components at module level to avoid re-creation on each render
const GitDiffView = React.lazy(() =>
  import('@/tools/git/components/GitDiffView/GitDiffView')
);

const GitSettingsView = React.lazy(() => 
  import('@/tools/git/components/GitSettingsView/GitSettingsView')
);

const CodeEditor = React.lazy(() =>
  import('@/tools/editor/components/CodeEditor').then(module => ({
    default: module.default,
  }))
);

const MarkdownEditor = React.lazy(() =>
  import('@/tools/editor/components/MarkdownEditor').then(module => ({
    default: module.default,
  }))
);

const ImageViewer = React.lazy(() =>
  import('@/tools/editor/components/ImageViewer').then(module => ({
    default: module.default,
  }))
);

const PdfViewer = React.lazy(() =>
  import('@/tools/editor/components/PdfViewer').then(module => ({
    default: module.default,
  }))
);

const DiffEditor = React.lazy(() =>
  import('@/tools/editor/components/DiffEditor').then(module => ({
    default: module.default,
  }))
);

const GitDiffEditor = React.lazy(() =>
  import('@/tools/git/components/GitDiffEditor/GitDiffEditor').then(module => ({
    default: module.default,
  }))
);

const GitGraphView = React.lazy(() => 
  import('@/tools/git/components/GitGraphView/GitGraphView').then(module => ({ 
    default: module.GitGraphView 
  }))
);

const GitBranchHistoryView = React.lazy(() =>
  import('@/tools/git/components/GitBranchHistoryView/GitBranchHistoryView').then(module => ({
    default: module.GitBranchHistoryView
  }))
);

// Plan viewer component
const PlanViewer = React.lazy(() => 
  import('@/tools/editor/components/PlanViewer').then(module => ({ 
    default: module.default 
  }))
);

// Uses ConnectedTerminal to auto-connect backend
const TerminalTabPanel = React.lazy(() => 
  import('@/tools/terminal/components/ConnectedTerminal')
);

const BrowserPanel = React.lazy(() =>
  import('@/app/scenes/browser/BrowserPanel')
);
const HtmlPreviewPanel = React.lazy(() =>
  import('@/app/scenes/browser/HtmlPreviewPanel')
);

const GenerativeWidgetPanel = React.lazy(() =>
  import('@/tools/generative-widget/GenerativeWidgetPanel')
);

const OpenBitFunCanvasPanel = React.lazy(() =>
  import('@/tools/openbitfun-canvas/OpenBitFunCanvasPanel')
);

const TaskDetailPanel = React.lazy(() => 
  import('@/flow_chat/components/TaskDetailPanel').then(module => ({ 
    default: module.TaskDetailPanel 
  }))
);

const BtwSessionPanel = React.lazy(() =>
  import('@/flow_chat/components/btw/BtwSessionPanel').then(module => ({
    default: module.BtwSessionPanel
  }))
);

const SessionUsagePanel = React.lazy(() =>
  import('@/flow_chat/components/usage/SessionUsagePanel').then(module => ({
    default: module.SessionUsagePanel
  }))
);

const BackgroundCommandOutputPanel = React.lazy(() =>
  import('@/flow_chat/components/background-command/BackgroundCommandOutputPanel').then(module => ({
    default: module.BackgroundCommandOutputPanel
  }))
);

const ReviewPlatformPanel = React.lazy(() =>
  import('@/app/components/panels/review-platform/ReviewPlatformPanel')
);

// CodePreview, ChartRenderer and CodeNode removed - visualization features disabled
import { 
  FlexiblePanelProps
} from './types';
import { 
  getContentIcon, 
  getContentTypeName, 
  shouldShowHeader,
  generateFileName
} from './utils';
import './FlexiblePanel.scss';

interface ExtendedFlexiblePanelProps extends FlexiblePanelProps {
  onDirtyStateChange?: (isDirty: boolean) => void;
  /** Whether this panel is the active/visible tab in its EditorGroup */
  isActive?: boolean;
  /** File no longer exists on disk (from editor); drives tab "deleted" label */
  onFileMissingFromDiskChange?: (missing: boolean) => void;
}

const FlexiblePanel: React.FC<ExtendedFlexiblePanelProps> = memo(({
  content,
  onContentChange,
  className = '',
  onInteraction,
  workspacePath,
  onBeforeClose,
  onDirtyStateChange,
  isActive = true,
  onFileMissingFromDiskChange,
  terminalResizeSuspended = false,
}) => {
  const { t, formatDate } = useI18n('components');
  const documentSession = useEditorDocument();

  // Use ref to save latest content, avoiding it in callback dependencies
  const contentRef = React.useRef(content);
  React.useEffect(() => {
    contentRef.current = content;
  }, [content, onInteraction]);

  // Sync dirty state from MonacoModelManager on component mount
  React.useEffect(() => {
    if (content?.type !== 'code-editor') {
      return;
    }
    
    const filePath = content?.data?.filePath;
    if (!filePath || !onDirtyStateChange) return;
    
    import('@/tools/editor/services/MonacoModelManager').then(({ monacoModelManager }) => {
      const metadata = monacoModelManager.getModelMetadata(documentSession?.modelKey ?? filePath);
      if (metadata !== undefined) {
        onDirtyStateChange(metadata.isDirty);
      }
    }).catch(() => {});
  }, [content?.type, content?.data?.filePath, documentSession?.modelKey, onDirtyStateChange]);

  const handleClose = useCallback(async () => {
    if (onBeforeClose) {
      const canClose = await onBeforeClose(content);
      if (!canClose) {
        return;
      }
    }
    
    onContentChange?.(null);
  }, [onContentChange, onBeforeClose, content]);

  const handleCopy = useCallback(() => {
    if (!content?.data) return;
    
    let textToCopy = '';
    if (typeof content.data === 'string') {
      textToCopy = content.data;
    } else if (content.data.content) {
      textToCopy = content.data.content;
    }
    
    navigator.clipboard.writeText(textToCopy).then(() => {
      // User feedback for successful copy can be implemented via global notification system
      if (onInteraction) {
        onInteraction('copy', 'success');
      }
    }).catch(() => {
      if (onInteraction) {
        onInteraction('copy', 'failed');
      }
    });
  }, [content, onInteraction]);

  const handleDownload = useCallback(() => {
    if (!content?.data) return;
    
    let textToDownload = '';
    if (typeof content.data === 'string') {
      textToDownload = content.data;
    } else if (content.data.content) {
      textToDownload = content.data.content;
    }
    
    const filename = generateFileName(content.type, content.title);
    const blob = new Blob([textToDownload], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content]);

  const renderEditorLoading = () => (
    <div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">
      {t('select.loading')}
    </div>
  );

  const renderLazyEditor = (node: React.ReactNode) => (
    <React.Suspense fallback={renderEditorLoading()}>
      {node}
    </React.Suspense>
  );

  const renderContent = () => {
    if (!content || content.type === 'empty') {
      return (
        <div className="openbitfun-flexible-panel__empty-content" data-openbitfun-component="flexible-panel" data-openbitfun-part="empty">
          <div className="openbitfun-flexible-panel__empty-icon">
            {getContentIcon('empty')}
          </div>
          <h3>{t('flexiblePanel.empty.title')}</h3>
          <p>{t('flexiblePanel.empty.description')}</p>
        </div>
      );
    }

    switch (content.type) {
      case 'code-preview': {
        const previewData = content.data || {};
        const hasFixNeeded = previewData.migrationContext?.hasUpgradePoints || previewData.needsFix || false;
        
        return (
          <div
            className={`openbitfun-flexible-panel__code-content ${hasFixNeeded ? 'needs-fix' : ''}`}
            data-openbitfun-component="flexible-panel"
            data-openbitfun-part="code"
            data-openbitfun-state={hasFixNeeded ? 'needsFix' : undefined}
          >
            <pre><code>{typeof content.data === 'string' ? content.data : t('flexiblePanel.fallback.noCodeContent')}</code></pre>
          </div>
        );
      }

      case 'markdown-viewer':
        return (
          <div className="openbitfun-flexible-panel__markdown-content" data-openbitfun-component="flexible-panel" data-openbitfun-part="markdown">
            <MarkdownRenderer content={typeof content.data === 'string' ? content.data : ''} />
          </div>
        );

      case 'markdown-editor': {
        const markdownEditorData = content.data || {};
        const markdownFilePath = markdownEditorData.filePath;
        const markdownInitialContent = markdownEditorData.initialContent;
        const markdownFileName = markdownEditorData.fileName || content.title;
        const markdownWorkspacePath = markdownEditorData.workspacePath || workspacePath;
        const markdownJumpToLine = markdownEditorData.jumpToLine ?? markdownEditorData.jumpToRange?.start;
        const markdownJumpToColumn = markdownEditorData.jumpToColumn;

        return (
          <div className="openbitfun-flexible-panel__markdown-editor" data-openbitfun-component="flexible-panel" data-openbitfun-part="markdownEditor">
            {markdownFilePath || markdownInitialContent !== undefined ? (
              renderLazyEditor(
                <MarkdownEditor
                  filePath={markdownFilePath}
                  initialContent={markdownInitialContent}
                  fileName={markdownFileName}
                  workspacePath={markdownWorkspacePath}
                  readOnly={markdownEditorData.readOnly || false}
                  jumpToLine={markdownJumpToLine}
                  jumpToColumn={markdownJumpToColumn}
                  navigationToken={markdownEditorData.navigationToken}
                  isActiveTab={isActive}
                  onFileMissingFromDiskChange={onFileMissingFromDiskChange}
                  onContentChange={(_newContent, hasChanges) => {
                    if (onDirtyStateChange) {
                      onDirtyStateChange(hasChanges);
                    }
                  }}
                  onSave={(_savedContent) => {
                    if (onDirtyStateChange) {
                      onDirtyStateChange(false);
                    }
                  }}
                />
              )
            ) : (
              <div className="openbitfun-flexible-panel__error-message" data-openbitfun-component="flexible-panel" data-openbitfun-part="error">
                <AlertCircle size={20} />
                <p>{t('flexiblePanel.errors.markdownEditorMissingPath')}</p>
              </div>
            )}
          </div>
        );
      }


      case 'text-viewer':
        return (
          <div className="openbitfun-flexible-panel__text-content" data-openbitfun-component="flexible-panel" data-openbitfun-part="text">
            <pre>{typeof content.data === 'string' ? content.data : 'No text content available'}</pre>
          </div>
        );

      case 'file-viewer': {
        const fileViewerData = content.data || {};
        const fileNeedsFix = fileViewerData.migrationContext?.hasUpgradePoints || fileViewerData.needsFix || false;
        const fileViewerClass = `openbitfun-flexible-panel__panel-code-viewer ${fileNeedsFix ? 'needs-fix' : ''}`;
        
        return (
          <div className="openbitfun-flexible-panel__code-viewer-container" data-openbitfun-component="flexible-panel" data-openbitfun-part="viewer">
            {renderLazyEditor(
              <CodeEditor
                filePath={fileViewerData.filePath || ''}
                initialContent={fileViewerData.initialContent}
                fileName={content.title}
                readOnly={true}
                showLineNumbers={true}
                showMinimap={true}
                className={fileViewerClass}
                isActiveTab={isActive}
                onFileMissingFromDiskChange={onFileMissingFromDiskChange}
              />
            )}
          </div>
        );
      }

      case 'image-viewer': {
        const imageViewerData = content.data || {};
        
        return (
          <div className="openbitfun-flexible-panel__image-viewer-container" data-openbitfun-component="flexible-panel" data-openbitfun-part="image">
            {renderLazyEditor(
              <ImageViewer
                isActiveTab={isActive}
                filePath={imageViewerData.filePath || ''}
                imageSource={imageViewerData.imageSource}
                fileName={content.title}
                workspacePath={workspacePath}
                className="openbitfun-flexible-panel__image-viewer"
              />
            )}
          </div>
        );
      }

      case 'pdf-viewer': {
        const pdfViewerData = content.data || {};

        return (
          <div className="openbitfun-flexible-panel__pdf-viewer-container" data-openbitfun-component="flexible-panel" data-openbitfun-part="pdf">
            {renderLazyEditor(
              <PdfViewer
                isActiveTab={isActive}
                filePath={pdfViewerData.filePath || ''}
                fileName={content.title}
                className="openbitfun-flexible-panel__pdf-viewer"
              />
            )}
          </div>
        );
      }

      case 'code-viewer': {
        const codeData = content.data || {};
        const migrationContext = codeData.migrationContext || {};
        const needsFix = migrationContext.hasUpgradePoints || codeData.needsFix || false;
        
        return (
          <div className="openbitfun-flexible-panel__code-viewer-container" data-openbitfun-component="flexible-panel" data-openbitfun-part="viewer">
            <div
              className={`openbitfun-flexible-panel__code-content ${needsFix ? 'needs-fix' : ''}`}
              data-openbitfun-component="flexible-panel"
              data-openbitfun-part="code"
              data-openbitfun-state={needsFix ? 'needsFix' : undefined}
            >
              {renderLazyEditor(
                <CodeEditor
                  filePath={codeData.filePath || ''}
                  fileName={codeData.fileName}
                  language={codeData.language || 'typescript'}
                  readOnly={codeData.readOnly !== false}
                  showLineNumbers={true}
                  showMinimap={true}
                  onContentChange={codeData.onContentChange}
                  isActiveTab={isActive}
                  onFileMissingFromDiskChange={onFileMissingFromDiskChange}
                />
              )}
            </div>
          </div>
        );
      }

      case 'code-editor': {
        const editorData = content.data || {};
        const filePath = editorData.filePath || '';
        const fileName = editorData.fileName || content.title;
        const editorLanguage = editorData.language;
        const editorWorkspacePath = editorData.workspacePath || workspacePath;
        const syncGenerativeWidgetToolResult = async (nextWidgetCode: string, persistToSession: boolean) => {
          const source = editorData._source;
          if (
            source?.type !== 'tool-call' ||
            source.toolName !== 'GenerativeUI' ||
            (!source.toolCallId && !source.toolItemId)
          ) {
            return;
          }

          const { flowChatStore } = await import('@/flow_chat/store/FlowChatStore');
          const state = flowChatStore.getState();
          const activeSessionId = source.sessionId || state.activeSessionId;
          if (!activeSessionId) {
            return;
          }

          const session = state.sessions.get(activeSessionId);
          if (!session) {
            return;
          }

          for (const turn of session.dialogTurns) {
            for (const round of turn.modelRounds) {
              const item = round.items.find(
                (it: any) =>
                  it.type === 'tool' &&
                  (
                    (source.toolCallId && it.toolCall?.id === source.toolCallId) ||
                    (source.toolItemId && it.id === source.toolItemId)
                  )
              );

              if (!item) {
                continue;
              }

              const toolItem = item as any;
              flowChatStore.updateModelRoundItem(activeSessionId, turn.id, toolItem.id, {
                toolCall: {
                  ...toolItem.toolCall,
                  input: {
                    ...toolItem.toolCall?.input,
                    widget_code: nextWidgetCode,
                  },
                },
                toolResult: toolItem.toolResult
                  ? {
                      ...toolItem.toolResult,
                      result: updateGenerativeWidgetResultCode(toolItem.toolResult.result, nextWidgetCode),
                    }
                  : toolItem.toolResult,
              } as any);

              if (persistToSession) {
                const { flowChatManager } = await import('@/flow_chat/services/FlowChatManager');
                await flowChatManager.saveDialogTurn(activeSessionId, turn.id);
              }
              return;
            }
          }
        };

        return renderLazyEditor(
          <CodeEditor
            filePath={filePath}
            workspacePath={editorWorkspacePath}
            fileName={fileName}
            language={editorLanguage}
            initialContent={typeof editorData.initialContent === 'string' ? editorData.initialContent : undefined}
            readOnly={editorData.readOnly || false}
            autoSave={editorData.autoSave === true}
            autoSaveDelayMs={typeof editorData.autoSaveDelayMs === 'number' ? editorData.autoSaveDelayMs : undefined}
            showLineNumbers={editorData.showLineNumbers !== false}
            showMinimap={editorData.showMinimap !== false}
            jumpToLine={editorData.jumpToLine}
            jumpToColumn={editorData.jumpToColumn}
            jumpToRange={editorData.jumpToRange}
            navigationToken={editorData.navigationToken}
            isActiveTab={isActive}
            onFileMissingFromDiskChange={onFileMissingFromDiskChange}
            onContentChange={(newContent, hasChanges) => {
              if (onContentChange) {
                onContentChange({
                  ...content,
                  data: {
                    ...editorData,
                    content: newContent,
                    hasChanges
                  }
                });
              }

              if (onDirtyStateChange) {
                onDirtyStateChange(hasChanges);
              }

              void syncGenerativeWidgetToolResult(newContent, false);
            }}
            onSave={(content) => {
              if (onInteraction) {
                onInteraction('save', JSON.stringify({ filePath, content }));
              }

              if (onDirtyStateChange) {
                onDirtyStateChange(false);
              }

              void syncGenerativeWidgetToolResult(content, true);
            }}
          />
        );
      }

      case 'diff-code-editor': {
        const diffData = content.data || {};
        const originalCode = diffData.originalCode || '';
        const modifiedCode = diffData.modifiedCode || originalCode;
        const diffFilePath = diffData.filePath;
        const diffMigrationContext = diffData.migrationContext;
        const diffRepositoryPath = diffData.repositoryPath;
        
        const diffViewerKey = `diff-${diffFilePath || 'unknown'}-${originalCode.length}-${modifiedCode.length}`;
        
        if (diffRepositoryPath && diffFilePath) {
          return renderLazyEditor(
            <GitDiffEditor
              key={diffViewerKey}
              originalContent={originalCode}
              modifiedContent={modifiedCode}
              filePath={diffFilePath}
              workspaceId={diffData.workspaceId ?? content.metadata?.resourceScope?.workspaceId}
              repositoryPath={diffRepositoryPath}
              onAcceptAll={() => {
                diffMigrationContext?.onAcceptAll?.();
                window.dispatchEvent(new CustomEvent('git-status-changed', {
                  detail: { repositoryPath: diffRepositoryPath }
                }));
              }}
              onRejectAll={() => {
                diffMigrationContext?.onRejectAll?.();
                window.dispatchEvent(new CustomEvent('git-status-changed', {
                  detail: { repositoryPath: diffRepositoryPath }
                }));
              }}
              onClose={() => {}}
              onContentChange={(_newContent, hasChanges) => {
                if (onDirtyStateChange) {
                  onDirtyStateChange(hasChanges);
                }
              }}
              onSave={() => {
                if (onDirtyStateChange) {
                  onDirtyStateChange(false);
                }
              }}
            />
          );
        }
        // The diff tab is owned by a workspace ID; the path is only the IO root.
        const diffOwnerWorkspaceId: string | undefined =
          diffData.workspaceId ?? content.metadata?.resourceScope?.workspaceId;
        
        return renderLazyEditor(
          <DiffEditor
            key={diffViewerKey}
            originalContent={originalCode}
            modifiedContent={modifiedCode}
            filePath={diffFilePath}
            revealLine={diffData.revealLine}
            readOnly={false}
            renderSideBySide={true}
            onSave={async (content) => {
              try {
                const targetWorkspaceId = diffOwnerWorkspaceId;
                const targetWorkspacePath = workspacePath || diffMigrationContext?.workspacePath;
                if (!diffFilePath || (!targetWorkspaceId && !targetWorkspacePath)) {
                  log.warn('DiffEditor save failed: missing workspace owner or filePath');
                  return;
                }

                const { workspaceAPI } = await import('@/infrastructure/api');
                if (targetWorkspaceId) {
                  await workspaceAPI.writeWorkspaceFile(targetWorkspaceId, diffFilePath, content);
                } else {
                  await workspaceAPI.writeFileContent(targetWorkspacePath!, diffFilePath, content);
                }

                globalEventBus.emit('file-tree:refresh');

                if (onDirtyStateChange) {
                  onDirtyStateChange(false);
                }
              } catch (error) {
                log.error('DiffEditor save failed', error);
                throw error;
              }
            }}
          />
        );
      }

      case 'git-diff':
        return (
          <React.Suspense fallback={<div>{t('flexiblePanel.loading.gitDiff')}</div>}>
            <GitDiffView 
              repositoryPath={{ workspaceId: content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? '', repositoryPath: content.data?.repositoryPath || workspacePath }}
              sourceCommit={content.data?.sourceCommit}
              targetCommit={content.data?.targetCommit}
              filePath={content.data?.filePath}
            />
          </React.Suspense>
        );

      case 'git-graph':
        return (
          <React.Suspense fallback={<div>{t('flexiblePanel.loading.gitGraph')}</div>}>
            <GitGraphView 
              repositoryPath={{ workspaceId: content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? '', repositoryPath: content.data?.repositoryPath || workspacePath }}
              maxCount={content.data?.maxCount}
            />
          </React.Suspense>
        );

      case 'git-branch-history':
        return (
          <React.Suspense fallback={<div>{t('flexiblePanel.loading.gitBranchHistory')}</div>}>
            <GitBranchHistoryView 
              repositoryPath={{ workspaceId: content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? '', repositoryPath: content.data?.repositoryPath || workspacePath }}
              branchName={content.data?.branchName || 'main'}
              currentBranch={content.data?.currentBranch}
              maxCount={content.data?.maxCount || 100}
            />
          </React.Suspense>
        );

      case 'ai-session':
        return (
          <div className="ai-session-content" data-openbitfun-component="flexible-panel" data-openbitfun-part="aiSession">
            <div className="session-header" data-openbitfun-component="flexible-panel" data-openbitfun-part="sessionHeader">
              <h3>{t('flexiblePanel.aiSession.title', { sessionId: content.data?.sessionId?.slice(0, 8) || t('flexiblePanel.aiSession.unknown') })}</h3>
              <div className="session-info">
                <span className="agent-type">{content.data?.agent_info?.agent_type || t('flexiblePanel.aiSession.unknown')}</span>
                <span className="model-name">({content.data?.agent_info?.model_name || t('flexiblePanel.aiSession.unknown')})</span>
              </div>
            </div>
            <div className="session-details" data-openbitfun-component="flexible-panel" data-openbitfun-part="sessionDetails">
              <div className="detail-item">
                <span className="label">{t('flexiblePanel.aiSession.sessionStatus')}</span>
                <span className={`status status-${content.data?.status?.toLowerCase() || 'unknown'}`}>
                  {content.data?.status || t('flexiblePanel.aiSession.unknown')}
                </span>
              </div>
              <div className="detail-item">
                <span className="label">{t('flexiblePanel.aiSession.operationsCount')}</span>
                <span className="value">{t('flexiblePanel.aiSession.operationsValue', { count: content.data?.operations?.length || 0 })}</span>
              </div>
              <div className="detail-item">
                <span className="label">{t('flexiblePanel.aiSession.startTime')}</span>
                <span className="value">
                  {content.data?.start_time
                    ? formatDate(new Date(content.data.start_time), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                    : t('flexiblePanel.aiSession.unknownTime')}
                </span>
              </div>
            </div>
            {content.data?.operations && content.data.operations.length > 0 && (
              <div className="operations-list" data-openbitfun-component="flexible-panel" data-openbitfun-part="operations">
                <h4>{t('flexiblePanel.aiSession.fileOperations')}</h4>
                {content.data.operations.map((operation: any, index: number) => (
                  <div key={operation.operation_id || index} className="operation-item" data-openbitfun-component="flexible-panel" data-openbitfun-part="operation">
                    <div className="operation-header">
                      <span className={`operation-type type-${operation.operation_type?.toLowerCase() || 'unknown'}`}>
                        {operation.operation_type || t('flexiblePanel.aiSession.unknown')}
                      </span>
                      <span className="file-path">{operation.file_path || t('flexiblePanel.aiSession.unknown')}</span>
                    </div>
                    <div className="operation-status">
                      <span className={`status status-${operation.status?.toLowerCase() || 'unknown'}`}>
                        {operation.status || t('flexiblePanel.aiSession.unknown')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'git-settings':
        return (
          <React.Suspense fallback={<div>{t('flexiblePanel.loading.gitSettings')}</div>}>
            <GitSettingsView 
              repositoryPath={{ workspaceId: content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? '', repositoryPath: content.data?.repositoryPath || workspacePath }}
            />
          </React.Suspense>
        );


      case 'task-detail': {
        const taskDetailData = content.data || {};
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.taskDetail')}</div>}>
            <TaskDetailPanel data={taskDetailData} />
          </React.Suspense>
        );
      }

      case 'plan-viewer': {
        const planViewerData = content.data || {};
        const planFilePath = planViewerData.filePath || '';
        const planFileName = planViewerData.fileName || content.title;
        const planWorkspaceId = planViewerData.workspaceId || content.metadata?.resourceScope?.workspaceId;
        const planWorkspacePath = planViewerData.workspacePath || workspacePath;
        const planJumpToLine = planViewerData.jumpToLine;
        const planJumpToColumn = planViewerData.jumpToColumn;
        
        if (!planFilePath) {
          return (
            <div className="openbitfun-flexible-panel__error-message" data-openbitfun-component="flexible-panel" data-openbitfun-part="error">
              <AlertCircle size={20} />
              <p>{t('flexiblePanel.errors.planViewerMissingPath')}</p>
            </div>
          );
        }
        
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.planViewer')}</div>}>
            <PlanViewer
              filePath={planFilePath}
              fileName={planFileName}
              workspaceId={planWorkspaceId}
              workspacePath={planWorkspacePath}
              jumpToLine={planJumpToLine}
              jumpToColumn={planJumpToColumn}
            />
          </React.Suspense>
        );
      }

      case 'terminal': {
        // Terminal panel
        const terminalData = content.data || {};
        const sessionId = terminalData.sessionId;
        
        if (!sessionId) {
          return (
            <div className="openbitfun-flexible-panel__error-message" data-openbitfun-component="flexible-panel" data-openbitfun-part="error">
              <AlertCircle size={20} />
              <p>{t('flexiblePanel.errors.terminalMissingSessionId')}</p>
            </div>
          );
        }
        
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.terminal')}</div>}>
            <div className="openbitfun-flexible-panel__terminal-container" data-openbitfun-component="flexible-panel" data-openbitfun-part="terminal">
              <TerminalTabPanel
                key={sessionId}
                sessionId={sessionId}
                autoFocus={isActive}
                closeBehavior="detach"
                onClose={() => onContentChange?.(null)}
                resizeSuspended={!isActive || terminalResizeSuspended}
              />
            </div>
          </React.Suspense>
        );
      }

      case 'btw-session':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.taskDetail')}</div>}>
            <BtwSessionPanel
              isActive={isActive}
              childSessionId={content.data?.childSessionId}
              parentSessionId={content.data?.parentSessionId}
              workspaceId={content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId}
              workspacePath={content.data?.workspacePath || workspacePath}
              viewKind={content.data?.viewKind}
              displayTitle={content.data?.displayTitle}
            />
          </React.Suspense>
        );

      case 'session-usage':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.taskDetail')}</div>}>
            <SessionUsagePanel
              report={content.data?.report}
              markdown={content.data?.markdown}
              sessionId={content.data?.sessionId}
              workspacePath={content.data?.workspacePath || workspacePath}
              initialTab={content.data?.initialTab}
            />
          </React.Suspense>
        );

      case 'background-command-output':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.terminal')}</div>}>
            <BackgroundCommandOutputPanel data={content.data} />
          </React.Suspense>
        );

      case 'review-platform':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">Loading pull requests...</div>}>
            <ReviewPlatformPanel workspaceId={content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? ''} workspacePath={content.data?.workspacePath || workspacePath} />
          </React.Suspense>
        );

      case 'review-platform-pr-detail':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">Loading pull request...</div>}>
            <ReviewPlatformPanel
              workspaceId={content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? ''}
              workspacePath={content.data?.workspacePath || workspacePath}
              initialRemoteId={content.data?.remoteId}
              initialPullRequestId={content.data?.pullRequestId}
              initialPullRequestUrl={content.data?.pullRequestUrl}
              detailOnly
            />
          </React.Suspense>
        );

      case 'browser':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">{t('flexiblePanel.loading.terminal')}</div>}>
            <BrowserPanel
              key={content.data?.openRequestId ?? 'browser-panel'}
              isActive={isActive}
              initialUrl={content.data?.url}
              openRequestId={content.data?.openRequestId}
            />
          </React.Suspense>
        );

      case 'html-preview':
        return (
          <React.Suspense fallback={renderEditorLoading()}>
            <HtmlPreviewPanel
              isActive={isActive}
              filePath={content.data?.filePath || ''}
              workspaceId={content.data?.workspaceId ?? content.metadata?.resourceScope?.workspaceId ?? ''}
            />
          </React.Suspense>
        );

      case 'generative-widget':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">Loading widget preview...</div>}>
            <GenerativeWidgetPanel
              title={content.title}
              widgetId={content.data?.widgetId}
              widgetCode={content.data?.widgetCode}
              onWidgetCodePersist={async (nextWidgetCode) => {
                if (onContentChange) {
                  onContentChange({
                    ...content,
                    data: {
                      ...content.data,
                      widgetCode: nextWidgetCode,
                    },
                  });
                }

                const source = content.data?._source;
                if (
                  source?.type !== 'tool-call' ||
                  source.toolName !== 'GenerativeUI' ||
                  (!source.toolCallId && !source.toolItemId)
                ) {
                  return;
                }

                const { flowChatStore } = await import('@/flow_chat/store/FlowChatStore');
                const { flowChatManager } = await import('@/flow_chat/services/FlowChatManager');
                const state = flowChatStore.getState();
                const sessionId = source.sessionId || state.activeSessionId;
                if (!sessionId) {
                  return;
                }

                const session = state.sessions.get(sessionId);
                if (!session) {
                  return;
                }

                for (const turn of session.dialogTurns) {
                  for (const round of turn.modelRounds) {
                    const item = round.items.find(
                      (it: any) =>
                        it.type === 'tool' &&
                        (
                          (source.toolCallId && it.toolCall?.id === source.toolCallId) ||
                          (source.toolItemId && it.id === source.toolItemId)
                        )
                    );

                    if (!item) {
                      continue;
                    }

                    const toolItem = item as any;
                    flowChatStore.updateModelRoundItem(sessionId, turn.id, toolItem.id, {
                      toolCall: {
                        ...toolItem.toolCall,
                        input: {
                          ...toolItem.toolCall?.input,
                          widget_code: nextWidgetCode,
                        },
                      },
                      toolResult: toolItem.toolResult
                        ? {
                            ...toolItem.toolResult,
                            result: updateGenerativeWidgetResultCode(toolItem.toolResult.result, nextWidgetCode),
                          }
                        : toolItem.toolResult,
                    } as any);

                    await flowChatManager.saveDialogTurn(sessionId, turn.id);
                    return;
                  }
                }
              }}
            />
          </React.Suspense>
        );

      case 'openbitfun-canvas':
        return (
          <React.Suspense fallback={<div className="openbitfun-flexible-panel__loading" data-openbitfun-component="flexible-panel" data-openbitfun-part="loading" data-openbitfun-state="loading">Loading Canvas preview...</div>}>
            <OpenBitFunCanvasPanel
              title={content.title}
              artifactReference={content.data?.artifactReference}
              html={content.data?.html}
              source={content.data?.source}
              status={content.data?.status}
              diagnostics={content.data?.diagnostics}
              workspaceId={content.data?.workspaceId}
              workspacePath={content.data?.workspacePath}
              remoteConnectionId={content.data?.remoteConnectionId}
              remoteSshHost={content.data?.remoteSshHost}
            />
          </React.Suspense>
        );

      default:
        return (
          <div className="openbitfun-flexible-panel__unknown-content" data-openbitfun-component="flexible-panel" data-openbitfun-part="unknown">
            <div className="openbitfun-flexible-panel__unknown-icon">
              <AlertCircle size={48} />
            </div>
            <h3>{t('flexiblePanel.unknownContent.title')}</h3>
            <p>{t('flexiblePanel.unknownContent.description')}</p>
            <div className="openbitfun-flexible-panel__unknown-meta">
              <code>{t('flexiblePanel.unknownContent.contentType', { type: content.type })}</code>
            </div>
          </div>
        );
    }
  };

  const showHeader = content && shouldShowHeader(content.type);

  return (
    <div className={`openbitfun-flexible-panel ${className}`} data-openbitfun-component="flexible-panel" data-openbitfun-part="root">
      {showHeader && (
        <div className="openbitfun-flexible-panel__header" data-openbitfun-component="flexible-panel" data-openbitfun-part="header">
          <div className="openbitfun-flexible-panel__header-left" data-openbitfun-component="flexible-panel" data-openbitfun-part="headerMain">
            <div className="openbitfun-flexible-panel__content-icon">
              {getContentIcon(content.type)}
            </div>
            <div className="openbitfun-flexible-panel__content-info">
              <OverflowText className="openbitfun-flexible-panel__content-title">
                {content.title || getContentTypeName(content.type)}
              </OverflowText>
              <OverflowText className="openbitfun-flexible-panel__content-type">
                {getContentTypeName(content.type)}
              </OverflowText>
            </div>
          </div>

          <div className="openbitfun-flexible-panel__header-right" data-openbitfun-component="flexible-panel" data-openbitfun-part="headerActions">
            {content && content.type !== 'empty' && (
              <>
                <Tooltip content={t('flexiblePanel.actions.copyContent')}>
                  <IconButton
                    size="sm"
                    aria-label={t('flexiblePanel.actions.copyContent')}
                    icon={<Icon name="duplicate" size="lg" />}
                    onClick={handleCopy}
                  />
                </Tooltip>

                <Tooltip content={t('flexiblePanel.actions.downloadContent')}>
                  <IconButton
                    size="sm"
                    aria-label={t('flexiblePanel.actions.downloadContent')}
                    icon={<Icon name="arrow-down" size="lg" />}
                    onClick={handleDownload}
                  />
                </Tooltip>
              </>
            )}

            <Tooltip content={t('flexiblePanel.actions.close')}>
              <IconButton
                size="sm"
                tone="danger"
                aria-label={t('flexiblePanel.actions.close')}
                icon={<Icon name="xmark" size="lg" />}
                onClick={handleClose}
              />
            </Tooltip>
          </div>
        </div>
      )}

      <div className="openbitfun-flexible-panel__content" data-openbitfun-component="flexible-panel" data-openbitfun-part="content">
        {renderContent()}
      </div>
    </div>
  );
});

FlexiblePanel.displayName = 'FlexiblePanel';

export default FlexiblePanel;
