/** Monaco diff editor wrapper (side-by-side/inline). */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type * as monaco from 'monaco-editor';
import { monacoInitManager } from '../services/MonacoInitManager';
import { monacoApi } from '../services/monacoRuntime';
import { monacoAppearanceAdapter } from '@/infrastructure/appearance/adapters/MonacoAppearanceAdapter';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { EditorConfig as EditorConfigType } from '@/infrastructure/config/types';
import { getMonacoLanguage } from '@/infrastructure/language-detection';
import { IconButton, OverflowText, LoadingState } from '@openbitfun/ui';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';
import { AlertCircle } from 'lucide-react';
import { activeEditTargetService, createMonacoEditTarget } from '../services/ActiveEditTargetService';
import './DiffEditor.scss';
import { Tooltip } from '@openbitfun/ui';
import {
  DEFAULT_EDITOR_FONT_FAMILY,
  resolveEditorFontFamily,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_LINE_HEIGHT,
} from '../config/defaults';

const log = createLogger('DiffEditor');

export interface DiffEditorProps {
  /** Original content */
  originalContent: string;
  /** Modified content */
  modifiedContent: string;
  /** File path */
  filePath?: string;
  /** Repository path (for Git Diff) */
  repositoryPath?: string;
  /** Programming language */
  language?: string;
  /** Read-only (modified side) */
  readOnly?: boolean;
  /** View mode: side-by-side or inline */
  renderSideBySide?: boolean;
  /** Show minimap */
  showMinimap?: boolean;
  /** CSS class name */
  className?: string;
  /** Modified content change callback */
  onModifiedContentChange?: (content: string) => void;
  /** Diff change callback (triggered when Monaco finishes diff computation) */
  onDiffChange?: (changes: monaco.editor.ILineChange[]) => void;
  /** Accept change callback (for custom UI, not yet implemented) */
  onAcceptChange?: (lineNumber: number) => void;
  /** Reject change callback (for custom UI, not yet implemented) */
  onRejectChange?: (lineNumber: number) => void;
  /** Enable custom toolbar */
  enableCustomToolbar?: boolean;
  /** Save callback (Ctrl+S triggers) */
  onSave?: (content: string) => void;
  /** Reveal line in modified editor (1-based) */
  revealLine?: number;
  /** Show +/- indicators before lines (default true) */
  renderIndicators?: boolean;
}

