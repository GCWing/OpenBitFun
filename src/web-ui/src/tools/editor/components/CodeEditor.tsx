/**
 * Code Editor Component
 * 
 * Monaco Editor-based editable code editor with file editing and saving support.
 * @module components/CodeEditor
 */

import { Button } from '@openbitfun/ui';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import type * as monaco from 'monaco-editor';
import { monacoInitManager } from '../services/MonacoInitManager';
import { getMonacoRuntime, monacoApi } from '../services/monacoRuntime';
import { monacoModelManager } from '../services/MonacoModelManager';
import { useEditorDocument } from '../services/EditorDocument';
import { standaloneEditorFileAccess, type EditorFileAccess } from '../services/editorFileAccess';
import { applyModelIndentation, readModelIndentation, setModelIndentation, type Indentation } from '../services/ModelIndentation';
import { activeEditTargetService, createMonacoEditTarget } from '../services/ActiveEditTargetService';
import { monacoAppearanceAdapter } from '@/infrastructure/appearance/adapters/MonacoAppearanceAdapter';
import { globalEventBus } from '@/infrastructure/event-bus';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { EditorConfig as EditorConfigType } from '@/infrastructure/config/types';
import { LoadingState } from '@openbitfun/ui';
import { getMonacoLanguage } from '@/infrastructure/language-detection';
import { createLogger } from '@/shared/utils/logger';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { isSamePath } from '@/shared/utils/pathUtils';
import { resourcePathKey } from '@/shared/utils/resourcePath';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import {
  isPeerDeviceModeActive,
  PEER_MODE_FILE_SYNC_POLL_MS,
} from '@/infrastructure/peer-device/peerModeFlag';
import {
  diskContentMatchesEditorForExternalSync,
  diskVersionFromMetadata,
  diskVersionsDiffer,
  editorSyncContentSha256Hex,
  type DiskFileVersion,
} from '../utils/diskFileVersion';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import {
  isFileMissingFromMetadata,
  isLikelyFileNotFoundError,
} from '@/shared/utils/fsErrorUtils';
import { useI18n } from '@/infrastructure/i18n';
import { type LineRange } from '@/shared/editor/LineRange';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { EditorStatusBar } from './EditorStatusBar';
import largeFileExpansionLabels from './largeFileExpansionLabels.json';
import {
  DEFAULT_EDITOR_CONFIG,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_FONT_WEIGHT,
  DEFAULT_EDITOR_INLAY_FONT_SIZE,
  DEFAULT_EDITOR_LINE_HEIGHT,
} from '../config/defaults';

const log = createLogger('CodeEditor');
import {
  GoToLinePopover,
  IndentPopover,
  EncodingPopover,
  LanguagePopover,
} from './StatusBarPopovers';
import type { AnchorRect } from './StatusBarPopovers';
import './CodeEditor.scss';

export interface CodeEditorProps {
  /** File path */
  filePath: string;
  /** Optional in-memory content used instead of loading from disk. */
  initialContent?: string;
  /** Show the editor breadcrumb header. */
  showBreadcrumb?: boolean;
  /** Owning workspace ID for editors rendered without an EditorDocument. */
  workspaceId?: string;
  /** Workspace root (IO projection only; never identity). */
  workspacePath?: string;
  /** File name */
  fileName?: string;
  /** Programming language for syntax highlighting */
  language?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Show line numbers */
  showLineNumbers?: boolean;
  /** Show minimap */
  showMinimap?: boolean;
  /** CSS class name */
  className?: string;
  /** Content change callback */
  onContentChange?: (content: string, hasChanges: boolean) => void;
  /** Save callback */
  onSave?: (content: string) => void;
  /** Jump to line number (deprecated, use jumpToRange) */
  jumpToLine?: number;
  /** Jump to column (deprecated, use jumpToRange) */
  jumpToColumn?: number;
  /** Jump to line range (preferred, supports single or multi-line selection) */
  jumpToRange?: LineRange;
  /** Unique token for repeated jump requests to the same location. */
  navigationToken?: number;
  /** When false, disk sync polling is paused (e.g. background editor tab). */
  isActiveTab?: boolean;
  /** File path is not an existing file on disk (drives tab "deleted" label). */
  onFileMissingFromDiskChange?: (missing: boolean) => void;
  /** Persist changes automatically after a short debounce. */
  autoSave?: boolean;
  /** Debounce used when autoSave is enabled. */
  autoSaveDelayMs?: number;
}

const LARGE_FILE_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1MB
const LARGE_FILE_MAX_LINE_LENGTH = 20000;
const LARGE_FILE_RENDER_LINE_LIMIT = 10000;
const LARGE_FILE_MAX_TOKENIZATION_LINE_LENGTH = 2000;
const LARGE_FILE_EXPANSION_LABELS = largeFileExpansionLabels;
const NAVIGATION_RECOVERY_MAX_ATTEMPTS = 6;
const NAVIGATION_RECOVERY_TIMEOUT_MS = 1500;
const NAVIGATION_POST_JUMP_SETTLE_MS = 80;
const NAVIGATION_RETRY_THROTTLE_MS = 40;

/** Poll disk metadata for open file; only while tab is active (see isActiveTab). */
const FILE_SYNC_POLL_INTERVAL_MS = 1000;

interface PendingNavigationRequest {
  key: string;
  range: LineRange;
  targetColumn: number;
  attemptCount: number;
  requestedAtMs: number;
  lastAttemptedAtMs: number;
}

function getPollOffsetMs(filePath: string): number {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) - hash + filePath.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 400;
}

function hasVeryLongLine(content: string, maxLineLength: number): boolean {
  let currentLineLength = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 10 || code === 13) {
      currentLineLength = 0;
      continue;
    }
    currentLineLength++;
    if (currentLineLength >= maxLineLength) {
      return true;
    }
  }
  return false;
}

