import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { fileSystemService } from '@/tools/file-system/services/FileSystemService';
import { ideControl } from '@/shared/services/ide-control';
import { createLogger } from '@/shared/utils/logger';
import {
  EMPTY_IDENTITY_DOCUMENT,
  getIdentityFilePath,
  parseIdentityDocument,
  serializeIdentityDocument,
  type IdentityDocument,
} from './identityDocument';

const log = createLogger('AgentIdentityDocument');
const AUTOSAVE_DEBOUNCE_MS = 800;
const WATCHER_RELOAD_DEBOUNCE_MS = 300;
const SELF_WRITE_SUPPRESS_MS = 1200;

export type IdentitySaveStatus =
  | 'idle'
  | 'loading'
  | 'saving'
  | 'saved'
  | 'error'
  | 'external-update';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isFileMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|no such file|not found/i.test(message);
}

export interface UseAgentIdentityDocumentResult {
  identityFilePath: string;
  document: IdentityDocument;
  originalDocument: IdentityDocument;
  loading: boolean;
  error: string | null;
  saveStatus: IdentitySaveStatus;
  hasUnsavedChanges: boolean;
  hasExternalUpdate: boolean;
  updateField: <K extends keyof IdentityDocument>(field: K, value: IdentityDocument[K]) => void;
  reload: () => Promise<void>;
  openInEditor: () => Promise<void>;
  resetPersonaFiles: () => Promise<void>;
}

/// The assistant workspace that owns IDENTITY.md. The ID selects the
/// workspace for every file command; the root path only builds the file path
/// and scopes the change watcher.
export interface AgentIdentityWorkspaceRef {
  id: string;
  rootPath: string;
}

