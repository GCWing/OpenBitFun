/**
 * Monaco initialization manager (singleton).
 *
 * Handles Monaco library initialization (once), TypeScript/JavaScript language
 * configuration, custom language registration (TOML), and EditorOpener registration
 * for cross-file navigation.
 *
 * Visual settings are attached by MonacoAppearanceAdapter.
 */

import { loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { registerMermaidLanguage } from '../languages/mermaid.language';
import { registerTomlLanguage } from '../languages/toml.language';
import { getMonacoPath, getMonacoWorkerPath, logMonacoResourceCheck } from '../utils/monacoPathHelper';
import { setMonacoRuntime } from './monacoRuntime';
import { createLogger } from '@/shared/utils/logger';
import { monacoAppearanceAdapter } from '@/infrastructure/appearance/adapters/MonacoAppearanceAdapter';
import type { ContentResourceScope } from '@/shared/types/contentResource';

const log = createLogger('MonacoInitManager');

const MONACO_WORKER_MAP: Record<string, string> = {
  json: 'language/json/jsonWorker.js',
  css: 'language/css/cssWorker.js',
  scss: 'language/css/cssWorker.js',
  less: 'language/css/cssWorker.js',
  html: 'language/html/htmlWorker.js',
  handlebars: 'language/html/htmlWorker.js',
  razor: 'language/html/htmlWorker.js',
  typescript: 'language/typescript/tsWorker.js',
  javascript: 'language/typescript/tsWorker.js',
};

const DEFAULT_WORKER = 'base/worker/workerMain.js';

class MonacoInitManager {
  private static instance: MonacoInitManager;
  
  private initPromise: Promise<typeof Monaco> | null = null;
  private monaco: typeof Monaco | null = null;
  private editorOpenerRegistered = false;
  private loaderConfigured = false;
  private resourceCheckScheduled = false;
  
  private constructor() {}
  
  public static getInstance(): MonacoInitManager {
    if (!MonacoInitManager.instance) {
      MonacoInitManager.instance = new MonacoInitManager();
    }
    return MonacoInitManager.instance;
  }
  
  /**
   * Initialize Monaco library (idempotent, returns same Promise on repeated calls).
   */
  public async initialize(): Promise<typeof Monaco> {
    if (this.monaco) {
      return this.monaco;
    }
    
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    
    return this.initPromise;
  }
  
  private async doInitialize(): Promise<typeof Monaco> {
    try {
      log.info('Initializing Monaco Editor');

      this.configureLoader();
      await import('monaco-editor/min/vs/editor/editor.main.css');
      const monaco = await loader.init();
      setMonacoRuntime(monaco);

      this.configureTypeScriptLanguage(monaco);
      monacoAppearanceAdapter.attachMonaco(monaco);
      this.registerCustomLanguages(monaco);
      this.registerEditorOpener(monaco);
      this.overrideEditorService(monaco);
      this.setupPeekReferencesClickHandler();
      
      this.monaco = monaco;
      log.info('Monaco Editor initialized successfully');
      
      return monaco;
    } catch (error) {
      log.error('Failed to initialize Monaco', error);
      this.initPromise = null; // Allow retry
      throw error;
    }
  }

  private configureLoader(): void {
    if (this.loaderConfigured) {
      return;
    }

    const monacoPath = getMonacoPath();
    loader.config({
      paths: {
        vs: monacoPath,
      },
    });

    (window as any).MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        const workerFile = MONACO_WORKER_MAP[label] || DEFAULT_WORKER;
        const workerPath = getMonacoWorkerPath(workerFile);

        return new Worker(workerPath, {
          type: 'classic',
          name: `monaco-${label}-worker`,
        });
      },
    };

    this.loaderConfigured = true;
    log.debug('Monaco loader configured', {
      vs: monacoPath,
      isDev: import.meta.env.DEV,
    });
    this.scheduleResourceCheck();
  }

  private scheduleResourceCheck(): void {
    if (import.meta.env.DEV || this.resourceCheckScheduled) {
      return;
    }

    this.resourceCheckScheduled = true;
    window.setTimeout(() => {
      logMonacoResourceCheck().catch(err => {
        log.error('Monaco resource check failed', err);
      });
    }, 2000);
  }
  
  private configureTypeScriptLanguage(monaco: typeof Monaco): void {
    try {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        strict: false,
        jsx: monaco.languages.typescript.JsxEmit.React,
        esModuleInterop: true,
        skipLibCheck: true,
        isolatedModules: true,
      });
      
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: false,
      });
      
      monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        strict: false,
        jsx: monaco.languages.typescript.JsxEmit.React,
        esModuleInterop: true,
        skipLibCheck: true,
      });
      
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: false,
      });
      
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
      
      log.debug('TypeScript/JavaScript language service configured');
    } catch (error) {
      log.warn('Failed to configure TypeScript language service', error);
    }
  }
  
  private registerCustomLanguages(monaco: typeof Monaco): void {
    try {
      registerTomlLanguage(monaco);
      registerMermaidLanguage(monaco);
      log.debug('TOML language registered');
      log.debug('Mermaid language registered');
    } catch (error) {
      log.error('Failed to register custom Monaco languages', error);
    }
  }
  
  /**
   * Resolve the content scope that owns a file already open on this surface.
   * A cross-file jump stays inside the workspace of the document it starts
   * from; the target path is only an IO operand on that workspace's host and
   * must never be turned into a workspace by its parent directory.
   */
  private async resolveOpenFileScope(filePath?: string): Promise<ContentResourceScope | undefined> {
    if (!filePath) return undefined;
    const [{ useContentResourceStore }, { resourcePathKey }, { getActiveSurfaceId }] = await Promise.all([
      import('@/app/workbench/contentResourceStore'),
      import('@/shared/utils/resourcePath'),
      import('@/infrastructure/peer-device/deviceSurface'),
    ]);
    const surfaceId = getActiveSurfaceId();
    for (const resource of Object.values(useContentResourceStore.getState().resources)) {
      if (resource.scope.surfaceId !== surfaceId || resource.target.kind !== 'file') continue;
      if (resourcePathKey(resource.target.path, resource.scope) === resourcePathKey(filePath, resource.scope)) {
        return resource.scope;
      }
    }
    return undefined;
  }

  private static sourceEditorFilePath(source: unknown): string | undefined {
    const model = (source as { getModel?: () => { uri?: Monaco.Uri } | null } | null)?.getModel?.();
    return model?.uri ? model.uri.toString() : undefined;
  }

  /**
   * Register EditorOpener for cross-file navigation from Peek References views.
   */
  private registerEditorOpener(monaco: typeof Monaco): void {
    if (this.editorOpenerRegistered) {
      return;
    }
    
    try {
      if (typeof monaco.editor.registerEditorOpener !== 'function') {
        log.warn('registerEditorOpener API not available');
        return;
      }
      
      monaco.editor.registerEditorOpener({
        openCodeEditor: async (
          source: unknown,
          resource: Monaco.Uri,
          selectionOrPosition?: Monaco.IRange | Monaco.IPosition
        ) => {
          log.debug('EditorOpener open request', { uri: resource.toString(), selection: selectionOrPosition });
          
          let targetLine = 1;
          let targetColumn = 1;
          
          if (selectionOrPosition) {
            if ('startLineNumber' in selectionOrPosition) {
              targetLine = selectionOrPosition.startLineNumber;
              targetColumn = selectionOrPosition.startColumn;
            } else if ('lineNumber' in selectionOrPosition) {
              targetLine = selectionOrPosition.lineNumber;
              targetColumn = selectionOrPosition.column;
            }
          }
          
          const { normalizePath } = await import('@/shared/utils/pathUtils');
          const normalizedPath = normalizePath(resource.toString());
          
          log.debug('Cross-file jump', { normalizedPath, targetLine, targetColumn });
          
          try {
            const { fileTabManager } = await import('@/shared/services/FileTabManager');
            const sourcePath = MonacoInitManager.sourceEditorFilePath(source);
            const scope = await this.resolveOpenFileScope(sourcePath ? normalizePath(sourcePath) : undefined)
              ?? await this.resolveOpenFileScope(normalizedPath);
            
            fileTabManager.openFileAndJump(
              normalizedPath,
              targetLine,
              targetColumn,
              scope ? { scope } : {}
            );
          } catch (error) {
            log.error('Failed to open file', { normalizedPath, targetLine, targetColumn, error });
            
            // Fallback: use event dispatch
            const fileName = normalizedPath.split(/[/\\]/).pop() || 'untitled';
            const isMarkdownFile = fileName.toLowerCase().endsWith('.md');
            const editorType = isMarkdownFile ? 'markdown-editor' : 'code-editor';
            
            window.dispatchEvent(new CustomEvent('agent-create-tab', {
              detail: {
                type: editorType,
                title: fileName,
                data: {
                  filePath: normalizedPath,
                  fileName,
                  jumpToLine: targetLine,
                  jumpToColumn: targetColumn,
                },
                checkDuplicate: true,
                duplicateCheckKey: normalizedPath,
              },
            }));
          }
          
          return true;
        },
      });
      
      this.editorOpenerRegistered = true;
      log.debug('EditorOpener registered');
    } catch (error) {
      log.warn('Failed to register EditorOpener', error);
    }
  }
  
  private overrideEditorService(monaco: typeof Monaco): void {
    try {
      const standaloneServices = (monaco.editor as any).StandaloneServices;
      if (standaloneServices) {
        log.debug('StandaloneServices available');
      }
    } catch (error) {
      log.warn('EditorService override failed', error);
    }
  }
  
  /**
   * Handle double-click in Peek References widget for cross-file navigation.
   */
  private setupPeekReferencesClickHandler(): void {
    document.addEventListener('dblclick', async (event) => {
      const target = event.target as HTMLElement;
      
      const peekWidget = target.closest('.peekview-widget, .zone-widget, .references-zone-widget');
      if (!peekWidget) {
        return;
      }
      
      const referenceItem = target.closest(
        '.peekview-widget .monaco-list-row, ' +
        '.zone-widget .monaco-list-row, ' +
        '.references-zone-widget .monaco-list-row'
      );
      
      if (!referenceItem) {
        return;
      }
      
      let filePath = '';
      let lineNumber = 1;
      
      const dataUri = referenceItem.getAttribute('data-uri') ||
                      referenceItem.getAttribute('data-resource');
      
      if (dataUri) {
        filePath = dataUri;
      }
      
      const lineElement = referenceItem.querySelector('.reference-line, .line-number, [class*="line"]');
      if (lineElement) {
        const lineText = lineElement.textContent?.trim() || '';
        const match = lineText.match(/(\d+)/);
        if (match) {
          lineNumber = parseInt(match[1], 10);
        }
      }
      
      if (filePath) {
        event.preventDefault();
        event.stopPropagation();
        
        try {
          const { normalizePath } = await import('@/shared/utils/pathUtils');
          const normalizedPath = normalizePath(filePath);
          
          const { fileTabManager } = await import('@/shared/services/FileTabManager');
          const scope = await this.resolveOpenFileScope(normalizedPath);
          
          fileTabManager.openFileAndJump(normalizedPath, lineNumber, 1, scope ? { scope } : {});
        } catch (error) {
          log.error('Cross-file jump failed', { filePath, lineNumber, error });
        }
      }
    }, true);
  }
  
  public getMonaco(): typeof Monaco | null {
    return this.monaco;
  }
  
  public isInitialized(): boolean {
    return this.monaco !== null;
  }
  
  /** Reset initialization state (for testing). */
  public reset(): void {
    this.initPromise = null;
    this.monaco = null;
    setMonacoRuntime(null);
    this.editorOpenerRegistered = false;
    this.loaderConfigured = false;
    this.resourceCheckScheduled = false;
  }
}

export const monacoInitManager = MonacoInitManager.getInstance();
export default MonacoInitManager;

export { monacoInitManager as MonacoManager };
