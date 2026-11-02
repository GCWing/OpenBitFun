/**
 * Monaco Model Manager (singleton).
 *
 * Global model pool manager ensuring one Model per URI, reference counting,
 * metadata tracking (dirty state, version), and unified lifecycle management.
 *
 * Design: Models are the data layer (globally unique, persistent).
 * Editors are the view layer (created/destroyed freely).
 * One Model can be used by multiple Editors.
 */

import type * as monaco from 'monaco-editor';
import { getMonacoRuntime, monacoApi } from './monacoRuntime';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('MonacoModelManager');

export interface ModelMetadata {
  /** How many Editors are using this Model */
  referenceCount: number;
  isDirty: boolean;
  /** Version ID when saved (for dirty detection) */
  savedVersionId: number;
  originalContent: string;
  createdAt: number;
  lastAccessedAt: number;
  /** Normalized absolute file path */
  filePath: string;
  workspacePath?: string;
  languageId: string;
}

interface ModelLoadState {
  isLoading: boolean;
  promise?: Promise<void>;
  resolve?: () => void;
  reject?: (error: Error) => void;
}

export interface ModelCreatedEvent {
  uri: string;
  filePath: string;
  language: string;
  model: monaco.editor.ITextModel;
}

export interface ModelContentChangedEvent {
  uri: string;
  filePath: string;
  content: string;
  model: monaco.editor.ITextModel;
}

export interface ModelDisposedEvent {
  uri: string;
  filePath: string;
}

export interface ModelContentReadyEvent {
  uri: string;
  filePath: string;
  content: string;
  model: monaco.editor.ITextModel;
}

type EventListener<T> = (event: T) => void;

class MonacoModelManager {
  private static instance: MonacoModelManager;
  
  private modelMetadata = new Map<string, ModelMetadata>();
  private modelLoadStates = new Map<string, ModelLoadState>();
  private contentChangeListeners = new Map<string, monaco.IDisposable>();
  private disposalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private documentModels = new Set<string>();
  /** Disposal delay (ms), 0 for immediate */
  private disposalDelay = 10000;
  
  private modelCreatedListeners: Array<EventListener<ModelCreatedEvent>> = [];
  private modelContentChangedListeners: Array<EventListener<ModelContentChangedEvent>> = [];
  private modelDisposedListeners: Array<EventListener<ModelDisposedEvent>> = [];
  private modelContentReadyListeners: Array<EventListener<ModelContentReadyEvent>> = [];
  
  private globalListenersInstalled = false;

  /**
   * Suppress dirty recomputation only for the model being synchronized.
   * Content listeners may synchronously edit other models; those edits still
   * participate in dirty tracking. Depth supports nested writes to one model.
   */
  private externalSyncDepth = new WeakMap<monaco.editor.ITextModel, number>();

  private constructor() {}

  public static getInstance(): MonacoModelManager {
    if (!MonacoModelManager.instance) {
      MonacoModelManager.instance = new MonacoModelManager();
    }
    return MonacoModelManager.instance;
  }

  /**
   * Install global Monaco listeners lazily (Monaco is loaded at runtime via the
   * AMD loader, so this must not run at module-evaluation time).
   */
  private ensureGlobalListeners(): void {
    if (this.globalListenersInstalled) {
      return;
    }
    this.globalListenersInstalled = true;
    // Sync cleanup when Model is disposed externally
    monacoApi.editor.onWillDisposeModel((model) => {
      const uri = model.uri.toString();
      this.cleanupMetadata(uri);
    });
  }

  public getOrCreateModel(
    filePath: string,
    language: string,
    initialContent: string = '',
    workspacePath?: string,
    modelKey: string = filePath
  ): monaco.editor.ITextModel {
    this.ensureGlobalListeners();

    const uri = this.normalizeUri(modelKey);
    const uriString = uri.toString();

    if (modelKey !== filePath) this.documentModels.add(uriString);

    this.cancelDisposalTimer(uriString);

    let model = monacoApi.editor.getModel(uri);
    
    if (model) {
      const metadata = this.modelMetadata.get(uriString);
      if (metadata) {
        metadata.referenceCount++;
        metadata.lastAccessedAt = Date.now();
      } else {
        // Model exists but no metadata (externally created)
        this.createMetadata(uriString, filePath, language, initialContent, workspacePath, model);
      }
      
      const existingContent = model.getValue();
      if (existingContent) {
        this.emitModelContentReady({
          uri: uriString,
          filePath,
          content: existingContent,
          model
        });
      }
      
      if (initialContent && model.getValue() === '') {
        this.updateModelContent(modelKey, initialContent, true);
      }
      
      return model;
    }
    
    model = monacoApi.editor.createModel(initialContent, language, uri);
    
    this.createMetadata(uriString, filePath, language, initialContent, workspacePath, model);
    this.setupContentChangeListener(uriString, model);
    
    this.emitModelCreated({
      uri: uriString,
      filePath,
      language,
      model
    });
    
    if (initialContent) {
      this.emitModelContentReady({
        uri: uriString,
        filePath,
        content: initialContent,
        model
      });
    }
    
    return model;
  }
  