function isMacOSDesktop(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const isTauri = '__TAURI__' in window;
  return isTauri && typeof navigator.platform === 'string' && navigator.platform.toUpperCase().includes('MAC');
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  filePath: rawFilePath,
  initialContent,
  showBreadcrumb = true,
  workspaceId,
  workspacePath,
  fileName,
  language = 'plaintext',
  readOnly = false,
  showLineNumbers = true,
  showMinimap = true,
  className = '',
  onContentChange,
  onSave,
  jumpToLine,
  jumpToColumn,
  jumpToRange,
  navigationToken,
  isActiveTab = true,
  onFileMissingFromDiskChange,
  autoSave = false,
  autoSaveDelayMs = 800,
}) => {
  const documentSession = useEditorDocument();
  // Decode URL-encoded paths before handing them to the editor.
  const filePath = useMemo(() => {
    if (documentSession) return rawFilePath;
    try {
      if (rawFilePath.includes('%')) {
        return decodeURIComponent(rawFilePath);
      }
    } catch (err) {
      log.warn('Failed to decode path', { rawFilePath, error: err });
    }
    return rawFilePath;
  }, [rawFilePath, documentSession]);
  const modelKey = documentSession?.modelKey ?? filePath;
  const standaloneFiles = useMemo(() => standaloneEditorFileAccess(workspaceId), [workspaceId]);
  const documentFiles: EditorFileAccess = documentSession?.files ?? standaloneFiles;
  const documentInvoke = documentSession?.invoke;

  const { t } = useI18n('tools');
  
  const detectLanguageFromFileName = useCallback((fileName: string): string => {
    const detected = getMonacoLanguage(fileName);
    return detected !== 'plaintext' ? detected : (language || 'plaintext');
  }, [language]);

  const [content, setContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  const loadingOverlayDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOADING_OVERLAY_DELAY_MS = 80;
  useEffect(() => {
    if (loading) {
      const t = setTimeout(() => {
        loadingOverlayDelayRef.current = null;
        setShowLoadingOverlay(true);
      }, LOADING_OVERLAY_DELAY_MS);
      loadingOverlayDelayRef.current = t;
      return () => {
        if (loadingOverlayDelayRef.current) {
          clearTimeout(loadingOverlayDelayRef.current);
          loadingOverlayDelayRef.current = null;
        }
      };
    } else {
      if (loadingOverlayDelayRef.current) {
        clearTimeout(loadingOverlayDelayRef.current);
        loadingOverlayDelayRef.current = null;
      }
      setShowLoadingOverlay(false);
    }
  }, [loading]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState(() => {
    return fileName ? detectLanguageFromFileName(fileName) : language;
  });
  const [monacoReady, setMonacoReady] = useState(false);
  const [editorConfig, setEditorConfig] = useState<Partial<EditorConfigType>>({
    font_size: DEFAULT_EDITOR_FONT_SIZE,
    font_family: DEFAULT_EDITOR_FONT_FAMILY,
    font_weight: DEFAULT_EDITOR_FONT_WEIGHT,
    line_height: DEFAULT_EDITOR_LINE_HEIGHT,
    tab_size: 2,
    insert_spaces: true,
    word_wrap: 'off',
    line_numbers: 'on',
    minimap: { enabled: showMinimap, side: 'right', size: 'proportional' }
  });
  const isMemoryContent = initialContent !== undefined;
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState({ chars: 0, lines: 0 });
  const [statusBarPopover, setStatusBarPopover] = useState<null | 'position' | 'indent' | 'encoding' | 'language'>(null);
  const [statusBarAnchorRect, setStatusBarAnchorRect] = useState<AnchorRect | null>(null);
  const [encoding, setEncoding] = useState<string>('UTF-8');
  const [largeFileMode, setLargeFileMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const isUnmountedRef = useRef(false);
  const isCheckingFileRef = useRef(false);
  /** Last disk state known to match loaded/saved editor content (mtime + size; local + remote). */
  const diskVersionRef = useRef<DiskFileVersion | null>(null);
  const lastReportedMissingRef = useRef<boolean | undefined>(undefined);

  const reportFileMissingFromDisk = useCallback(
    (missing: boolean) => {
      if (!onFileMissingFromDiskChange) {
        return;
      }
      if (lastReportedMissingRef.current === missing) {
        return;
      }
      lastReportedMissingRef.current = missing;
      onFileMissingFromDiskChange(missing);
    },
    [onFileMissingFromDiskChange]
  );
  const contentChangeListenerRef = useRef<monaco.IDisposable | null>(null);
  const ctrlDecorationsRef = useRef<string[]>([]);
  const lastHoverWordRef = useRef<string | null>(null);
  const originalContentRef = useRef<string>('');
  const isLoadingContentRef = useRef(false);
  const savedVersionIdRef = useRef<number>(0);
  const hasChangesRef = useRef<boolean>(false);
  const lastJumpPositionRef = useRef<{ filePath: string; line: number; column: number; endLine?: number } | null>(null);
  const pendingNavigationRef = useRef<PendingNavigationRequest | null>(null);
  const completedNavigationKeyRef = useRef<string | null>(null);
  const navigationSettleTimerRef = useRef<number | null>(null);
  const navigationSettleFrameRef = useRef<number | null>(null);
  const filePathRef = useRef<string>(filePath);
  const saveFileContentRef = useRef<() => Promise<void>>();
  const latestEditorConfigRef = useRef<Partial<EditorConfigType> | null>(null);
  const delayedFontApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userLanguageOverrideRef = useRef(false);
  const [indentation, setIndentation] = useState<Indentation>({
    tabSize: DEFAULT_EDITOR_CONFIG.tabSize,
    insertSpaces: DEFAULT_EDITOR_CONFIG.insertSpaces,
  });
  const largeFileModeRef = useRef(false);
  const largeFileExpansionBlockedLogRef = useRef(false);
  const pendingModelContentRef = useRef<string | null>(null);
  const macosEditorBindingCleanupRef = useRef<(() => void) | null>(null);
  const workspacePathRuntimeRef = useRef(workspacePath);
  const readOnlyRuntimeRef = useRef(readOnly);
  const showLineNumbersRuntimeRef = useRef(showLineNumbers);
  const showMinimapRuntimeRef = useRef(showMinimap);
  const onContentChangeRef = useRef(onContentChange);
  const tRef = useRef(t);
  const contentRef = useRef(content);
  const loadingRef = useRef(loading);
  const editorConfigRuntimeRef = useRef(editorConfig);

  workspacePathRuntimeRef.current = workspacePath;
  readOnlyRuntimeRef.current = readOnly;
  showLineNumbersRuntimeRef.current = showLineNumbers;
  showMinimapRuntimeRef.current = showMinimap;
  onContentChangeRef.current = onContentChange;
  tRef.current = t;
  contentRef.current = content;
  loadingRef.current = loading;
  editorConfigRuntimeRef.current = editorConfig;

  const detectLargeFileMode = useCallback((nextContent: string, fileSizeBytes?: number): boolean => {
    const size = typeof fileSizeBytes === 'number' && fileSizeBytes >= 0
      ? fileSizeBytes
      : new Blob([nextContent]).size;
    if (size >= LARGE_FILE_SIZE_THRESHOLD_BYTES) {
      return true;
    }
    return hasVeryLongLine(nextContent, LARGE_FILE_MAX_LINE_LENGTH);
  }, []);

  const updateLargeFileMode = useCallback((nextContent: string, fileSizeBytes?: number) => {
    const nextMode = detectLargeFileMode(nextContent, fileSizeBytes);
    if (largeFileModeRef.current !== nextMode) {
      largeFileModeRef.current = nextMode;
      setLargeFileMode(nextMode);
      log.info('Editor performance mode changed', {
        filePath,
        largeFileMode: nextMode,
        fileSizeBytes: typeof fileSizeBytes === 'number' ? fileSizeBytes : undefined
      });
    }
  }, [detectLargeFileMode, filePath]);

  const applyExternalContentToModel = useCallback((nextContent: string) => {
    const model = modelRef.current;
    if (!model) {
      pendingModelContentRef.current = nextContent;
      return;
    }

    pendingModelContentRef.current = null;
    if (model.getValue() === nextContent) {
      return;
    }

    const previousLoadingState = isLoadingContentRef.current;
    isLoadingContentRef.current = true;
    model.setValue(nextContent);
    setIndentation(applyModelIndentation(model, latestEditorConfigRef.current ?? {}, true));

    queueMicrotask(() => {
      if (!isUnmountedRef.current) {
        isLoadingContentRef.current = previousLoadingState;
      }
    });
  }, []);

  const applyDiskSnapshotToEditor = useCallback(
    (
      fileContent: string,
      version: DiskFileVersion | null,
      options?: { restoreCursor?: monaco.IPosition | null }
    ) => {
      updateLargeFileMode(fileContent);
      if (isUnmountedRef.current) {
        return;
      }
      isLoadingContentRef.current = true;
      setContent(fileContent);
      originalContentRef.current = fileContent;
      setHasChanges(false);
      hasChangesRef.current = false;
      if (version) {
        diskVersionRef.current = version;
      }
      applyExternalContentToModel(fileContent);
      const pos = options?.restoreCursor;
      if (pos && editorRef.current) {
        editorRef.current.setPosition(pos);
      }
      onContentChange?.(fileContent, false);
      reportFileMissingFromDisk(false);
      queueMicrotask(() => {
        isLoadingContentRef.current = false;
        if (modelRef.current && !isUnmountedRef.current && filePath) {
          savedVersionIdRef.current = modelRef.current.getAlternativeVersionId();
          monacoModelManager.markAsSaved(modelKey);
        }
      });
    },
    [applyExternalContentToModel, filePath, modelKey, onContentChange, reportFileMissingFromDisk, updateLargeFileMode]
  );

  const shouldBlockLargeFileExpansionClick = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (!target.closest('.monaco-editor')) {
      return false;
    }

    const clickable = target.closest('a,button,[role="button"],.monaco-button') as HTMLElement | null;
    const text = (clickable?.textContent ?? target.textContent ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      return false;
    }

    return LARGE_FILE_EXPANSION_LABELS.some((label) => text.includes(label));
  }, []);

  const clearScheduledNavigationSettlement = useCallback(() => {
    if (navigationSettleTimerRef.current !== null) {
      window.clearTimeout(navigationSettleTimerRef.current);
      navigationSettleTimerRef.current = null;
    }
    if (navigationSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationSettleFrameRef.current);
      navigationSettleFrameRef.current = null;
    }
  }, []);

  const getRequestedJumpRange = useCallback((): LineRange | undefined => (
    jumpToRange ||
    (jumpToLine ? { start: jumpToLine, end: jumpToColumn ? jumpToLine : undefined } : undefined)
  ), [jumpToColumn, jumpToLine, jumpToRange]);

  const buildNavigationRequestKey = useCallback((range: LineRange): string => (
    [
      filePath,
      navigationToken ?? 'static',
      range.start,
      range.end ?? range.start,
    ].join(':')
  ), [filePath, navigationToken]);

  const isEditorViewportReady = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null): boolean => {
    if (!editor) {
      return false;
    }

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (containerRect && (containerRect.width < 2 || containerRect.height < 2)) {
      return false;
    }

    const domNode = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
    if (domNode instanceof HTMLElement) {
      const domRect = domNode.getBoundingClientRect();
      if (domRect.width < 2 || domRect.height < 2) {
        return false;
      }
    }

    const layoutInfo = typeof editor.getLayoutInfo === 'function' ? editor.getLayoutInfo() : null;
    if (layoutInfo && (layoutInfo.width < 2 || layoutInfo.height < 2)) {
      return false;
    }

    return true;
  }, []);

  useEffect(() => {
    filePathRef.current = filePath;
    pendingModelContentRef.current = null;
    lastJumpPositionRef.current = null;
    pendingNavigationRef.current = null;
    completedNavigationKeyRef.current = null;
    clearScheduledNavigationSettlement();
  }, [clearScheduledNavigationSettlement, filePath]);

  useEffect(() => {
    if (!statusBarPopover) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.status-bar-popover') || target.closest('.editor-status-bar')) return;
      setStatusBarPopover(null);
      setStatusBarAnchorRect(null);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [statusBarPopover]);

  // Sync font/config to editor when editorConfig changes (fixes late getConfig when opening from file tree)
  useEffect(() => {
    if (!monacoReady || !editorRef.current) return;
    const fs = editorConfig.font_size ?? DEFAULT_EDITOR_FONT_SIZE;
    editorRef.current.updateOptions({
      fontSize: fs,
      fontFamily: editorConfig.font_family || DEFAULT_EDITOR_FONT_FAMILY,
      fontWeight: editorConfig.font_weight || DEFAULT_EDITOR_FONT_WEIGHT,
      lineHeight: editorConfig.line_height ? Math.round(fs * editorConfig.line_height) : 0,
    });
  }, [monacoReady, editorConfig.font_size, editorConfig.font_family, editorConfig.font_weight, editorConfig.line_height]);

  useEffect(() => {
    const applyConfig = (config: Partial<EditorConfigType>) => {
      const appliedFontSize = config.font_size ?? DEFAULT_EDITOR_FONT_SIZE;
      const newConfig: Partial<EditorConfigType> = {
        ...config,
        minimap: {
          enabled: showMinimap,
          side: config.minimap?.side || 'right',
          size: config.minimap?.size || 'proportional'
        }
      };
      
      setEditorConfig(newConfig);
      latestEditorConfigRef.current = config;

      if (modelRef.current) {
        setIndentation(applyModelIndentation(modelRef.current, config));
      }
      if (editorRef.current) {
        editorRef.current.updateOptions({
          fontSize: appliedFontSize,
          fontFamily: config.font_family || DEFAULT_EDITOR_FONT_FAMILY,
          fontWeight: config.font_weight || DEFAULT_EDITOR_FONT_WEIGHT,
          lineHeight: config.line_height 
            ? Math.round(appliedFontSize * config.line_height)
            : 0,
          wordWrap: (config.word_wrap as any) || 'off',
          lineNumbers: config.line_numbers as any || 'on',
          minimap: { 
            enabled: showMinimap && !largeFileMode,
            side: (config.minimap?.side as any) || 'right',
            size: (config.minimap?.size as any) || 'proportional'
          },
          cursorStyle: config.cursor_style as any || 'line',
          cursorBlinking: config.cursor_blinking as any || 'blink',
          smoothScrolling: largeFileMode ? false : (config.smooth_scrolling ?? true),
          renderWhitespace: config.render_whitespace as any || 'none',
          renderLineHighlight: config.render_line_highlight as any || 'line',
          bracketPairColorization: { enabled: largeFileMode ? false : (config.bracket_pair_colorization ?? true) },
          formatOnPaste: config.format_on_paste ?? false,
          trimAutoWhitespace: config.trim_auto_whitespace ?? true,
          inlayHints: { enabled: largeFileMode ? 'off' : 'on' },
          quickSuggestions: largeFileMode
            ? { other: false, comments: false, strings: false }
            : { other: true, comments: false, strings: false },
          'semanticHighlighting.enabled': !largeFileMode,
          renderValidationDecorations: largeFileMode ? 'off' : 'on',
          largeFileOptimizations: true,
          maxTokenizationLineLength: largeFileMode ? LARGE_FILE_MAX_TOKENIZATION_LINE_LENGTH : LARGE_FILE_MAX_LINE_LENGTH,
          occurrencesHighlight: largeFileMode ? 'off' : 'singleFile',
          selectionHighlight: !largeFileMode,
          matchBrackets: largeFileMode ? 'never' : 'always',
          disableMonospaceOptimizations: !largeFileMode,
          stopRenderingLineAfter: largeFileMode ? LARGE_FILE_RENDER_LINE_LIMIT : -1,
        });
      }
    };

    let cancelled = false;
    let revision = 0;
    const loadEditorConfig = async () => {
      const requestRevision = ++revision;
      try {
        const config = await configManager.getConfig<EditorConfigType>('editor');
        if (config && !cancelled && requestRevision === revision) {
          applyConfig(config);
        }
      } catch (error) {
        log.error('Failed to load editor config', error);
      }
    };
    
    loadEditorConfig();
    
    const handleConfigChange = (newConfig: unknown) => {
      if (newConfig && typeof newConfig === 'object') {
        revision += 1;
        applyConfig(newConfig as Partial<EditorConfigType>);
      }
    };
    
    globalEventBus.on('editor:config:changed', handleConfigChange);
    const unwatch = configManager.watch('editor', () => { void loadEditorConfig(); });
    
    return () => {
      cancelled = true;
      unwatch();
      globalEventBus.off('editor:config:changed', handleConfigChange);
    };
  }, [showMinimap, largeFileMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !largeFileMode) {
      return;
    }

    const blockLargeFileExpansion = (event: MouseEvent) => {
      if (!shouldBlockLargeFileExpansionClick(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (!largeFileExpansionBlockedLogRef.current) {
        largeFileExpansionBlockedLogRef.current = true;
        log.info('Blocked long-line expansion in large file mode', { filePath });
      }
    };

    container.addEventListener('mousedown', blockLargeFileExpansion, true);
    container.addEventListener('click', blockLargeFileExpansion, true);
    return () => {
      container.removeEventListener('mousedown', blockLargeFileExpansion, true);
      container.removeEventListener('click', blockLargeFileExpansion, true);
    };
  }, [filePath, largeFileMode, shouldBlockLargeFileExpansionClick]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;
    let indentationListener: monaco.IDisposable | undefined;
    let cancelled = false;
    isUnmountedRef.current = false;
    setMonacoReady(false);

    const initEditor = async () => {
      try {
        if (!containerRef.current) {
          log.error('Container ref is null');
          return;
        }
        
        let createFontSize = DEFAULT_EDITOR_FONT_SIZE;
        let createFontFamily = editorConfigRuntimeRef.current.font_family || DEFAULT_EDITOR_FONT_FAMILY;
        let createFontWeight = editorConfigRuntimeRef.current.font_weight || DEFAULT_EDITOR_FONT_WEIGHT;
        let createLineHeight = 0;
        const applyFontConfig = (c: Partial<EditorConfigType>) => {
          createFontSize = c.font_size ?? DEFAULT_EDITOR_FONT_SIZE;
          createFontFamily = c.font_family || createFontFamily;
          createFontWeight = c.font_weight || createFontWeight;
          createLineHeight = c.line_height ? Math.round(createFontSize * c.line_height) : 0;
        };
        try {
          const configBeforeLoad = latestEditorConfigRef.current;
          const preloadConfig = await configManager.getConfig<EditorConfigType>('editor');
          if (preloadConfig) {
            applyFontConfig(preloadConfig);
            if (latestEditorConfigRef.current === configBeforeLoad) latestEditorConfigRef.current = preloadConfig;
          }
          else if (latestEditorConfigRef.current) applyFontConfig(latestEditorConfigRef.current);
        } catch (_) {}
        
        const monacoRuntime = await monacoInitManager.initialize();
        if (cancelled) return;

        model = monacoModelManager.getOrCreateModel(
          filePath,
          detectedLanguage,
          documentSession?.snapshot?.content ?? contentRef.current ?? '',
          workspacePathRuntimeRef.current,
          modelKey
        );
        
        modelRef.current = model;
        setIndentation(applyModelIndentation(model, latestEditorConfigRef.current ?? editorConfigRuntimeRef.current));
        indentationListener = model.onDidChangeOptions(() => {
          setIndentation(readModelIndentation(model!));
        });
        const modelContent = model.getValue();
        const initialLargeFileMode = detectLargeFileMode(modelContent);
        largeFileModeRef.current = initialLargeFileMode;
        setLargeFileMode(initialLargeFileMode);
        
        if (documentSession?.snapshot) monacoModelManager.markAsSaved(modelKey, documentSession.snapshot.savedContent);
        const modelMetadata = monacoModelManager.getModelMetadata(modelKey);
        if (modelMetadata) {
          const isDirty = modelMetadata.isDirty;
          
          setHasChanges(isDirty);
          hasChangesRef.current = isDirty;
          savedVersionIdRef.current = modelMetadata.savedVersionId;
          originalContentRef.current = modelMetadata.originalContent;
          
          if (isDirty && onContentChangeRef.current) {
            onContentChangeRef.current(modelContent, true);
          }
        } else {
          savedVersionIdRef.current = model.getAlternativeVersionId();
        }
        
        if (modelContent && modelContent !== contentRef.current) {
          setContent(modelContent);
          if (!modelMetadata) {
            originalContentRef.current = modelContent;
          }
        }

        const themeId = monacoAppearanceAdapter.attachMonaco(monacoRuntime);
        
        const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
          model: model,
          theme: themeId,
          automaticLayout: true,
          readOnly: readOnlyRuntimeRef.current,
          lineNumbers: showLineNumbersRuntimeRef.current ? 'on' : (editorConfigRuntimeRef.current.line_numbers as any) || 'on',
          minimap: { 
            enabled: showMinimapRuntimeRef.current && !initialLargeFileMode,
            side: (editorConfigRuntimeRef.current.minimap?.side as any) || 'right',
            size: (editorConfigRuntimeRef.current.minimap?.size as any) || 'proportional'
          },
          fontSize: createFontSize,
          fontFamily: createFontFamily,
          fontWeight: createFontWeight,
          lineHeight: createLineHeight || (editorConfigRuntimeRef.current.line_height ? Math.round(createFontSize * editorConfigRuntimeRef.current.line_height) : 0),
          scrollBeyondLastLine: false,
          wordWrap: (editorConfigRuntimeRef.current.word_wrap as any) || 'off',
          contextmenu: false,
          links: true,
          gotoLocation: {
            multipleDefinitions: 'goto',
            multipleTypeDefinitions: 'goto',
            multipleDeclarations: 'goto',
            multipleImplementations: 'goto',
            multipleReferences: 'goto'
          },
          multiCursorModifier: 'alt',
          definitionLinkOpensInPeek: false,
          inlayHints: {
            enabled: initialLargeFileMode ? 'off' : 'on',
            fontSize: DEFAULT_EDITOR_INLAY_FONT_SIZE,
            fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
            padding: false
          },

          hover: {
            enabled: !initialLargeFileMode,
            delay: 100,
            sticky: true,
            above: false
          },

          quickSuggestions: {
            other: !initialLargeFileMode,
            comments: false,
            strings: false
          },
          suggest: {
            showKeywords: true,
            showSnippets: true
          },
          
          'semanticHighlighting.enabled': !initialLargeFileMode,
          guides: {
            indentation: true,
            bracketPairs: true,
            bracketPairsHorizontal: 'active',
            highlightActiveBracketPair: true,
            highlightActiveIndentation: true
          },

          renderLineHighlight: 'line',
          renderControlCharacters: false,
          renderValidationDecorations: initialLargeFileMode ? 'off' : 'on',
          largeFileOptimizations: true,
          maxTokenizationLineLength: initialLargeFileMode ? LARGE_FILE_MAX_TOKENIZATION_LINE_LENGTH : LARGE_FILE_MAX_LINE_LENGTH,
          occurrencesHighlight: initialLargeFileMode ? 'off' : 'singleFile',
          selectionHighlight: !initialLargeFileMode,
          matchBrackets: initialLargeFileMode ? 'never' : 'always',
          smoothScrolling: !initialLargeFileMode,
          roundedSelection: false,
          disableMonospaceOptimizations: !initialLargeFileMode,
          fontLigatures: false,
          stopRenderingLineAfter: initialLargeFileMode ? LARGE_FILE_RENDER_LINE_LIMIT : -1,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            useShadows: false,
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10
          }
        };

        editor = monacoApi.editor.create(container, editorOptions);
        editorRef.current = editor;
        if (documentSession?.viewState) editor.restoreViewState(documentSession.viewState as monaco.editor.ICodeEditorViewState);
        const editTarget = createMonacoEditTarget(editor);
        const unbindEditTarget = activeEditTargetService.bindTarget(editTarget);
        const focusDisposable = editor.onDidFocusEditorText(() => {
          activeEditTargetService.setActiveTarget(editTarget.id);
        });
        const blurDisposable = editor.onDidBlurEditorText(() => {
          window.setTimeout(() => {
            if (editor?.hasTextFocus()) {
              return;
            }

            activeEditTargetService.clearActiveTarget(editTarget.id);
          }, 0);
        });
        macosEditorBindingCleanupRef.current = () => {
          focusDisposable.dispose();
          blurDisposable.dispose();
          unbindEditTarget();
        };
        // #endregion
        
        (container as any).__monacoEditor = editor;
        
        setMonacoReady(true);
        const applyOptionsFromConfig = (c: Partial<EditorConfigType>) => {
          if (cancelled) return;
          const fs = c.font_size ?? DEFAULT_EDITOR_FONT_SIZE;
          editor!.updateOptions({
            fontSize: fs,
            fontFamily: c.font_family || DEFAULT_EDITOR_FONT_FAMILY,
            fontWeight: c.font_weight || DEFAULT_EDITOR_FONT_WEIGHT,
            lineHeight: c.line_height ? Math.round(fs * c.line_height) : 0,
          });
        };
        try {
          const latestConfig = await configManager.getConfig<EditorConfigType>('editor');
          if (latestConfig) applyOptionsFromConfig(latestConfig);
          else if (latestEditorConfigRef.current) applyOptionsFromConfig(latestEditorConfigRef.current);
        } catch (_) {}
        if (cancelled) return;
        // Delayed font apply: config may not be ready when opening from file tree
        if (delayedFontApplyTimerRef.current) clearTimeout(delayedFontApplyTimerRef.current);
        delayedFontApplyTimerRef.current = setTimeout(() => {
          delayedFontApplyTimerRef.current = null;
          if (isUnmountedRef.current || !editorRef.current) return;
          (async () => {
            try {
              const cfg = await configManager.getConfig<EditorConfigType>('editor') || latestEditorConfigRef.current;
              if (cfg && editorRef.current) {
                applyOptionsFromConfig(cfg);
              }
            } catch (_) {}
          })();
        }, 150);

        // Intercept cross-file jumps from Peek References
        const originalModel = model;
        editor.onDidChangeModel((e) => {
          if (e.newModelUrl && e.oldModelUrl && e.newModelUrl.toString() !== e.oldModelUrl.toString()) {
            const newUri = e.newModelUrl.toString();
            let targetLine = 1;
            let targetColumn = 1;
            
            if (editor) {
              const cursorPosition = editor.getPosition();
              if (cursorPosition) {
                targetLine = cursorPosition.lineNumber;
                targetColumn = cursorPosition.column;
              }
            }
            
            if (originalModel && !originalModel.isDisposed() && editor) {
              editor.setModel(originalModel);
            }
            
            (async () => {
              try {
                const { normalizePath } = await import('@/shared/utils/pathUtils');
                const normalizedPath = normalizePath(newUri);
                
                const { fileTabManager } = await import('@/shared/services/FileTabManager');
                fileTabManager.openFileAndJump(
                  normalizedPath,
                  targetLine,
                  targetColumn,
                  { workspacePath: workspacePathRuntimeRef.current, scope: documentSession?.scope }
                );
              } catch (error) {
                log.error('Cross-file jump failed', error);
              }
            })();
          }
        });

        contentChangeListenerRef.current = model.onDidChangeContent(() => {
          if (isLoadingContentRef.current) {
            return;
          }
          
          const newContent = model!.getValue();
          documentSession?.capture(newContent, newContent !== originalContentRef.current, originalContentRef.current);
          setContent(newContent);
          
          const currentVersionId = model!.getAlternativeVersionId();
          const changed = documentSession ? newContent !== originalContentRef.current : currentVersionId !== savedVersionIdRef.current;
          
          setHasChanges(changed);
          hasChangesRef.current = changed;
          
          onContentChangeRef.current?.(newContent, changed);
        });

        editor.onDidChangeCursorPosition((e) => {
          setCursorPosition({
            line: e.position.lineNumber,
            column: e.position.column
          });
        });

        editor.onDidChangeCursorSelection((e) => {
          const sel = e.selection;
          if (sel.isEmpty()) {
            setSelection({ chars: 0, lines: 0 });
          } else {
            const selectedText = model!.getValueInRange(sel);
            const lines = sel.endLineNumber - sel.startLineNumber + 1;
            setSelection({
              chars: selectedText.length,
              lines: lines > 1 ? lines : 0
            });
          }
        });

        const updateCursorPosition = (e: monaco.editor.IEditorMouseEvent) => {
          if (e.target.position && container.parentElement?.parentElement) {
            // containerRef -> .code-editor-tool__content -> .code-editor-tool (has data-monaco-editor)
            const editorContainer = container.parentElement.parentElement;
            const newLine = String(e.target.position.lineNumber);
            const newColumn = String(e.target.position.column);
            
            if (editorContainer.getAttribute('data-cursor-line') !== newLine || 
                editorContainer.getAttribute('data-cursor-column') !== newColumn) {
              editorContainer.setAttribute('data-cursor-line', newLine);
              editorContainer.setAttribute('data-cursor-column', newColumn);
            }
          }
        };

        editor.onMouseDown((e) => {
          updateCursorPosition(e);

          if ((e.event.ctrlKey || e.event.metaKey) && e.event.leftButton && e.target.position) {
            e.event.preventDefault();
            e.event.stopPropagation();
            editor!.setPosition(e.target.position);
            
            globalEventBus.emit('editor:goto-definition', {
              filePath: filePath,
              line: e.target.position.lineNumber,
              column: e.target.position.column
            });
          }
        });

        editor.onMouseMove((e) => {
          updateCursorPosition(e);

          if (!(e.event.ctrlKey || e.event.metaKey)) {
            if (ctrlDecorationsRef.current.length > 0) {
              try {
                ctrlDecorationsRef.current = editor!.deltaDecorations(ctrlDecorationsRef.current, []);
              } catch (_err) {
                ctrlDecorationsRef.current = [];
              }
              lastHoverWordRef.current = null;
            }
            return;
          }
          
          if (e.target.position) {
            const word = model!.getWordAtPosition(e.target.position);
            if (word && word.word !== lastHoverWordRef.current) {
              lastHoverWordRef.current = word.word;
              const range = new monacoApi.Range(
                e.target.position.lineNumber,
                word.startColumn,
                e.target.position.lineNumber,
                word.endColumn
              );
              ctrlDecorationsRef.current = editor!.deltaDecorations(ctrlDecorationsRef.current, [{
                range,
                options: {
                  inlineClassName: 'ctrl-click-underline'
                }
              }]);
            }
          }
        });

        setMonacoReady(true);
        
      } catch (error) {
        log.error('Failed to initialize editor', error);
        setError(tRef.current('editor.codeEditor.initFailedWithMessage', { message: String(error) }));
      }
    };

    initEditor();

    return () => {
      cancelled = true;
      isUnmountedRef.current = true;
      indentationListener?.dispose();
      if (modelRef.current === model) modelRef.current = null;
      clearScheduledNavigationSettlement();
      pendingNavigationRef.current = null;
      completedNavigationKeyRef.current = null;
      if (macosEditorBindingCleanupRef.current) {
        macosEditorBindingCleanupRef.current();
        macosEditorBindingCleanupRef.current = null;
      }
      if (delayedFontApplyTimerRef.current) {
        clearTimeout(delayedFontApplyTimerRef.current);
        delayedFontApplyTimerRef.current = null;
      }
      if (contentChangeListenerRef.current) {
        contentChangeListenerRef.current.dispose();
        contentChangeListenerRef.current = null;
      }
      
      if (editorRef.current) {
        if (documentSession) documentSession.viewState = editorRef.current.saveViewState();
        editorRef.current.dispose();
        editorRef.current = null;
      }

      if (container) {
        delete (container as any).__monacoEditor;
      }

      monacoModelManager.releaseModel(modelKey);

    };
  }, [clearScheduledNavigationSettlement, detectedLanguage, detectLargeFileMode, documentSession, filePath, modelKey]);

  useEffect(() => {
    if (monacoReady && pendingModelContentRef.current !== null) {
      applyExternalContentToModel(pendingModelContentRef.current);
    }
  }, [monacoReady, applyExternalContentToModel]);

  useEffect(() => {
    if (modelRef.current && monacoReady) {
      const currentLanguage = modelRef.current.getLanguageId();
      if (detectedLanguage !== currentLanguage) {
        monacoApi.editor.setModelLanguage(modelRef.current, detectedLanguage);
      }
    }
  }, [detectedLanguage, monacoReady]);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ readOnly });
    }
  }, [readOnly]);

  const performJump = useCallback((editor: any, model: any, line: number, column: number, endLine?: number) => {
    const lineCount = model.getLineCount();
    const targetLine = Math.min(line, Math.max(1, lineCount));
    const targetEndLine = endLine ? Math.min(endLine, Math.max(1, lineCount)) : undefined;
    const maxColumnForLine = model.getLineMaxColumn(targetLine);
    const targetColumn = Math.min(Math.max(1, column), maxColumnForLine);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          editor.setPosition({
            lineNumber: targetLine,
            column: targetColumn
          });

          if (targetEndLine && targetEndLine > targetLine) {
            const endLineMaxColumn = model.getLineMaxColumn(targetEndLine);
            editor.setSelection({
              startLineNumber: targetLine,
              startColumn: 1,
              endLineNumber: targetEndLine,
              endColumn: endLineMaxColumn
            });
            editor.revealRangeInCenter({
              startLineNumber: targetLine,
              startColumn: 1,
              endLineNumber: targetEndLine,
              endColumn: endLineMaxColumn
            });
          } else {
            editor.revealLineInCenter(targetLine);
            editor.setSelection({
              startLineNumber: targetLine,
              startColumn: targetColumn,
              endLineNumber: targetLine,
              endColumn: targetColumn
            });
          }

          editor.focus();
        } catch (error) {
          log.error('Jump execution failed', error);
        }
      });
    });
  }, []);

  const isJumpStillApplied = useCallback((
    editor: any,
    model: any,
    line: number,
    column: number,
    endLine?: number
  ): boolean => {
    const lineCount = model.getLineCount();
    const targetLine = Math.min(line, Math.max(1, lineCount));
    const targetEndLine = endLine ? Math.min(endLine, Math.max(1, lineCount)) : undefined;
    const maxColumnForLine = model.getLineMaxColumn(targetLine);
    const targetColumn = Math.min(Math.max(1, column), maxColumnForLine);
    const requiredEndLine = targetEndLine ?? targetLine;
    const visibleRanges = typeof editor.getVisibleRanges === 'function'
      ? editor.getVisibleRanges()
      : [];
    const isTargetVisible = visibleRanges.some((range: monaco.Range) =>
      range.startLineNumber <= targetLine && range.endLineNumber >= requiredEndLine
    );

    if (!isTargetVisible) {
      return false;
    }

    const selection = typeof editor.getSelection === 'function' ? editor.getSelection() : null;

    if (targetEndLine && targetEndLine > targetLine) {
      if (!selection) {
        return false;
      }

      const endLineMaxColumn = model.getLineMaxColumn(targetEndLine);
      return (
        selection.startLineNumber === targetLine &&
        selection.startColumn === 1 &&
        selection.endLineNumber === targetEndLine &&
        selection.endColumn === endLineMaxColumn
      );
    }

    const position = typeof editor.getPosition === 'function' ? editor.getPosition() : null;
    if (!position || !selection) {
      return false;
    }

    return (
      position.lineNumber === targetLine &&
      position.column === targetColumn &&
      selection.startLineNumber === targetLine &&
      selection.startColumn === targetColumn &&
      selection.endLineNumber === targetLine &&
      selection.endColumn === targetColumn
    );
  }, []);

  const reconcilePendingNavigation = useCallback(() => {
    const pending = pendingNavigationRef.current;
    if (!pending || completedNavigationKeyRef.current === pending.key) {
      return;
    }

    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !monacoReady || loading || !isActiveTab) {
      return;
    }

    if (!isEditorViewportReady(editor)) {
      return;
    }

    if (isJumpStillApplied(editor, model, pending.range.start, pending.targetColumn, pending.range.end)) {
      completedNavigationKeyRef.current = pending.key;
      pendingNavigationRef.current = null;
      clearScheduledNavigationSettlement();
      return;
    }

    const maxLineNeeded = Math.max(pending.range.start, pending.range.end ?? pending.range.start);
    const lineCount = model.getLineCount();
    if (lineCount < maxLineNeeded) {
      return;
    }

    const attemptAgeMs = nowMs() - pending.requestedAtMs;
    if (
      pending.attemptCount >= NAVIGATION_RECOVERY_MAX_ATTEMPTS ||
      attemptAgeMs > NAVIGATION_RECOVERY_TIMEOUT_MS
    ) {
      return;
    }

    const currentTime = nowMs();
    if (currentTime - pending.lastAttemptedAtMs < NAVIGATION_RETRY_THROTTLE_MS) {
      return;
    }

    pending.attemptCount += 1;
    pending.lastAttemptedAtMs = currentTime;
    lastJumpPositionRef.current = {
      filePath,
      line: pending.range.start,
      column: pending.targetColumn,
      endLine: pending.range.end,
    };
    performJump(editor, model, pending.range.start, pending.targetColumn, pending.range.end);

    clearScheduledNavigationSettlement();
    navigationSettleTimerRef.current = window.setTimeout(() => {
      navigationSettleTimerRef.current = null;
      if (isUnmountedRef.current) {
        return;
      }
      navigationSettleFrameRef.current = window.requestAnimationFrame(() => {
        navigationSettleFrameRef.current = null;
        reconcilePendingNavigation();
      });
    }, NAVIGATION_POST_JUMP_SETTLE_MS);
  }, [
    clearScheduledNavigationSettlement,
    filePath,
    isActiveTab,
    isEditorViewportReady,
    isJumpStillApplied,
    loading,
    monacoReady,
    performJump,
  ]);

  useEffect(() => {
    const requestedRange = getRequestedJumpRange();
    if (!requestedRange) {
      pendingNavigationRef.current = null;
      completedNavigationKeyRef.current = null;
      clearScheduledNavigationSettlement();
      return;
    }

    const requestKey = buildNavigationRequestKey(requestedRange);
    if (
      pendingNavigationRef.current?.key === requestKey ||
      completedNavigationKeyRef.current === requestKey
    ) {
      return;
    }

    pendingNavigationRef.current = {
      key: requestKey,
      range: requestedRange,
      targetColumn: 1,
      attemptCount: 0,
      requestedAtMs: nowMs(),
      lastAttemptedAtMs: 0,
    };
    completedNavigationKeyRef.current = null;
    clearScheduledNavigationSettlement();
  }, [
    buildNavigationRequestKey,
    clearScheduledNavigationSettlement,
    getRequestedJumpRange,
  ]);

  useEffect(() => {
    if (!pendingNavigationRef.current) {
      return;
    }
    reconcilePendingNavigation();
  }, [
    content,
    filePath,
    isActiveTab,
    loading,
    monacoReady,
    navigationToken,
    reconcilePendingNavigation,
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !pendingNavigationRef.current) {
      return;
    }

    const scheduleReconcile = () => {
      if (navigationSettleFrameRef.current !== null) {
        window.cancelAnimationFrame(navigationSettleFrameRef.current);
      }
      navigationSettleFrameRef.current = window.requestAnimationFrame(() => {
        navigationSettleFrameRef.current = null;
        reconcilePendingNavigation();
      });
    };

    const layoutDisposable = editor.onDidLayoutChange(() => {
      scheduleReconcile();
    });
    const modelDisposable = modelRef.current?.onDidChangeContent(() => {
      scheduleReconcile();
    }) ?? null;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleReconcile();
      });
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
      const domNode = editor.getDomNode();
      if (domNode instanceof HTMLElement) {
        resizeObserver.observe(domNode);
      }
    }

    return () => {
      layoutDisposable.dispose();
      modelDisposable?.dispose();
      resizeObserver?.disconnect();
      if (navigationSettleFrameRef.current !== null) {
        window.cancelAnimationFrame(navigationSettleFrameRef.current);
        navigationSettleFrameRef.current = null;
      }
    };
  }, [filePath, isActiveTab, monacoReady, navigationToken, reconcilePendingNavigation]);

  // Status bar popover: open and confirm
  const openStatusBarPopover = useCallback((type: 'position' | 'indent' | 'encoding' | 'language', e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setStatusBarAnchorRect({
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
    setStatusBarPopover(type);
  }, []);

  const closeStatusBarPopover = useCallback(() => {
    setStatusBarPopover(null);
    setStatusBarAnchorRect(null);
  }, []);

  const handleGoToLineConfirm = useCallback((line: number, column: number) => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (editor && model) performJump(editor, model, line, column);
  }, [performJump]);

  const handleIndentConfirm = useCallback((tabSize: number, insertSpaces: boolean) => {
    const model = modelRef.current;
    if (model) {
      setModelIndentation(model, { tabSize, insertSpaces });
      setIndentation(readModelIndentation(model));
      editorRef.current?.focus();
    }
  }, []);

  const fetchFileMetadata = useCallback(async () => {
    if (isMemoryContent) return null;
    const workspaceAPI = documentFiles;
    return workspaceAPI.getFileMetadata(filePath);
  }, [documentFiles, filePath, isMemoryContent]);

  const handleEncodingConfirm = useCallback(async (newEncoding: string) => {
    if (isMemoryContent) return;
    setEncoding(newEncoding);
    if (!filePath) return;
    try {
      const workspaceAPI = documentFiles;
      const content = await workspaceAPI.readFileContent(filePath, newEncoding);
      updateLargeFileMode(content);
      setContent(content);
      originalContentRef.current = content;
      setHasChanges(false);
      hasChangesRef.current = false;
      applyExternalContentToModel(content);
      try {
        const fileInfo = await fetchFileMetadata();
        if (isFileMissingFromMetadata(fileInfo)) {
          reportFileMissingFromDisk(true);
        } else {
          reportFileMissingFromDisk(false);
          const v = diskVersionFromMetadata(fileInfo);
          if (v) {
            diskVersionRef.current = v;
          }
        }
      } catch (err) {
        if (isLikelyFileNotFoundError(err)) {
          reportFileMissingFromDisk(true);
        }
        log.warn('Failed to sync disk version after encoding change', err);
      }
      queueMicrotask(() => {
        if (modelRef.current && !isUnmountedRef.current) {
          savedVersionIdRef.current = modelRef.current.getAlternativeVersionId();
          monacoModelManager.markAsSaved(modelKey);
        }
      });
    } catch (err) {
      if (isLikelyFileNotFoundError(err)) {
        reportFileMissingFromDisk(true);
      }
      log.warn('Failed to reload file with new encoding', err);
    }
  }, [applyExternalContentToModel, documentFiles, fetchFileMetadata, filePath, isMemoryContent, modelKey, reportFileMissingFromDisk, updateLargeFileMode]);

  const handleLanguageConfirm = useCallback((languageId: string) => {
    userLanguageOverrideRef.current = true;
    setDetectedLanguage(languageId);
    if (modelRef.current && monacoReady) {
      monacoApi.editor.setModelLanguage(modelRef.current, languageId);
    }
  }, [monacoReady]);

  // Load file content
  const loadFileContent = useCallback(async () => {
    if (!filePath) {
      setLoading(false);
      return;
    }

    if (documentSession?.snapshot) {
      const snapshot = documentSession.snapshot;
      setError(null);
      setContent(snapshot.content);
      originalContentRef.current = snapshot.savedContent;
      setHasChanges(snapshot.isDirty);
      hasChangesRef.current = snapshot.isDirty;
      applyExternalContentToModel(snapshot.content);
      setLoading(false);
      isLoadingContentRef.current = false;
      onContentChangeRef.current?.(snapshot.content, snapshot.isDirty);
      return;
    }

    if (isMemoryContent) {
      const fileContent = initialContent ?? '';
      setLoading(true);
      setError(null);
      isLoadingContentRef.current = true;
      updateLargeFileMode(fileContent);
      setContent(fileContent);
      originalContentRef.current = fileContent;
      setHasChanges(false);
      hasChangesRef.current = false;
      applyExternalContentToModel(fileContent);
      reportFileMissingFromDisk(false);
      queueMicrotask(() => {
        if (modelRef.current && !isUnmountedRef.current) {
          savedVersionIdRef.current = modelRef.current.getAlternativeVersionId();
          monacoModelManager.markAsSaved(modelKey);
        }
        if (!isUnmountedRef.current) {
          setLoading(false);
          isLoadingContentRef.current = false;
        }
      });
      return;
    }

    // If Model already has content, skip file loading to avoid overwriting unsaved changes (e.g. switching back to open tab)
    if (modelRef.current && modelRef.current.getValue()) {
      setLoading(false);
      void (async () => {
        try {
          const fileInfo = await fetchFileMetadata();
          if (isFileMissingFromMetadata(fileInfo)) {
            reportFileMissingFromDisk(true);
            return;
          }
          reportFileMissingFromDisk(false);
          const v = diskVersionFromMetadata(fileInfo);
          if (v) {
            diskVersionRef.current = v;
          }
        } catch (err) {
          if (isLikelyFileNotFoundError(err)) {
            reportFileMissingFromDisk(true);
          }
          log.warn('Failed to sync file metadata when skipping load', err);
        }
      })();
      return;
    }

    setLoading(true);
    setError(null);
    isLoadingContentRef.current = true;

    try {
      const workspaceAPI = documentFiles;

      const fileContent = await workspaceAPI.readFileContent(filePath);
      reportFileMissingFromDisk(false);
      let fileSizeBytes: number | undefined;
      try {
        const fileInfoAfter = await fetchFileMetadata();
        if (isFileMissingFromMetadata(fileInfoAfter)) {
          reportFileMissingFromDisk(true);
        } else {
          reportFileMissingFromDisk(false);
          const v = diskVersionFromMetadata(fileInfoAfter);
          if (v) {
            diskVersionRef.current = v;
          }
        }
        if (typeof fileInfoAfter?.size === 'number') {
          fileSizeBytes = fileInfoAfter.size;
        }
      } catch (err) {
        if (isLikelyFileNotFoundError(err)) {
          reportFileMissingFromDisk(true);
        }
        log.warn('Failed to get file metadata', err);
      }

      documentSession?.capture(fileContent, false);
      updateLargeFileMode(fileContent, fileSizeBytes);
      
      setContent(fileContent);
      originalContentRef.current = fileContent;
      setHasChanges(false);
      hasChangesRef.current = false;
      applyExternalContentToModel(fileContent);
      
      // NOTE: Do NOT call onContentChange here during initial load.
      // Calling it triggers parent re-render which unmounts this component,
      // causing an infinite loop. onContentChange should only be called
      // when user actually edits the content.
      
      // Sync versionId after Model update
      queueMicrotask(() => {
        if (modelRef.current && !isUnmountedRef.current) {
          savedVersionIdRef.current = modelRef.current.getAlternativeVersionId();
          monacoModelManager.markAsSaved(modelKey);
        }
      });

    } catch (err) {
      // Simplify error message, show only core reason
      const errStr = String(err);
      let displayError = t('editor.common.loadFailed');
      if (errStr.includes('does not exist') || errStr.includes('No such file')) {
        displayError = t('editor.common.fileNotFound');
      } else if (errStr.includes('Permission denied') || errStr.includes('permission')) {
        displayError = t('editor.common.permissionDenied');
      } else if (errStr.includes('network') || errStr.includes('timeout')) {
        displayError = t('editor.common.networkError');
      }
      setError(displayError);
      log.error('Failed to load file', err);
      if (errStr.includes('does not exist') || errStr.includes('No such file')) {
        reportFileMissingFromDisk(true);
      }
    } finally {
      setLoading(false);
      queueMicrotask(() => {
        isLoadingContentRef.current = false;
      });
    }
  }, [
    applyExternalContentToModel,
    documentFiles,
    documentSession,
    fetchFileMetadata,
    filePath,
    initialContent,
    isMemoryContent,
    modelKey,
    reportFileMissingFromDisk,
    t,
    updateLargeFileMode,
  ]);

  // Save file content
  const saveFileContent = useCallback(async () => {
    if (!filePath) return;
    if (isMemoryContent) return;
    
    // Read latest hasChanges state from ref to avoid closure issues
    const currentHasChanges = hasChangesRef.current;
    const currentContent = modelRef.current?.getValue() || '';
    const savedVersion = modelRef.current?.getAlternativeVersionId();
    
    // Use ref value instead of state
    if (!currentHasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const workspaceAPI = documentFiles;

      const fileInfoPre = await fetchFileMetadata();
      if (isFileMissingFromMetadata(fileInfoPre)) {
        reportFileMissingFromDisk(true);
      } else {
        reportFileMissingFromDisk(false);
      }
      const diskNow = diskVersionFromMetadata(fileInfoPre);
      const baseline = diskVersionRef.current;

      if (diskNow && baseline && diskVersionsDiffer(diskNow, baseline)) {
        const overwrite = await confirmDialog({
          title: t('editor.codeEditor.saveConflictTitle'),
          message: t('editor.codeEditor.saveConflictDetail'),
          type: 'warning',
          confirmText: t('editor.codeEditor.overwriteSave'),
          cancelText: t('editor.codeEditor.reloadFromDisk'),
          confirmDanger: true,
        });
        if (!overwrite) {
          const diskContent = await workspaceAPI.readFileContent(filePath);
          const fileInfoAfter = await fetchFileMetadata();
          const vAfter = diskVersionFromMetadata(fileInfoAfter);
          applyDiskSnapshotToEditor(diskContent, vAfter);
          return;
        }
      }

      await workspaceAPI.writeFileContent(workspacePath || '', filePath, currentContent);

      monacoModelManager.markAsSaved(modelKey, currentContent, savedVersion);
      originalContentRef.current = currentContent;
      const latestContent = modelRef.current?.getValue() ?? currentContent;
      const stillDirty = latestContent !== currentContent;
      setHasChanges(stillDirty);
      hasChangesRef.current = stillDirty;
      if (savedVersion !== undefined) savedVersionIdRef.current = savedVersion;
      documentSession?.capture(latestContent, stillDirty, currentContent);
      onSave?.(currentContent);
      onContentChangeRef.current?.(latestContent, stillDirty);

      try {
        const fileInfo = await fetchFileMetadata();
        if (!isFileMissingFromMetadata(fileInfo)) {
          reportFileMissingFromDisk(false);
          const v = diskVersionFromMetadata(fileInfo);
          if (v) {
            diskVersionRef.current = v;
          }
        }
      } catch (err) {
        log.warn('Failed to update file disk version after save', err);
      }

      globalEventBus.emit('file-tree:refresh');
    } catch (err) {
      const errorMsg = t('editor.common.saveFailedWithMessage', { message: String(err) });
      setError(errorMsg);
      log.error('Failed to save file', err);
    } finally {
      setSaving(false);
    }
  }, [
    applyDiskSnapshotToEditor,
    documentFiles,
    documentSession,
    fetchFileMetadata,
    filePath,
    isMemoryContent,
    modelKey,
    onSave,
    reportFileMissingFromDisk,
    t,
    workspacePath,
  ]);
  
  useEffect(() => {
    saveFileContentRef.current = saveFileContent;
    if (documentSession) documentSession.save = saveFileContent;
  }, [documentSession, saveFileContent]);

  useEffect(() => {
    if (!loading && (!error || documentSession?.snapshot)) documentSession?.capture(content, hasChanges, originalContentRef.current);
  }, [documentSession, content, hasChanges, loading, error]);

  useEffect(() => {
    if (!isActiveTab || !autoSave || !filePath || !hasChanges || loading || saving) {
      return;
    }

    const timeout = window.setTimeout(() => {
      saveFileContentRef.current?.();
    }, autoSaveDelayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isActiveTab, autoSave, autoSaveDelayMs, filePath, hasChanges, loading, saving, content]);

  // Container-level keyboard event handler, solves global conflict issues with multiple editor instances
  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const hasFocus = editorRef.current?.hasTextFocus() ?? false;
    if (!hasFocus) {
      return;
    }

    const isModKey = event.ctrlKey || event.metaKey;
    const lowerKey = event.key.toLowerCase();

    if (isModKey && lowerKey === 's') {
      event.preventDefault();
      event.stopPropagation();
      saveFileContentRef.current?.();
      return;
    }

    if (isModKey && lowerKey === 'z') {
      if (isMacOSDesktop()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey) {
        activeEditTargetService.executeAction('redo');
      } else {
        activeEditTargetService.executeAction('undo');
      }
      return;
    }

    if (!event.metaKey && event.ctrlKey && lowerKey === 'y') {
      event.preventDefault();
      event.stopPropagation();
      activeEditTargetService.executeAction('redo');
    }
  }, []);

  const checkFileModification = useCallback(async () => {
    if (!filePath || !isActiveTab || isCheckingFileRef.current) {
      return;
    }

    isCheckingFileRef.current = true;
    const startedAt = nowMs();
    let outcome = 'started';
    let usedHashFallback = false;
    let probeError: string | null = null;

    try {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        outcome = 'skipped-hidden';
        return;
      }

      const fileInfo = await fetchFileMetadata();
      if (isFileMissingFromMetadata(fileInfo)) {
        outcome = 'missing-on-disk';
        reportFileMissingFromDisk(true);
        return;
      }
      reportFileMissingFromDisk(false);
      const currentVersion = diskVersionFromMetadata(fileInfo);
      if (!currentVersion) {
        outcome = 'missing-version';
        return;
      }

      const baseline = diskVersionRef.current;
      if (!baseline) {
        diskVersionRef.current = currentVersion;
        outcome = 'initialized-baseline';
        return;
      }

      if (!diskVersionsDiffer(currentVersion, baseline)) {
        outcome = 'no-change';
        return;
      }

      const bufferBeforeRead = modelRef.current?.getValue();
      try {
        const hashRes: any = await (documentInvoke ?? api.invoke.bind(api))('get_file_editor_sync_hash', {
          request: { path: filePath },
        });
        const diskHash =
          typeof hashRes?.hash === 'string' ? hashRes.hash.toLowerCase() : '';
        const editorMid = modelRef.current?.getValue();
        if (
          bufferBeforeRead !== undefined &&
          editorMid !== undefined &&
          bufferBeforeRead !== editorMid
        ) {
          outcome = 'editor-changed-before-hash';
          return;
        }
        if (diskHash && editorMid !== undefined) {
          const editorHash = await editorSyncContentSha256Hex(editorMid);
          if (editorHash === diskHash) {
            diskVersionRef.current = currentVersion;
            outcome = 'hash-match';
            return;
          }
        }
      } catch (hashErr) {
        usedHashFallback = true;
        log.warn('get_file_editor_sync_hash failed, falling back to full read', {
          filePath,
          error: hashErr,
        });
      }

      const workspaceAPI = documentFiles;
      const editorBuffer = modelRef.current?.getValue();
      if (
        bufferBeforeRead !== undefined &&
        editorBuffer !== undefined &&
        bufferBeforeRead !== editorBuffer
      ) {
        outcome = 'editor-changed-before-read';
        return;
      }
      if (editorBuffer === undefined) {
        outcome = 'missing-editor-buffer';
        return;
      }

      const fileContent = await workspaceAPI.readFileContent(filePath);
      if (diskContentMatchesEditorForExternalSync(fileContent, editorBuffer)) {
        diskVersionRef.current = currentVersion;
        outcome = 'content-match';
        return;
      }

      log.info('File modified externally', { filePath });

      if (hasChangesRef.current) {
        const shouldReload = await confirmDialog({
          title: t('editor.codeEditor.externalModifiedTitle'),
          message: t('editor.codeEditor.externalModifiedDetail'),
          type: 'warning',
          confirmText: t('editor.codeEditor.discardAndReload'),
          cancelText: t('editor.codeEditor.keepLocalEdits'),
          confirmDanger: true,
        });
        if (!shouldReload) {
          diskVersionRef.current = currentVersion;
          outcome = 'kept-local-changes';
          return;
        }
      }

      applyDiskSnapshotToEditor(fileContent, currentVersion);
      outcome = 'reloaded-from-disk';
    } catch (err) {
      outcome = 'error';
      probeError = err instanceof Error ? err.message : String(err);
      if (isLikelyFileNotFoundError(err)) {
        reportFileMissingFromDisk(true);
      }
      log.error('Failed to check file modification', err);
    } finally {
      const durationMs = elapsedMs(startedAt);
      if (probeError || outcome !== 'no-change' || durationMs >= 80) {
        sendDebugProbe(
          'CodeEditor.tsx:checkFileModification',
          'Code editor disk sync completed',
          {
            filePath,
            outcome,
            durationMs,
            usedHashFallback,
            error: probeError,
          }
        );
      }
      isCheckingFileRef.current = false;
    }
  }, [applyDiskSnapshotToEditor, documentFiles, documentInvoke, fetchFileMetadata, filePath, isActiveTab, reportFileMissingFromDisk, t]);

  // Initial file load - only run once when filePath changes
  const loadFileContentCalledRef = useRef(false);
  useEffect(() => {
    loadFileContentCalledRef.current = false;
    diskVersionRef.current = null;
    lastReportedMissingRef.current = undefined;
  }, [filePath]);
  
  useEffect(() => {
    if ((!documentSession || documentSession.isCurrent()) && !loadFileContentCalledRef.current) {
      loadFileContentCalledRef.current = true;
      loadFileContent();
    }
  }, [loadFileContent, isActiveTab, documentSession]);

  useEffect(() => {
    if (isActiveTab && documentSession?.isCurrent() && !documentSession.snapshot && error) void loadFileContent();
  }, [documentSession, error, isActiveTab, loadFileContent]);

  useEffect(() => {
    if (!filePath || !isActiveTab || isMemoryContent) {
      return;
    }

    const tick = () => {
      void checkFileModification();
    };
    const pollOffsetMs = getPollOffsetMs(filePath);
    const pollIntervalMs = isPeerDeviceModeActive()
      ? PEER_MODE_FILE_SYNC_POLL_MS
      : FILE_SYNC_POLL_INTERVAL_MS;
    let intervalId: number | null = null;
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, pollIntervalMs + pollOffsetMs);
    }, 250 + pollOffsetMs);

    const onPeerModeChanged = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      const nextIntervalMs = isPeerDeviceModeActive()
        ? PEER_MODE_FILE_SYNC_POLL_MS
        : FILE_SYNC_POLL_INTERVAL_MS;
      intervalId = window.setInterval(tick, nextIntervalMs + pollOffsetMs);
    };
    window.addEventListener('peer-mode:changed', onPeerModeChanged);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener('peer-mode:changed', onPeerModeChanged);
    };
  }, [checkFileModification, filePath, isActiveTab, isMemoryContent]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monacoReady) {
      return;
    }

    const unsubscribers: Array<() => void> = [];

    const matchesEventFile = (data: { filePath?: string }): boolean =>
      isActiveTab && (!documentSession || documentSession.isCurrent())
      && (documentSession ? resourcePathKey(data.filePath || '', documentSession.scope) === resourcePathKey(filePath, documentSession.scope)
        : isSamePath(data.filePath || '', filePath || ''));

    const runSupportedEditorAction = async (
      actionId: string,
      failureMessage: string
    ): Promise<void> => {
      const action = editor.getAction(actionId);
      if (!action?.isSupported()) {
        return;
      }
      try {
        await action.run();
      } catch (error) {
        log.error(failureMessage, error);
      }
    };

    const unsubGotoDef = globalEventBus.on('editor:goto-definition', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.revealDefinition',
          'Goto definition failed'
        );
      }
    });
    unsubscribers.push(unsubGotoDef);

    const unsubGotoTypeDef = globalEventBus.on('editor:goto-type-definition', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.goToTypeDefinition',
          'Goto type definition failed'
        );
      }
    });
    unsubscribers.push(unsubGotoTypeDef);

    const unsubFindRefs = globalEventBus.on('editor:find-references', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.referenceSearch.trigger',
          'Find references failed'
        );
      }
    });
    unsubscribers.push(unsubFindRefs);

    const unsubRename = globalEventBus.on('editor:rename-symbol', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction('editor.action.rename', 'Rename symbol failed');
      }
    });
    unsubscribers.push(unsubRename);

    const unsubFormat = globalEventBus.on('editor:format-document', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.formatDocument',
          'Format document failed'
        );
      }
    });
    unsubscribers.push(unsubFormat);

    const unsubCodeAction = globalEventBus.on('editor:code-action', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction('editor.action.quickFix', 'Quick fix failed');
      }
    });
    unsubscribers.push(unsubCodeAction);

    const unsubDocSymbols = globalEventBus.on('editor:document-symbols', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.quickOutline',
          'Open document symbols failed'
        );
      }
    });
    unsubscribers.push(unsubDocSymbols);

    const unsubDocHighlight = globalEventBus.on('editor:document-highlight', (data: any) => {
      if (matchesEventFile(data)) {
        void runSupportedEditorAction(
          'editor.action.wordHighlight.trigger',
          'Highlight occurrences failed'
        );
      }
    });
    unsubscribers.push(unsubDocHighlight);

    const unsubFileChanged = globalEventBus.on('editor:file-changed', async (data: { filePath: string }) => {
      if (isMemoryContent) return;
      if (!matchesEventFile(data)) {
        return;
      }

      try {
        const workspaceAPI = documentFiles;
        const bufferBeforeRead = modelRef.current?.getValue();
        try {
          const hashRes: any = await (documentSession?.invoke ?? api.invoke.bind(api))('get_file_editor_sync_hash', {
            request: { path: filePath },
          });
          const diskHash =
            typeof hashRes?.hash === 'string' ? hashRes.hash.toLowerCase() : '';
          const editorMid = modelRef.current?.getValue();
          if (
            bufferBeforeRead !== undefined &&
            editorMid !== undefined &&
            bufferBeforeRead !== editorMid
          ) {
            return;
          }
          if (diskHash && editorMid !== undefined) {
            const editorHash = await editorSyncContentSha256Hex(editorMid);
            if (editorHash === diskHash) {
              try {
                const fileInfo = await fetchFileMetadata();
                const v = diskVersionFromMetadata(fileInfo);
                if (v) {
                  diskVersionRef.current = v;
                }
              } catch (err) {
                log.warn('Failed to sync disk version after noop file-changed', err);
              }
              return;
            }
          }
        } catch (hashErr) {
          log.warn('get_file_editor_sync_hash failed in file-changed handler', {
            filePath,
            error: hashErr,
          });
        }

        const diskContent = await workspaceAPI.readFileContent(filePath);
        const editorBuffer = modelRef.current?.getValue();
        if (
          bufferBeforeRead !== undefined &&
          editorBuffer !== undefined &&
          bufferBeforeRead !== editorBuffer
        ) {
          return;
        }
        if (
          editorBuffer !== undefined &&
          diskContentMatchesEditorForExternalSync(diskContent, editorBuffer)
        ) {
          try {
            const fileInfo = await fetchFileMetadata();
            const v = diskVersionFromMetadata(fileInfo);
            if (v) {
              diskVersionRef.current = v;
            }
          } catch (err) {
            log.warn('Failed to sync disk version after noop file-changed', err);
          }
          return;
        }

        if (hasChangesRef.current) {
          const shouldReload = await confirmDialog({
            title: t('editor.codeEditor.externalModifiedTitle'),
            message: t('editor.codeEditor.externalModifiedDetail'),
            type: 'warning',
            confirmText: t('editor.codeEditor.discardAndReload'),
            cancelText: t('editor.codeEditor.keepLocalEdits'),
            confirmDanger: true,
          });
          if (!shouldReload) {
            try {
              const fileInfo = await fetchFileMetadata();
              const v = diskVersionFromMetadata(fileInfo);
              if (v) {
                diskVersionRef.current = v;
              }
            } catch (err) {
              log.warn('Failed to sync disk version after declining external reload', err);
            }
            return;
          }
        }

        const fileInfo = await fetchFileMetadata();
        const ver = diskVersionFromMetadata(fileInfo);
        const currentPosition = editor?.getPosition() ?? null;
        applyDiskSnapshotToEditor(diskContent, ver, { restoreCursor: currentPosition });
      } catch (error) {
        log.error('Failed to reload file', error);
      }
    });
    unsubscribers.push(unsubFileChanged);

    const unsubSaveFile = globalEventBus.on('editor:save-file', (data: { filePath: string }) => {
      if (matchesEventFile(data)) {
        saveFileContentRef.current?.();
      }
    });
    unsubscribers.push(unsubSaveFile);

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [applyDiskSnapshotToEditor, documentFiles, fetchFileMetadata, monacoReady, filePath, isMemoryContent, isActiveTab, documentSession, t, workspacePath]);

  useEffect(() => {
    userLanguageOverrideRef.current = false;
  }, [filePath]);

  useEffect(() => {
    if (userLanguageOverrideRef.current || !fileName) return;
    const newLanguage = detectLanguageFromFileName(fileName);
    if (newLanguage !== detectedLanguage) {
      setDetectedLanguage(newLanguage);
    }
  }, [fileName, detectedLanguage, detectLanguageFromFileName]);

  const loadingOverlayText = monacoReady
    ? t('editor.codeEditor.loadingFile')
    : t('editor.codeEditor.preparingEditor');

  return (
    <div 
      className={`code-editor-tool ${className} ${loading && showLoadingOverlay ? 'is-loading' : ''} ${error ? 'is-error' : ''} ${largeFileMode ? 'is-large-file-mode' : ''}`}
      data-monaco-editor="true"
      data-editor-id={`editor-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}`}
      data-file-path={filePath}
      data-readonly={readOnly ? 'true' : 'false'}
      data-openbitfun-component="editor-tool"
      data-openbitfun-part="root"
      data-openbitfun-state={[
        loading && showLoadingOverlay && 'loading',
        error && 'error',
        largeFileMode && 'large-file',
      ].filter(Boolean).join(' ') || undefined}
      onKeyDownCapture={handleContainerKeyDown}
    >
      {showBreadcrumb && (
        <EditorBreadcrumb
          filePath={filePath}
          workspacePath={workspacePath}
        />
      )}
      
      <div className="code-editor-tool__content" data-shortcut-scope="editor" data-openbitfun-component="editor-tool" data-openbitfun-part="content">
        <div 
          ref={containerRef} 
          style={{ 
            width: '100%', 
            height: '100%',
            overflow: 'hidden',
            opacity: loading && showLoadingOverlay ? 0.3 : 1,
            transition: 'opacity 0.2s'
          }} 
        />
      </div>

      {loading && showLoadingOverlay && (
        <div className="code-editor-tool__loading-overlay" data-openbitfun-component="editor-tool" data-openbitfun-part="loading">
          <LoadingState size="md">{loadingOverlayText}</LoadingState>
        </div>
      )}

      {error && (
        <div className="code-editor-tool__error-overlay" data-openbitfun-component="editor-tool" data-openbitfun-part="error">
          <AlertCircle className="code-editor-tool__error-icon" />
          <p className="code-editor-tool__error-message">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={loadFileContent}
          >
            {t('editor.common.retry')}
          </Button>
        </div>
      )}

      {saving && (
        <div className="code-editor-tool__saving-indicator" data-openbitfun-component="editor-tool" data-openbitfun-part="saving">
          {t('editor.codeEditor.saving')}
        </div>
      )}

      <EditorStatusBar
        line={cursorPosition.line}
        column={cursorPosition.column}
        selectedChars={selection.chars}
        selectedLines={selection.lines}
        language={detectedLanguage}
        encoding={encoding}
        tabSize={indentation.tabSize}
        insertSpaces={indentation.insertSpaces}
        isReadOnly={readOnly}
        onPositionClick={(e) => openStatusBarPopover('position', e)}
        onIndentClick={(e) => openStatusBarPopover('indent', e)}
        onEncodingClick={isMemoryContent ? undefined : (e) => openStatusBarPopover('encoding', e)}
        onLanguageClick={(e) => openStatusBarPopover('language', e)}
      />

      {statusBarPopover === 'position' && statusBarAnchorRect && (
        <GoToLinePopover
          anchorRect={statusBarAnchorRect}
          currentLine={cursorPosition.line}
          currentColumn={cursorPosition.column}
          onConfirm={handleGoToLineConfirm}
          onClose={closeStatusBarPopover}
        />
      )}
      {statusBarPopover === 'indent' && statusBarAnchorRect && (
        <IndentPopover
          anchorRect={statusBarAnchorRect}
          currentTabSize={indentation.tabSize}
          currentInsertSpaces={indentation.insertSpaces}
          onConfirm={handleIndentConfirm}
          onClose={closeStatusBarPopover}
        />
      )}
      {statusBarPopover === 'encoding' && statusBarAnchorRect && (
        <EncodingPopover
          anchorRect={statusBarAnchorRect}
          currentEncoding={encoding}
          onConfirm={handleEncodingConfirm}
          onClose={closeStatusBarPopover}
        />
      )}
      {statusBarPopover === 'language' && statusBarAnchorRect && (
        <LanguagePopover
          anchorRect={statusBarAnchorRect}
          currentLanguageId={detectedLanguage}
          languages={getMonacoRuntime()?.languages.getLanguages() ?? []}
          onConfirm={handleLanguageConfirm}
          onClose={closeStatusBarPopover}
        />
      )}
    </div>
  );
};

export default CodeEditor;