export function useAgentIdentityDocument(
  workspace: AgentIdentityWorkspaceRef | null
): UseAgentIdentityDocumentResult {
  const workspaceId = workspace?.id ?? '';
  const workspacePath = workspace?.rootPath ?? '';
  const identityFilePath = useMemo(
    () => (workspaceId && workspacePath ? getIdentityFilePath(workspacePath) : ''),
    [workspaceId, workspacePath]
  );

  const [document, setDocument] = useState<IdentityDocument>(EMPTY_IDENTITY_DOCUMENT);
  const [originalDocument, setOriginalDocument] = useState<IdentityDocument>(EMPTY_IDENTITY_DOCUMENT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<IdentitySaveStatus>('idle');
  const [hasExternalUpdate, setHasExternalUpdate] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressWatcherUntilRef = useRef(0);
  const mountedRef = useRef(true);
  const hasUnsavedChangesRef = useRef(false);

  const serializedDocument = useMemo(() => serializeIdentityDocument(document), [document]);
  const serializedOriginal = useMemo(
    () => serializeIdentityDocument(originalDocument),
    [originalDocument]
  );
  const hasUnsavedChanges = serializedDocument !== serializedOriginal;

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (watchReloadTimerRef.current) {
        clearTimeout(watchReloadTimerRef.current);
      }
    };
  }, []);

  const loadDocument = useCallback(async () => {
    if (!workspaceId || !identityFilePath) {
      if (!mountedRef.current) return;
      setDocument(EMPTY_IDENTITY_DOCUMENT);
      setOriginalDocument(EMPTY_IDENTITY_DOCUMENT);
      setError(null);
      setHasExternalUpdate(false);
      setSaveStatus('idle');
      return;
    }

    if (mountedRef.current) {
      setLoading(true);
      setError(null);
      setSaveStatus('loading');
    }

    try {
      const content = await workspaceAPI.readWorkspaceFile(workspaceId, identityFilePath);
      const parsed = parseIdentityDocument(content);

      if (!mountedRef.current) {
        return;
      }

      setDocument(parsed);
      setOriginalDocument(parsed);
      setHasExternalUpdate(false);
      setSaveStatus('idle');
    } catch (loadError) {
      if (!mountedRef.current) {
        return;
      }

      if (isFileMissingError(loadError)) {
        setDocument(EMPTY_IDENTITY_DOCUMENT);
        setOriginalDocument(EMPTY_IDENTITY_DOCUMENT);
        setHasExternalUpdate(false);
        setSaveStatus('idle');
        setError(null);
      } else {
        log.error('Failed to load identity document', { workspacePath, identityFilePath, error: loadError });
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setSaveStatus('error');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [identityFilePath, workspacePath, workspaceId]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  const saveDocument = useCallback(async () => {
    if (!workspaceId || !identityFilePath || !hasUnsavedChangesRef.current) {
      return;
    }

    setSaveStatus('saving');

    try {
      await workspaceAPI.writeWorkspaceFile(workspaceId, identityFilePath, serializedDocument);
      suppressWatcherUntilRef.current = Date.now() + SELF_WRITE_SUPPRESS_MS;

      if (!mountedRef.current) {
        return;
      }

      setOriginalDocument(document);
      setHasExternalUpdate(false);
      setError(null);
      setSaveStatus('saved');
    } catch (saveError) {
      if (!mountedRef.current) {
        return;
      }

      log.error('Failed to save identity document', { workspaceId, identityFilePath, error: saveError });
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setSaveStatus('error');
    }
  }, [document, identityFilePath, serializedDocument, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !identityFilePath || !hasUnsavedChanges) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveDocument();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [hasUnsavedChanges, identityFilePath, saveDocument, workspaceId]);

  useEffect(() => {
    if (saveStatus !== 'saved') {
      return;
    }

    const clearSavedStatus = setTimeout(() => {
      if (mountedRef.current) {
        setSaveStatus((currentStatus) => (currentStatus === 'saved' ? 'idle' : currentStatus));
      }
    }, 1500);

    return () => clearTimeout(clearSavedStatus);
  }, [saveStatus]);

  useEffect(() => {
    if (!workspacePath || !identityFilePath) {
      return;
    }

    const normalizedIdentityPath = normalizePath(identityFilePath);

    const unwatch = fileSystemService.watchFileChanges(workspacePath, (event) => {
      const eventPath = normalizePath(event.path);
      const oldPath = event.oldPath ? normalizePath(event.oldPath) : null;
      const matchesIdentity =
        eventPath === normalizedIdentityPath || oldPath === normalizedIdentityPath;

      if (!matchesIdentity) {
        return;
      }

      if (Date.now() < suppressWatcherUntilRef.current) {
        return;
      }

      if (hasUnsavedChangesRef.current) {
        setHasExternalUpdate(true);
        setSaveStatus('external-update');
        return;
      }

      if (watchReloadTimerRef.current) {
        clearTimeout(watchReloadTimerRef.current);
      }

      watchReloadTimerRef.current = setTimeout(() => {
        void loadDocument();
      }, WATCHER_RELOAD_DEBOUNCE_MS);
    });

    return () => {
      unwatch();
      if (watchReloadTimerRef.current) {
        clearTimeout(watchReloadTimerRef.current);
      }
    };
  }, [identityFilePath, loadDocument, workspacePath]);

  const updateField = useCallback(
    <K extends keyof IdentityDocument>(field: K, value: IdentityDocument[K]) => {
      setDocument((previous) => ({ ...previous, [field]: value }));
      if (saveStatus === 'external-update' || saveStatus === 'error') {
        setError(null);
        setSaveStatus('idle');
      }
    },
    [saveStatus]
  );

  const openInEditor = useCallback(async () => {
    if (!identityFilePath) {
      return;
    }

    await ideControl.navigation.goToFile(identityFilePath);
  }, [identityFilePath]);

  const resetPersonaFiles = useCallback(async () => {
    if (!workspaceId) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setSaveStatus('loading');
    setError(null);

    try {
      await workspaceAPI.resetWorkspacePersonaFiles(workspaceId);
      suppressWatcherUntilRef.current = Date.now() + SELF_WRITE_SUPPRESS_MS;
      await loadDocument();
    } catch (resetError) {
      log.error('Failed to reset workspace persona files', { workspaceId, error: resetError });
      if (mountedRef.current) {
        setError(resetError instanceof Error ? resetError.message : String(resetError));
        setSaveStatus('error');
      }
      throw resetError;
    }
  }, [loadDocument, workspaceId]);

  return {
    identityFilePath,
    document,
    originalDocument,
    loading,
    error,
    saveStatus,
    hasUnsavedChanges,
    hasExternalUpdate,
    updateField,
    reload: loadDocument,
    openInEditor,
    resetPersonaFiles,
  };
}