  private createMetadata(
    uriString: string,
    filePath: string,
    languageId: string,
    originalContent: string,
    workspacePath: string | undefined,
    model: monaco.editor.ITextModel
  ): void {
    const now = Date.now();
    const metadata: ModelMetadata = {
      referenceCount: 1,
      isDirty: false,
      savedVersionId: model.getAlternativeVersionId(),
      originalContent,
      createdAt: now,
      lastAccessedAt: now,
      filePath,
      workspacePath,
      languageId
    };
    
    this.modelMetadata.set(uriString, metadata);
  }
  
  private setupContentChangeListener(
    uriString: string,
    model: monaco.editor.ITextModel
  ): void {
    const listener = model.onDidChangeContent(() => {
      const metadata = this.modelMetadata.get(uriString);
      if (metadata) {
        if (!this.externalSyncDepth.has(model)) {
          const currentVersionId = model.getAlternativeVersionId();
          metadata.isDirty = this.documentModels.has(uriString) ? model.getValue() !== metadata.originalContent
            : currentVersionId !== metadata.savedVersionId;

          window.dispatchEvent(new CustomEvent('monaco-model-dirty-changed', {
            detail: {
              uri: uriString,
              filePath: metadata.filePath,
              isDirty: metadata.isDirty
            }
          }));
        }

        // Disk writes change content too, even when dirty tracking is suppressed.
        this.emitModelContentChanged({
          uri: uriString,
          filePath: metadata.filePath,
          content: model.getValue(),
          model
        });
      }
    });
    
    this.contentChangeListeners.set(uriString, listener);
  }
  
  public releaseModel(filePath: string, immediate: boolean = false): void {
    const uri = this.normalizeUri(filePath);
    const uriString = uri.toString();
    
    const metadata = this.modelMetadata.get(uriString);
    if (!metadata) {
      log.warn('Trying to release non-existent model', { filePath });
      return;
    }
    
    metadata.referenceCount = Math.max(0, metadata.referenceCount - 1);
    metadata.lastAccessedAt = Date.now();
    
    if (metadata.referenceCount === 0) {
      if (this.documentModels.has(uriString)) return;
      if (immediate || this.disposalDelay === 0) {
        this.disposeModel(uriString);
      } else {
        this.scheduleDisposal(uriString);
      }
    }
  }
  
  private scheduleDisposal(uriString: string): void {
    this.cancelDisposalTimer(uriString);
    
    const timer = setTimeout(() => {
      const metadata = this.modelMetadata.get(uriString);
      if (metadata && metadata.referenceCount === 0 && !this.documentModels.has(uriString)) {
        this.disposeModel(uriString);
      }
    }, this.disposalDelay);
    
    this.disposalTimers.set(uriString, timer);
  }

  public releaseDocumentModel(modelKey: string): void {
    if (!getMonacoRuntime()) return;
    const uri = this.normalizeUri(modelKey).toString();
    this.documentModels.delete(uri);
    if (this.modelMetadata.get(uri)?.referenceCount === 0) this.disposeModel(uri);
  }
  
  private cancelDisposalTimer(uriString: string): void {
    const timer = this.disposalTimers.get(uriString);
    if (timer) {
      clearTimeout(timer);
      this.disposalTimers.delete(uriString);
    }
  }
  
  private disposeModel(uriString: string): void {
    const metadata = this.modelMetadata.get(uriString);
    const model = monacoApi.editor.getModel(monacoApi.Uri.parse(uriString));
    
    if (!model) {
      log.warn('Model already disposed', { uri: uriString });
      this.cleanupMetadata(uriString);
      return;
    }
    
    if (metadata) {
      this.emitModelDisposed({
        uri: uriString,
        filePath: metadata.filePath
      });
    }
    
    const listener = this.contentChangeListeners.get(uriString);
    if (listener) {
      listener.dispose();
      this.contentChangeListeners.delete(uriString);
    }
    
    this.cleanupMetadata(uriString);
    model.dispose();
  }
  