export const DiffEditor: React.FC<DiffEditorProps> = ({
  originalContent,
  modifiedContent,
  filePath,
  repositoryPath: _repositoryPath,
  language: propLanguage,
  readOnly = false,
  renderSideBySide = true,
  showMinimap = false,
  className = '',
  onModifiedContentChange,
  onDiffChange,
  onAcceptChange: _onAcceptChange,
  onRejectChange: _onRejectChange,
  enableCustomToolbar = false,
  revealLine,
  renderIndicators = true,
  onSave
}) => {
  const notification = useNotification();
  const { t } = useI18n('tools');

  const [diffEditor, setDiffEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<monaco.editor.ILineChange[]>([]);
  const [editorConfig, setEditorConfig] = useState<Partial<EditorConfigType>>({
    font_size: DEFAULT_EDITOR_FONT_SIZE,
    font_family: DEFAULT_EDITOR_FONT_FAMILY,
    line_height: DEFAULT_EDITOR_LINE_HEIGHT,
    tab_size: 2,
    insert_spaces: true,
    word_wrap: 'off',
    line_numbers: 'on',
    minimap: { enabled: showMinimap, side: 'right', size: 'proportional' }
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const changeListenerRef = useRef<monaco.IDisposable | null>(null);
  const contentChangeListenerRef = useRef<monaco.IDisposable | null>(null);
  const isUnmountedRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const originalContentRuntimeRef = useRef(originalContent);
  const modifiedContentRuntimeRef = useRef(modifiedContent);
  const editorConfigRuntimeRef = useRef(editorConfig);
  const renderIndicatorsRuntimeRef = useRef(renderIndicators);
  const onModifiedContentChangeRef = useRef(onModifiedContentChange);
  const onDiffChangeRef = useRef(onDiffChange);
  const notificationRef = useRef(notification);
  const tRef = useRef(t);

  originalContentRuntimeRef.current = originalContent;
  modifiedContentRuntimeRef.current = modifiedContent;
  editorConfigRuntimeRef.current = editorConfig;
  renderIndicatorsRuntimeRef.current = renderIndicators;
  onModifiedContentChangeRef.current = onModifiedContentChange;
  onDiffChangeRef.current = onDiffChange;
  notificationRef.current = notification;
  tRef.current = t;
  
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const detectLanguage = useCallback((filePath?: string): string => {
    if (propLanguage) return propLanguage;
    if (!filePath) return 'plaintext';
    
    const detected = getMonacoLanguage(filePath);
    return detected !== 'plaintext' ? detected : 'plaintext';
  }, [propLanguage]);

  const detectedLanguage = useMemo(() => detectLanguage(filePath), [filePath, detectLanguage]);

  useEffect(() => {
    const loadEditorConfig = async () => {
      try {
        const config = await configManager.getConfig<EditorConfigType>('editor');
        if (config) {
          setEditorConfig(prev => ({
            ...prev,
            ...config,
            minimap: {
              ...config.minimap,
              enabled: showMinimap
            }
          }));
        }
      } catch (error) {
        log.error('Failed to load editor config', error);
      }
    };
    loadEditorConfig();
  }, [showMinimap]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    let editor: monaco.editor.IStandaloneDiffEditor | null = null;
    let originalModel: monaco.editor.ITextModel | null = null;
    let modifiedModel: monaco.editor.ITextModel | null = null;
    let unbindEditTargets: (() => void) | null = null;

    const initDiffEditor = async () => {
      try {
        const monacoRuntime = await monacoInitManager.initialize();

        const timestamp = Date.now();
        const originalUri = monacoApi.Uri.parse(`inmemory://diff-original/${timestamp}/${filePath || 'untitled'}`);
        const modifiedUri = monacoApi.Uri.parse(`inmemory://diff-modified/${timestamp}/${filePath || 'untitled'}`);

        const existingOriginalModel = monacoApi.editor.getModel(originalUri);
        const existingModifiedModel = monacoApi.editor.getModel(modifiedUri);
        
        if (existingOriginalModel) {
          existingOriginalModel.dispose();
        }
        if (existingModifiedModel) {
          existingModifiedModel.dispose();
        }

        const existingOriginal = monacoApi.editor.getModel(originalUri);
        if (existingOriginal) {
          existingOriginal.dispose();
        }

        const existingModified = monacoApi.editor.getModel(modifiedUri);
        if (existingModified) {
          existingModified.dispose();
        }

        originalModel = monacoApi.editor.createModel(originalContentRuntimeRef.current, detectedLanguage, originalUri);
        modifiedModel = monacoApi.editor.createModel(modifiedContentRuntimeRef.current, detectedLanguage, modifiedUri);

        originalModelRef.current = originalModel;
        modifiedModelRef.current = modifiedModel;

        const themeId = monacoAppearanceAdapter.attachMonaco(monacoRuntime);
        
        const editorOptions: monaco.editor.IStandaloneDiffEditorConstructionOptions = {
          renderSideBySide: renderSideBySide,
          renderOverviewRuler: false,
          renderIndicators: renderIndicatorsRuntimeRef.current,
          renderMarginRevertIcon: true,
          renderGutterMenu: true,

          originalEditable: false,
          readOnly: readOnly,
          
          ignoreTrimWhitespace: false,
          renderWhitespace: 'selection',
          diffWordWrap: (editorConfigRuntimeRef.current.word_wrap as any) || 'off',
          diffAlgorithm: 'advanced',
          
          hideUnchangedRegions: {
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 5,
            revealLineCount: 20,
          },
          
          theme: themeId,
          automaticLayout: true,
          fontSize: editorConfigRuntimeRef.current.font_size || DEFAULT_EDITOR_FONT_SIZE,
          fontFamily: resolveEditorFontFamily(editorConfigRuntimeRef.current.font_family),
          lineHeight: editorConfigRuntimeRef.current.line_height 
            ? Math.round((editorConfigRuntimeRef.current.font_size || DEFAULT_EDITOR_FONT_SIZE) * editorConfigRuntimeRef.current.line_height)
            : 0,
          lineNumbers: (editorConfigRuntimeRef.current.line_numbers || 'on') as monaco.editor.LineNumbersType,
          minimap: { 
            enabled: showMinimap,
            side: (editorConfigRuntimeRef.current.minimap?.side || 'right') as 'right' | 'left',
            size: (editorConfigRuntimeRef.current.minimap?.size || 'proportional') as 'proportional' | 'fill' | 'fit'
          },
          scrollBeyondLastLine: false,
          contextmenu: false,
          
          glyphMargin: false,
          folding: false,
          lineNumbersMinChars: 4,
          lineDecorationsWidth: 10,
          padding: { top: 4, bottom: 4 },
          
          renderLineHighlight: 'none',
          overviewRulerBorder: false,
          
          enableSplitViewResizing: true,
        };

        editor = monacoApi.editor.createDiffEditor(container, editorOptions);
        
        editor.setModel({
          original: originalModel,
          modified: modifiedModel
        });

        setDiffEditor(editor);

        const originalEditor = editor.getOriginalEditor();
        const modifiedEditor = editor.getModifiedEditor();
        const u1 = activeEditTargetService.bindTarget(createMonacoEditTarget(originalEditor));
        const u2 = activeEditTargetService.bindTarget(createMonacoEditTarget(modifiedEditor));
        unbindEditTargets = () => {
          u1();
          u2();
        };
        
        // Force set background color immediately to avoid white flash
        requestAnimationFrame(() => {
          if (containerRef.current && !isUnmountedRef.current) {
            const elementsToFix = [
              '.monaco-diff-editor',
              '.editor.original',
              '.editor.modified',
              '.editor.original .monaco-editor',
              '.editor.modified .monaco-editor',
              '.monaco-editor-background',
              '.editor.original .monaco-editor-background',
              '.editor.modified .monaco-editor-background',
              '.margin',
              '.margin-view-overlays',
              '.gutter-background',
              '.editor.original .margin',
              '.editor.modified .margin',
              '.editor.original .margin-view-overlays',
              '.editor.modified .margin-view-overlays',
            ];
            
            elementsToFix.forEach(selector => {
              const elements = container.querySelectorAll(selector);
              elements.forEach((element) => {
                const htmlElement = element as HTMLElement;
                htmlElement.style.backgroundColor = 'var(--openbitfun-color-surface-canvas)';
              });
            });
            
            if (editor) {
              editor.layout();
              
              const originalEditor = editor.getOriginalEditor();
              const modifiedEditor = editor.getModifiedEditor();
              originalEditor.layout();
              modifiedEditor.layout();
            }
          }
        });

        if (!readOnly) {
          contentChangeListenerRef.current = modifiedModel.onDidChangeContent(() => {
            if (!isUnmountedRef.current) {
              const newContent = modifiedModel!.getValue();
              onModifiedContentChangeRef.current?.(newContent);
            }
          });

          modifiedEditor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
            const content = modifiedModel!.getValue();
            onSaveRef.current?.(content);
          });
        }

        const diffUpdateDisposable = editor.onDidUpdateDiff(() => {
          if (isUnmountedRef.current || !editor) return;
          
          const lineChanges = editor.getLineChanges();
          
          if (lineChanges) {
            setChanges(lineChanges);
            onDiffChangeRef.current?.(lineChanges);
          } else {
            setChanges([]);
            onDiffChangeRef.current?.([]);
          }
        });

        changeListenerRef.current = diffUpdateDisposable;

        setLoading(false);

      } catch (err) {
        log.error('Failed to initialize DiffEditor', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(tRef.current('editor.diffEditor.openFailed'));
        setLoading(false);
        notificationRef.current.error(tRef.current('editor.diffEditor.initFailedWithMessage', { message: errorMessage }));
      }
    };

    initDiffEditor();

    return () => {
      isUnmountedRef.current = true;

      if (unbindEditTargets) {
        unbindEditTargets();
        unbindEditTargets = null;
      }

      if (changeListenerRef.current) {
        changeListenerRef.current.dispose();
        changeListenerRef.current = null;
      }
      
      if (contentChangeListenerRef.current) {
        contentChangeListenerRef.current.dispose();
        contentChangeListenerRef.current = null;
      }

      if (editor) {
        editor.dispose();
      }

      if (originalModel) {
        originalModel.dispose();
      }

      if (modifiedModel) {
        modifiedModel.dispose();
      }

      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, [filePath, detectedLanguage, renderSideBySide, readOnly, showMinimap]);

  useEffect(() => {
    if (originalModelRef.current && originalModelRef.current.getValue() !== originalContent) {
      originalModelRef.current.setValue(originalContent);
    }
  }, [originalContent]);

  useEffect(() => {
    if (modifiedModelRef.current && modifiedModelRef.current.getValue() !== modifiedContent) {
      modifiedModelRef.current.setValue(modifiedContent);
    }
  }, [modifiedContent]);

  // Reveal a specific line in the modified editor (1-based)
  useEffect(() => {
    if (!diffEditor || !revealLine || revealLine < 1) return;
    try {
      const modifiedEditor = diffEditor.getModifiedEditor();
      modifiedEditor.revealLineInCenter(revealLine);
      modifiedEditor.setPosition({ lineNumber: revealLine, column: 1 });
    } catch (error) {
      log.warn('Failed to reveal line', error);
    }
  }, [diffEditor, revealLine]);

  const navigateToNextChange = useCallback(() => {
    if (!diffEditor) return;
    
    const modifiedEditor = diffEditor.getModifiedEditor();
    if (modifiedEditor) {
      const action = modifiedEditor.getAction('editor.action.diffReview.next');
      if (action) {
        action.run();
      }
    }
  }, [diffEditor]);

  const navigateToPrevChange = useCallback(() => {
    if (diffEditor) {
      const modifiedEditor = diffEditor.getModifiedEditor();
      if (modifiedEditor) {
        const action = modifiedEditor.getAction('editor.action.diffReview.prev');
        if (action) {
          action.run();
        }
      }
    }
  }, [diffEditor]);

  const toggleViewMode = useCallback(() => {
    if (diffEditor) {
      diffEditor.updateOptions({
        renderSideBySide: !renderSideBySide
      });
    }
  }, [diffEditor, renderSideBySide]);

  const diffStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    
    changes.forEach(change => {
      if (change.modifiedEndLineNumber && change.modifiedStartLineNumber) {
        const modifiedLines = change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
        if (!change.originalEndLineNumber || change.originalStartLineNumber > change.originalEndLineNumber) {
          additions += modifiedLines;
        } else {
          const originalLines = change.originalEndLineNumber - change.originalStartLineNumber + 1;
          if (modifiedLines > originalLines) {
            additions += modifiedLines - originalLines;
          }
        }
      }
      
      if (change.originalEndLineNumber && change.originalStartLineNumber) {
        const originalLines = change.originalEndLineNumber - change.originalStartLineNumber + 1;
        if (!change.modifiedEndLineNumber || change.modifiedStartLineNumber > change.modifiedEndLineNumber) {
          deletions += originalLines;
        } else {
          const modifiedLines = change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
          if (originalLines > modifiedLines) {
            deletions += originalLines - modifiedLines;
          }
        }
      }
    });
    
    return { additions, deletions, total: changes.length };
  }, [changes]);

  useEffect(() => {
    if (!diffEditor || !enableCustomToolbar) return;
    
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F7') {
        e.preventDefault();
        navigateToNextChange();
      }
      if ((e.altKey && e.key === 'ArrowUp') || (e.shiftKey && e.key === 'F7')) {
        e.preventDefault();
        navigateToPrevChange();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [diffEditor, enableCustomToolbar, navigateToNextChange, navigateToPrevChange]);

  const renderToolbar = () => {
    if (!enableCustomToolbar) return null;

    return (
      <div className="diff-editor-toolbar" data-openbitfun-component="diff-editor" data-openbitfun-part="toolbar">
        <div className="diff-editor-toolbar__info" data-openbitfun-component="diff-editor" data-openbitfun-part="toolbarInfo">
          <span className="diff-editor-toolbar__stats">
            {diffStats.additions > 0 && (
              <span className="diff-editor-toolbar__stat diff-editor-toolbar__stat--add">
                +{diffStats.additions}
              </span>
            )}
            {diffStats.deletions > 0 && (
              <span className="diff-editor-toolbar__stat diff-editor-toolbar__stat--del">
                -{diffStats.deletions}
              </span>
            )}
            <span className="diff-editor-toolbar__changes-count">
              {t('editor.diffEditor.changesCount', { count: diffStats.total })}
            </span>
          </span>
          {filePath && (
            <span className="diff-editor-toolbar__file-path">{filePath}</span>
          )}
        </div>
        
        <div className="diff-editor-toolbar__actions" data-openbitfun-component="diff-editor" data-openbitfun-part="toolbarActions">
          <Tooltip content={t('editor.diffEditor.prevChange')} placement="top">
            <IconButton
              className="diff-editor-toolbar__btn"
              onClick={navigateToPrevChange}
              disabled={changes.length === 0}
              aria-label={t('editor.diffEditor.prevChange')}
              icon="↑"
            />
          </Tooltip>
          <Tooltip content={t('editor.diffEditor.nextChange')} placement="top">
            <IconButton
              className="diff-editor-toolbar__btn"
              onClick={navigateToNextChange}
              disabled={changes.length === 0}
              aria-label={t('editor.diffEditor.nextChange')}
              icon="↓"
            />
          </Tooltip>
          <Tooltip
            content={renderSideBySide ? t('editor.diffEditor.switchToInline') : t('editor.diffEditor.switchToSideBySide')}
            placement="top"
          >
            <IconButton
              className="diff-editor-toolbar__btn"
              onClick={toggleViewMode}
              aria-label={renderSideBySide ? t('editor.diffEditor.switchToInline') : t('editor.diffEditor.switchToSideBySide')}
              icon={renderSideBySide ? '⊟' : '⊞'}
            />
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className={`diff-editor-container ${className}`} data-openbitfun-component="diff-editor" data-openbitfun-part="root">
      {renderToolbar()}
      
      <div className="diff-editor-wrapper" data-openbitfun-component="diff-editor" data-openbitfun-part="content">
        <div 
          ref={containerRef} 
          className="diff-editor-content"
          data-shortcut-scope="editor"
          style={{ 
            width: '100%', 
            height: '100%',
            opacity: loading ? 0.3 : 1,
            transition: 'opacity 0.2s'
          }} 
        />
      </div>

      {loading && (
        <div className="diff-editor-loading-overlay" data-openbitfun-component="diff-editor" data-openbitfun-part="loading" data-openbitfun-state="loading">
          <LoadingState size="md">{t('editor.diffEditor.loading')}</LoadingState>
        </div>
      )}

      {error && (
        <div className="diff-editor-error" data-openbitfun-component="diff-editor" data-openbitfun-part="error" data-openbitfun-state="error">
          <AlertCircle size={32} className="diff-editor-error__icon" />
          <p className="diff-editor-error__message">{error}</p>
          {filePath && (
            <p className="diff-editor-error__path"><OverflowText>{filePath}</OverflowText></p>
          )}
        </div>
      )}
    </div>
  );
};

export default DiffEditor;