  private cleanupMetadata(uriString: string): void {
    this.documentModels.delete(uriString);
    this.modelMetadata.delete(uriString);
    this.modelLoadStates.delete(uriString);
    this.cancelDisposalTimer(uriString);
  }
  
  public updateModelContent(
    filePath: string,
    content: string,
    markAsSaved: boolean = false
  ): void {
    const uri = this.normalizeUri(filePath);
    const uriString = uri.toString();
    const model = monacoApi.editor.getModel(uri);
    
    if (!model) {
      log.warn('Cannot update non-existent model', { filePath });
      return;
    }
    
    const loadState = this.modelLoadStates.get(uriString);
    const isLoadingState = loadState && loadState.isLoading;
    
    const metadata = this.modelMetadata.get(uriString);
    const wasEmpty = !metadata || metadata.originalContent === '';
    const isFirstContentSet = wasEmpty && content.length > 0;
    
    // markAsSaved callers push the disk truth into an open model (issue
    // #3165): bracket the write so the change listener does not recompute the
    // dirty flag or broadcast a transient "modified" state in between.
    if (markAsSaved) {
      this.beginExternalSync(model);
    }
    try {
      model.setValue(content);
    } finally {
      if (markAsSaved) {
        this.endExternalSync(model);
      }
    }
    
    if (metadata) {
      if (markAsSaved) {
        metadata.savedVersionId = model.getAlternativeVersionId();
        metadata.originalContent = content;
        metadata.isDirty = false;
        metadata.lastAccessedAt = Date.now();
        
        window.dispatchEvent(new CustomEvent('monaco-model-dirty-changed', {
          detail: {
            uri: uriString,
            filePath: metadata.filePath,
            isDirty: false
          }
        }));
      } else {
        metadata.lastAccessedAt = Date.now();
      }
    }
    
    this.markLoadingComplete(uriString);
    
    if (isLoadingState || isFirstContentSet) {
      this.emitModelContentReady({
        uri: uriString,
        filePath,
        content,
        model
      });
    }
  }
  
  /**
   * Open a programmatic external-sync bracket for one model. While it is open,
   * its changes skip the dirty recompute and the transient dirty broadcast
   * (issue #3165). Pair every begin with an end in a finally block.
   */
  public beginExternalSync(model: monaco.editor.ITextModel): void {
    this.externalSyncDepth.set(model, (this.externalSyncDepth.get(model) ?? 0) + 1);
  }

  /**
   * Close a bracket for this model. Extra ends are no-ops; callers must still
   * pair every begin with an end in a finally block.
   */
  public endExternalSync(model: monaco.editor.ITextModel): void {
    const depth = this.externalSyncDepth.get(model) ?? 0;
    if (depth > 1) {
      this.externalSyncDepth.set(model, depth - 1);
    } else {
      this.externalSyncDepth.delete(model);
    }
  }

  public markAsSaved(filePath: string, savedContent?: string, savedVersionId?: number): void {
    const uri = this.normalizeUri(filePath);
    const uriString = uri.toString();
    const model = monacoApi.editor.getModel(uri);
    const metadata = this.modelMetadata.get(uriString);
    
    if (model && metadata) {
      metadata.savedVersionId = savedVersionId ?? model.getAlternativeVersionId();
      metadata.originalContent = savedContent ?? model.getValue();
      metadata.isDirty = model.getValue() !== metadata.originalContent;
      metadata.lastAccessedAt = Date.now();
      
      window.dispatchEvent(new CustomEvent('monaco-model-dirty-changed', {
        detail: {
          uri: uriString,
          filePath: metadata.filePath,
          isDirty: metadata.isDirty
        }
      }));
    }
  }

  public getModelMetadata(filePath: string): ModelMetadata | undefined {
    if (!getMonacoRuntime()) {
      return undefined;
    }
    const uri = this.normalizeUri(filePath);
    const uriString = uri.toString();
    return this.modelMetadata.get(uriString);
  }
  
  public getModel(filePath: string): monaco.editor.ITextModel | null {
    if (!getMonacoRuntime()) {
      return null;
    }
    const uri = this.normalizeUri(filePath);
    return monacoApi.editor.getModel(uri);
  }
  
  public async waitForModelContent(filePath: string, timeout: number = 5000): Promise<void> {
    const uri = this.normalizeUri(filePath);
    const uriString = uri.toString();
    const model = monacoApi.editor.getModel(uri);
    
    if (!model) {
      throw new Error(`Model not found: ${filePath}`);
    }
    
    if (model.getLineCount() > 1 || model.getLineContent(1).length > 0) {
      return;
    }
    
    let loadState = this.modelLoadStates.get(uriString);
    if (!loadState) {
      loadState = { isLoading: true };
      loadState.promise = new Promise((resolve, reject) => {
        loadState!.resolve = resolve;
        loadState!.reject = reject;
      });
      this.modelLoadStates.set(uriString, loadState);
    }
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Model content load timeout: ${filePath}`)), timeout);
    });
    
    try {
      await Promise.race([loadState.promise, timeoutPromise]);
    } catch (error) {
      log.error('Failed to wait for model content', { filePath, error });
      throw error;
    }
  }
  
  private markLoadingComplete(uriString: string): void {
    const loadState = this.modelLoadStates.get(uriString);
    if (loadState && loadState.resolve) {
      loadState.resolve();
      loadState.isLoading = false;
    }
  }
  
  public normalizeUri(filePath: string): monaco.Uri {
    if (filePath.startsWith('openbitfun-document:')) return monacoApi.Uri.parse(filePath);
    try {
      if (filePath.includes('%')) {
        filePath = decodeURIComponent(filePath);
      }
    } catch (err) {
      log.warn('Failed to decode path', { filePath, error: err });
    }
    
    let normalizedPath = filePath.replace(/\\/g, '/');
    
    if (normalizedPath.match(/^[a-zA-Z]:/)) {
      normalizedPath = normalizedPath.charAt(0).toLowerCase() + normalizedPath.slice(1);
    }
    
    return monacoApi.Uri.file(normalizedPath);
  }
  
  public getStatistics(): {
    totalModels: number;
    activeModels: number;
    dirtyModels: number;
    totalReferences: number;
  } {
    let activeModels = 0;
    let dirtyModels = 0;
    let totalReferences = 0;
    
    this.modelMetadata.forEach((metadata) => {
      if (metadata.referenceCount > 0) {
        activeModels++;
      }
      if (metadata.isDirty) {
        dirtyModels++;
      }
      totalReferences += metadata.referenceCount;
    });
    
    return {
      totalModels: this.modelMetadata.size,
      activeModels,
      dirtyModels,
      totalReferences
    };
  }
  
  public setDisposalDelay(delay: number): void {
    this.disposalDelay = Math.max(0, delay);
  }
  
  public cleanupUnusedModels(): void {
    const toDispose: string[] = [];
    this.modelMetadata.forEach((metadata, uri) => {
      if (metadata.referenceCount === 0 && !this.documentModels.has(uri)) {
        toDispose.push(uri);
      }
    });
    
    toDispose.forEach(uri => this.disposeModel(uri));
  }
  
  public onModelCreated(listener: EventListener<ModelCreatedEvent>): () => void {
    this.modelCreatedListeners.push(listener);
    return () => {
      const index = this.modelCreatedListeners.indexOf(listener);
      if (index > -1) {
        this.modelCreatedListeners.splice(index, 1);
      }
    };
  }
  
  public onModelContentChanged(listener: EventListener<ModelContentChangedEvent>): () => void {
    this.modelContentChangedListeners.push(listener);
    return () => {
      const index = this.modelContentChangedListeners.indexOf(listener);
      if (index > -1) {
        this.modelContentChangedListeners.splice(index, 1);
      }
    };
  }
  
  public onModelDisposed(listener: EventListener<ModelDisposedEvent>): () => void {
    this.modelDisposedListeners.push(listener);
    return () => {
      const index = this.modelDisposedListeners.indexOf(listener);
      if (index > -1) {
        this.modelDisposedListeners.splice(index, 1);
      }
    };
  }
  
  public onModelContentReady(listener: EventListener<ModelContentReadyEvent>): () => void {
    this.modelContentReadyListeners.push(listener);
    return () => {
      const index = this.modelContentReadyListeners.indexOf(listener);
      if (index > -1) {
        this.modelContentReadyListeners.splice(index, 1);
      }
    };
  }
  
  private emitModelCreated(event: ModelCreatedEvent): void {
    this.modelCreatedListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in modelCreated listener', error);
      }
    });
  }
  
  private emitModelContentChanged(event: ModelContentChangedEvent): void {
    this.modelContentChangedListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in modelContentChanged listener', error);
      }
    });
  }
  
  private emitModelDisposed(event: ModelDisposedEvent): void {
    this.modelDisposedListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in modelDisposed listener', error);
      }
    });
  }
  
  private emitModelContentReady(event: ModelContentReadyEvent): void {
    this.modelContentReadyListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in modelContentReady listener', error);
      }
    });
  }
}

export const monacoModelManager = MonacoModelManager.getInstance();
export default MonacoModelManager;

export { monacoModelManager as monacoGlobalManager };
export { MonacoModelManager as MonacoGlobalManager };
