/**
 * Unified chat context picker.
 * The source level exposes files, skills, MCP, and images; typing searches providers together.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Icon,
  IconButton,
  KeyHint,
  Listbox,
  ListboxEmpty,
  ListboxOption,
  OverflowText,
  Tooltip,
} from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { File, Loader2, MessageCircle, Plug, RotateCcw } from 'lucide-react';
import { sessionAPI, workspaceAPI } from '@/infrastructure/api';
import {
  externalSourcesAPI,
  type WorkspaceReferenceEntry,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import type {
  ExplorerNodeDto,
  FileSearchResultGroup,
} from '@/infrastructure/api/service-api/tauri-commands';
import type { SessionReferenceCandidate } from '@/infrastructure/api/service-api/SessionAPI';
import type {
  DirectoryContext,
  FileContext,
  SessionReferenceContext,
} from '@/shared/types/context';
import { createLogger } from '@/shared/utils/logger';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import {
  workspaceReferenceItems,
  type FileItem,
} from './workspaceReferenceItems';
import type { SkillScanDiagnostic } from '@/infrastructure/config/types';
import type { ChatMcpCatalog } from '@/infrastructure/api/service-api/ChatMcpAPI';
import { chatMcpItems, type ContextPickerMcpItem } from './chatMcpItems';
import './ChatContextPicker.scss';

const log = createLogger('ChatContextPicker');
const CONTEXT_PICKER_SEARCH_DEBOUNCE_MS = 300;
const CONTEXT_PICKER_MAX_RESULTS = 30;

export interface ChatContextPickerProps {
  isOpen: boolean;
  searchQuery: string;
  workspacePath?: string;
  workspaceId?: string;
  /** Disambiguates identical POSIX workspace paths on different remote hosts. */
  remoteConnectionId?: string;
  /** The composing session itself must not appear as a reference candidate. */
  excludeSessionId?: string;
  onSelectContext: (context: FileContext | DirectoryContext | SessionReferenceContext) => void;
  onClose: () => void;
  /** Anchor used by the default portalled overlay mode. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  position?: { top: number; left: number };
  /** Controls whether the picker opens at its source level or directly in files. */
  entryView?: ChatContextPickerEntryView;
  skills?: readonly ContextPickerSkill[];
  skillsLoading?: boolean;
  skillsLoadFailed?: boolean;
  skillDiagnostics?: readonly SkillScanDiagnostic[];
  skillDiagnosticsAvailable?: boolean;
  onRetrySkills?: () => void;
  onSelectSkill?: (skill: ContextPickerSkill) => void;
  mcpCatalog?: ChatMcpCatalog;
  mcpLoading?: boolean;
  mcpLoadFailed?: boolean;
  mcpUnavailable?: 'remoteWorkspace' | 'unsupportedHost';
  onRefreshMcp?: () => void;
  onSelectMcp?: (item: ContextPickerMcpItem) => void;
  onAddImage?: () => void;
}

export interface ContextPickerSkill {
  key: string;
  name: string;
  description?: string;
  argumentHint?: string | null;
  /** Winner selected by the host registry after source precedence and mode policy. */
  selectedForRuntime?: boolean;
}

export type ChatContextPickerEntryView = 'sources' | 'files';

type ContextPickerView = ChatContextPickerEntryView | 'skills' | 'mcp';

type ContextPickerItem =
  | { kind: 'file'; item: FileItem }
  | { kind: 'session'; item: SessionReferenceCandidate }
  | { kind: 'skill'; item: ContextPickerSkill }
  | { kind: 'mcp'; item: ContextPickerMcpItem }
  | { kind: 'source'; id: 'files' | 'skills' | 'mcp' }
  | { kind: 'action'; id: 'add-image' | 'retry-skills' };

function mergeFileSearchResults(
  previous: FileItem[],
  groups: FileSearchResultGroup[],
  getRelativePath: (path: string) => string,
): FileItem[] {
  const byPath = new Map(previous.map(item => [item.path, item]));
  for (const group of groups) {
    const result = group.fileNameMatch;
    if (!result) continue;
    byPath.set(result.path, {
      path: result.path,
      name: result.name,
      isDirectory: result.isDirectory || false,
      relativePath: getRelativePath(result.path),
    });
  }

  return Array.from(byPath.values())
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, CONTEXT_PICKER_MAX_RESULTS);
}

export const ChatContextPicker: React.FC<ChatContextPickerProps> = ({
  isOpen,
  searchQuery,
  workspacePath,
  workspaceId,
  remoteConnectionId,
  excludeSessionId,
  onSelectContext,
  onClose,
  anchorRef,
  position,
  entryView = 'files',
  skills = [],
  skillsLoading = false,
  skillsLoadFailed = false,
  skillDiagnostics = [],
  skillDiagnosticsAvailable = true,
  onRetrySkills,
  onSelectSkill,
  mcpCatalog,
  mcpLoading = false,
  mcpLoadFailed = false,
  mcpUnavailable,
  onRefreshMcp,
  onSelectMcp,
  onAddImage,
}) => {
  const { t } = useTranslation('flow-chat');
  const [results, setResults] = useState<FileItem[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionReferenceCandidate[]>([]);
  const [workspaceReferences, setWorkspaceReferences] = useState<WorkspaceReferenceEntry[]>([]);
  const [currentFiles, setCurrentFiles] = useState<FileItem[]>([]);
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);
  const [isFileSearchLoading, setIsFileSearchLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [directoryLoadError, setDirectoryLoadError] = useState(false);
  const [fileSearchError, setFileSearchError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<ContextPickerView>(entryView);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackAnchorRef = useRef<HTMLElement>(null);
  const fileAbortControllerRef = useRef<AbortController | null>(null);
  const fileSearchDebounceTimerRef = useRef<number | null>(null);
  const sessionSearchDebounceTimerRef = useRef<number | null>(null);
  const selectedItemHistoryRef = useRef<string[]>([]);
  const targetSelectedPathRef = useRef<string | null>(null);
  const directoryLoadRequestIdRef = useRef(0);
  const fileSearchRequestIdRef = useRef(0);
  const sessionSearchRequestIdRef = useRef(0);
  const workspaceReferenceRequestIdRef = useRef(0);
  const skipNextPathLoadRef = useRef(false);

  const getRelativePath = useCallback((fullPath: string): string => {
    if (!workspacePath) return fullPath;
    const normalizedWorkspace = workspacePath.replace(/\\/g, '/');
    const normalizedPath = fullPath.replace(/\\/g, '/');
    if (normalizedPath.startsWith(normalizedWorkspace)) {
      return normalizedPath.slice(normalizedWorkspace.length).replace(/^\//, '');
    }
    return fullPath;
  }, [workspacePath]);

  const loadDirectory = useCallback(async (dirPath: string, targetSelectedPath?: string | null) => {
    if (!workspacePath) {
      setCurrentFiles([]);
      setIsDirectoryLoading(false);
      setDirectoryLoadError(false);
      return;
    }

    const requestId = ++directoryLoadRequestIdRef.current;
    setIsDirectoryLoading(true);
    setDirectoryLoadError(false);
    try {
      const children = await workspaceAPI.getDirectoryChildren(
        dirPath || workspacePath,
        remoteConnectionId,
      );
      const items: FileItem[] = children
        .filter((entry: ExplorerNodeDto) => {
          const name = entry.name || '';
          return !name.startsWith('.') &&
            !['node_modules', 'target', 'dist', 'build', '__pycache__'].includes(name);
        })
        .map((entry: ExplorerNodeDto) => ({
          path: entry.path,
          name: entry.name,
          isDirectory: entry.isDirectory || false,
          relativePath: getRelativePath(entry.path),
        }));
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      if (requestId !== directoryLoadRequestIdRef.current) return;
      setCurrentFiles(items);
      const targetIndex = targetSelectedPath
        ? items.findIndex(item => item.path === targetSelectedPath)
        : 0;
      setSelectedIndex(targetIndex >= 0 ? targetIndex : 0);
    } catch (error) {
      log.error('Failed to load directory', error);
      if (requestId === directoryLoadRequestIdRef.current) {
        setCurrentFiles([]);
        setDirectoryLoadError(true);
      }
    } finally {
      if (requestId === directoryLoadRequestIdRef.current) setIsDirectoryLoading(false);
    }
  }, [workspacePath, remoteConnectionId, getRelativePath]);

  const enterDirectory = useCallback((item: FileItem) => {
    if (!item.isDirectory) return;
    selectedItemHistoryRef.current = [...selectedItemHistoryRef.current, item.path];
    setPathHistory(previous => [...previous, currentPath]);
    setCurrentPath(item.path);
  }, [currentPath]);

  const goBack = useCallback(() => {
    if (pathHistory.length > 0) {
      const previousPath = pathHistory[pathHistory.length - 1];
      targetSelectedPathRef.current = selectedItemHistoryRef.current.length > 0
        ? selectedItemHistoryRef.current[selectedItemHistoryRef.current.length - 1]
        : null;
      selectedItemHistoryRef.current = selectedItemHistoryRef.current.slice(0, -1);
      setPathHistory(previous => previous.slice(0, -1));
      setCurrentPath(previousPath);
      return;
    }

    if (entryView === 'sources' && view !== 'sources') {
      setView('sources');
      setSelectedIndex(0);
    }
  }, [entryView, pathHistory, view]);

  useEffect(() => {
    if (!isOpen) return;
    // Suppress the path effect once while the picker resets from its previous
    // view. Direct file entry is loaded explicitly below.
    skipNextPathLoadRef.current = true;
    setView(entryView);
    setCurrentPath('');
    setPathHistory([]);
    setCurrentFiles([]);
    setResults([]);
    setSessionResults([]);
    setDirectoryLoadError(false);
    setFileSearchError(false);
    setSelectedIndex(0);
    selectedItemHistoryRef.current = [];
    targetSelectedPathRef.current = null;
    if (entryView === 'sources' || !workspacePath) {
      setIsDirectoryLoading(false);
    } else {
      loadDirectory('', null);
    }
  }, [entryView, isOpen, workspacePath, remoteConnectionId, loadDirectory]);

  useEffect(() => {
    if (isOpen && view === 'sources') {
      skipNextPathLoadRef.current = false;
    }
  }, [isOpen, view]);

  useEffect(() => {
    if (!isOpen || !workspacePath) {
      workspaceReferenceRequestIdRef.current += 1;
      setWorkspaceReferences([]);
      return;
    }
    const requestId = ++workspaceReferenceRequestIdRef.current;
    void externalSourcesAPI
      .getWorkspaceReferences(workspacePath, workspaceId)
      .then(snapshot => {
        if (requestId === workspaceReferenceRequestIdRef.current) {
          setWorkspaceReferences(snapshot.references);
        }
      })
      .catch(() => {
        if (requestId === workspaceReferenceRequestIdRef.current) {
          setWorkspaceReferences([]);
        }
      });
  }, [isOpen, workspaceId, workspacePath]);

  useEffect(() => {
    if (!isOpen || view !== 'files' || searchQuery.trim()) return;
    if (skipNextPathLoadRef.current) {
      skipNextPathLoadRef.current = false;
      return;
    }
    const targetPath = targetSelectedPathRef.current;
    targetSelectedPathRef.current = null;
    loadDirectory(currentPath, targetPath);
  }, [currentPath, isOpen, loadDirectory, searchQuery, view]);

  const searchFiles = useCallback(async (
    query: string,
    controller: AbortController,
    requestId: number,
  ) => {
    if (!workspacePath) {
      setResults([]);
      setIsFileSearchLoading(false);
      return;
    }
    try {
      await workspaceAPI.searchFilenamesOnlyStreamDetailed(
        workspacePath,
        query,
        false,
        false,
        false,
        undefined,
        CONTEXT_PICKER_MAX_RESULTS,
        true,
        {
          onProgress: (event) => {
            if (
              requestId !== fileSearchRequestIdRef.current
              || controller.signal.aborted
            ) return;

            setResults(previous => mergeFileSearchResults(previous, event.results, getRelativePath));
          },
        },
        controller.signal,
        remoteConnectionId,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        log.error('Context picker file search failed', error);
        if (requestId === fileSearchRequestIdRef.current) setFileSearchError(true);
      }
    } finally {
      if (requestId === fileSearchRequestIdRef.current && fileAbortControllerRef.current === controller) {
        fileAbortControllerRef.current = null;
        setIsFileSearchLoading(false);
      }
    }
  }, [workspacePath, remoteConnectionId, getRelativePath]);

  useEffect(() => {
    if (!isOpen) return;
    if (fileSearchDebounceTimerRef.current !== null) {
      window.clearTimeout(fileSearchDebounceTimerRef.current);
      fileSearchDebounceTimerRef.current = null;
    }
    fileAbortControllerRef.current?.abort();
    fileAbortControllerRef.current = null;

    const query = searchQuery.trim();
    if (!query) {
      fileSearchRequestIdRef.current += 1;
      setResults([]);
      setSelectedIndex(0);
      setIsFileSearchLoading(false);
      setFileSearchError(false);
      return;
    }

    const requestId = ++fileSearchRequestIdRef.current;
    const controller = new AbortController();
    fileAbortControllerRef.current = controller;
    setResults([]);
    setSelectedIndex(0);
    setIsFileSearchLoading(true);
    setFileSearchError(false);
    fileSearchDebounceTimerRef.current = window.setTimeout(() => {
      fileSearchDebounceTimerRef.current = null;
      void searchFiles(query, controller, requestId);
    }, CONTEXT_PICKER_SEARCH_DEBOUNCE_MS);
    return () => {
      if (fileSearchDebounceTimerRef.current !== null) {
        window.clearTimeout(fileSearchDebounceTimerRef.current);
        fileSearchDebounceTimerRef.current = null;
      }
      controller.abort();
    };
  }, [isOpen, searchQuery, searchFiles]);

  useEffect(() => {
    if (sessionSearchDebounceTimerRef.current !== null) {
      window.clearTimeout(sessionSearchDebounceTimerRef.current);
      sessionSearchDebounceTimerRef.current = null;
    }
    const query = searchQuery.trim();
    if (!isOpen || !query) {
      sessionSearchRequestIdRef.current += 1;
      setSessionResults([]);
      setIsSessionLoading(false);
      return;
    }

    const requestId = ++sessionSearchRequestIdRef.current;
    setIsSessionLoading(true);
    sessionSearchDebounceTimerRef.current = window.setTimeout(() => {
      sessionSearchDebounceTimerRef.current = null;
      void sessionAPI.searchReferenceableSessions(query, CONTEXT_PICKER_MAX_RESULTS)
        .then((items) => {
          if (requestId === sessionSearchRequestIdRef.current) {
            setSessionResults(items.filter(item => item.sessionId !== excludeSessionId));
          }
        })
        .catch((error) => {
          log.error('Context picker session search failed', error);
          if (requestId === sessionSearchRequestIdRef.current) setSessionResults([]);
        })
        .finally(() => {
          if (requestId === sessionSearchRequestIdRef.current) setIsSessionLoading(false);
        });
    }, CONTEXT_PICKER_SEARCH_DEBOUNCE_MS);
    return () => {
      if (sessionSearchDebounceTimerRef.current !== null) {
        window.clearTimeout(sessionSearchDebounceTimerRef.current);
        sessionSearchDebounceTimerRef.current = null;
      }
    };
  }, [excludeSessionId, isOpen, searchQuery]);

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const isSearchMode = normalizedSearchQuery.length > 0;
  const isFileLoading = isSearchMode
    ? isFileSearchLoading
    : view === 'files' && isDirectoryLoading;
  const fileLoadError = isSearchMode
    ? (fileSearchError ? 'search' : null)
    : (view === 'files' && directoryLoadError ? 'directory' : null);
  const referenceItems = useMemo(
    () => workspaceReferenceItems(workspaceReferences, isSearchMode ? searchQuery : ''),
    [isSearchMode, searchQuery, workspaceReferences],
  );
  const filteredSkills = useMemo(() => {
    const seenNames = new Set<string>();
    return skills
      .filter(skill => {
        const normalizedName = skill.name.trim().toLocaleLowerCase();
        if (skill.selectedForRuntime === false || !normalizedName || seenNames.has(skill.name)) return false;
        seenNames.add(skill.name);
        if (!normalizedSearchQuery) return true;
        return [skill.name, skill.description, skill.argumentHint]
          .filter((value): value is string => Boolean(value?.trim()))
          .some(value => value.toLocaleLowerCase().includes(normalizedSearchQuery));
      })
      .sort((a, b) => {
        const aName = a.name.toLocaleLowerCase();
        const bName = b.name.toLocaleLowerCase();
        const aRank = aName === normalizedSearchQuery
          ? 0
          : aName.startsWith(normalizedSearchQuery) ? 1 : 2;
        const bRank = bName === normalizedSearchQuery
          ? 0
          : bName.startsWith(normalizedSearchQuery) ? 1 : 2;
        return aRank - bRank || aName.localeCompare(bName);
      });
  }, [normalizedSearchQuery, skills]);
  const sourceItems = useMemo<ContextPickerItem[]>(() => [
    { kind: 'source', id: 'files' },
    ...(onSelectSkill ? [{ kind: 'source' as const, id: 'skills' as const }] : []),
    ...(onSelectMcp ? [{ kind: 'source' as const, id: 'mcp' as const }] : []),
    ...(onAddImage ? [{ kind: 'action' as const, id: 'add-image' as const }] : []),
  ], [onAddImage, onSelectSkill, onSelectMcp]);
  const mcpItems = useMemo<ContextPickerItem[]>(() => (
    onSelectMcp && !mcpLoading && !mcpLoadFailed && !mcpUnavailable
      ? chatMcpItems(mcpCatalog?.tools ?? [], searchQuery).map(item => ({ kind: 'mcp', item }))
      : []
  ), [onSelectMcp, mcpLoading, mcpLoadFailed, mcpUnavailable, mcpCatalog, searchQuery]);
  const skillItems = useMemo<ContextPickerItem[]>(() => {
    if (skillsLoading) return [];
    if (skillsLoadFailed) {
      return onRetrySkills ? [{ kind: 'action', id: 'retry-skills' }] : [];
    }
    return filteredSkills.map(item => ({ kind: 'skill', item }));
  }, [filteredSkills, onRetrySkills, skillsLoadFailed, skillsLoading]);
  const displayItems = useMemo<ContextPickerItem[]>(() => {
    if (isSearchMode) {
      const addImageMatches = Boolean(onAddImage)
        && t('input.addImage').toLocaleLowerCase().includes(normalizedSearchQuery);
      return [
        ...results.map(item => ({ kind: 'file' as const, item })),
        ...referenceItems.map(item => ({ kind: 'file' as const, item })),
        ...(onSelectSkill
          ? filteredSkills.map(item => ({ kind: 'skill' as const, item }))
          : []),
        ...sessionResults.map(item => ({ kind: 'session' as const, item })),
        ...mcpItems,
        ...(onSelectSkill && skillsLoadFailed && onRetrySkills
          ? [{ kind: 'action' as const, id: 'retry-skills' as const }]
          : []),
        ...(addImageMatches
          ? [{ kind: 'action' as const, id: 'add-image' as const }]
          : []),
      ];
    }
    if (entryView === 'sources' && view === 'sources') return sourceItems;
    if (view === 'skills') return skillItems;
    if (view === 'mcp') return mcpItems;
    return [
      ...currentFiles.map(item => ({ kind: 'file' as const, item })),
      ...(currentPath ? [] : referenceItems.map(item => ({ kind: 'file' as const, item }))),
    ];
  }, [
    currentFiles,
    currentPath,
    filteredSkills,
    isSearchMode,
    normalizedSearchQuery,
    onAddImage,
    onRetrySkills,
    onSelectSkill,
    referenceItems,
    results,
    sourceItems,
    sessionResults,
    entryView,
    skillItems,
    mcpItems,
    skillsLoadFailed,
    t,
    view,
  ]);
  const currentDirectoryPath = useMemo(() => {
    if (!workspacePath) {
      return t('contextPicker.rootDirectory');
    }

    const normalizedWorkspace = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const workspaceName = normalizedWorkspace.split('/').pop() || t('contextPicker.rootDirectory');
    const directorySegments = [workspaceName];

    if (currentPath) {
      const relativeCurrentPath = getRelativePath(currentPath)
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      if (relativeCurrentPath) directorySegments.push(...relativeCurrentPath.split('/').filter(Boolean));
    }

    return directorySegments.join('/');
  }, [currentPath, getRelativePath, t, workspacePath]);
  const currentDirectoryTailStart = Math.max(0, currentDirectoryPath.lastIndexOf('/'));
  const currentViewLabel = view === 'skills'
    ? t('chatInput.boostSkills')
    : view === 'mcp'
      ? t('contextPicker.mcp.label')
    : view === 'sources'
      ? t('contextPicker.menuTitle')
      : currentDirectoryPath;
  const canNavigateBack = !isSearchMode && (
    pathHistory.length > 0 || (entryView === 'sources' && view !== 'sources')
  );
  const isOverlay = Boolean(anchorRef) && !position;
  const overlayLayout = useAnchoredPopoverPosition({
    open: isOpen && isOverlay,
    anchorRef: anchorRef ?? fallbackAnchorRef,
    popoverRef: containerRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 8,
    layoutRevision: `${displayItems.length}:${view}:${currentPath}:${isSearchMode}`,
  });

  useEffect(() => () => {
    if (fileSearchDebounceTimerRef.current !== null) window.clearTimeout(fileSearchDebounceTimerRef.current);
    if (sessionSearchDebounceTimerRef.current !== null) window.clearTimeout(sessionSearchDebounceTimerRef.current);
    fileAbortControllerRef.current?.abort();
  }, []);

  const openSource = useCallback((source: Extract<ContextPickerItem, { kind: 'source' }>['id']) => {
    setView(source);
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    if (view === 'mcp' && !onSelectMcp) {
      setView('sources');
      setSelectedIndex(0);
    }
  }, [onSelectMcp, view]);

  const handleSelect = useCallback((selection: ContextPickerItem) => {
    if (selection.kind === 'source') {
      openSource(selection.id);
      return;
    }
    if (selection.kind === 'action') {
      if (selection.id === 'retry-skills') {
        onRetrySkills?.();
        return;
      }
      onAddImage?.();
      onClose();
      return;
    }
    if (selection.kind === 'skill') {
      onSelectSkill?.(selection.item);
      onClose();
      return;
    }
    if (selection.kind === 'mcp') {
      onSelectMcp?.(selection.item);
      onClose();
      return;
    }

    const timestamp = Date.now();
    if (selection.kind === 'session') {
      const session = selection.item;
      onSelectContext({
        id: `session-reference-${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'session-reference',
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        workspacePath: session.workspacePath,
        remoteConnectionId: session.remoteConnectionId,
        remoteSshHost: session.remoteSshHost,
        workspaceLabel: session.workspaceLabel,
        timestamp,
      });
      onClose();
      return;
    }

    const item = selection.item;
    onSelectContext(item.isDirectory ? {
      id: `dir-${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'directory',
      directoryPath: item.path,
      directoryName: item.name,
      recursive: true,
      timestamp,
    } : {
      id: `file-${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'file',
      filePath: item.path,
      fileName: item.name,
      relativePath: item.relativePath,
      timestamp,
    });
    onClose();
  }, [onAddImage, onClose, onRetrySkills, onSelectContext, onSelectSkill, onSelectMcp, openSource]);

  const handleItemClick = useCallback((selection: ContextPickerItem) => {
    if (selection.kind === 'file' && selection.item.isDirectory && !isSearchMode) {
      enterDirectory(selection.item);
      return;
    }
    handleSelect(selection);
  }, [enterDirectory, handleSelect, isSearchMode]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!isOpen) return;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        event.stopPropagation();
        if (displayItems.length > 0) {
          setSelectedIndex(previous => event.key === 'ArrowUp'
            ? (previous > 0 ? previous - 1 : displayItems.length - 1)
            : (previous < displayItems.length - 1 ? previous + 1 : 0));
        }
        break;
      }
      case 'ArrowRight': {
        const selected = displayItems[selectedIndex];
        if (isSearchMode || !selected) break;
        if (selected.kind !== 'source'
          && !(selected.kind === 'file' && selected.item.isDirectory)) break;
        event.preventDefault();
        event.stopPropagation();
        if (selected.kind === 'source') openSource(selected.id);
        if (selected.kind === 'file') enterDirectory(selected.item);
        break;
      }
      case 'ArrowLeft': {
        if (!canNavigateBack) break;
        event.preventDefault();
        event.stopPropagation();
        goBack();
        break;
      }
      case 'Enter':
      case 'Tab': {
        event.preventDefault();
        event.stopPropagation();
        const selected = displayItems[selectedIndex];
        if (selected) {
          if (event.key === 'Tab' && selected.kind !== 'source') handleSelect(selected);
          else handleItemClick(selected);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  }, [canNavigateBack, displayItems, enterDirectory, goBack, handleItemClick, handleSelect, isOpen, isSearchMode, onClose, openSource, selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!containerRef.current || displayItems.length === 0) return;
    containerRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [displayItems, selectedIndex]);

  if (!isOpen) return null;
  const style: React.CSSProperties = position
    ? { position: 'absolute', top: position.top, left: position.left }
    : isOverlay
      ? {
          top: `${overlayLayout?.top ?? 0}px`,
          left: `${overlayLayout?.left ?? 0}px`,
          visibility: overlayLayout ? 'visible' : 'hidden',
        }
      : {};
  const isSkillLoading = Boolean(onSelectSkill)
    && skillsLoading
    && (isSearchMode || view === 'skills');
  const showMcpStatus = Boolean(onSelectMcp) && (view === 'mcp' || isSearchMode);
  const isLoading = isFileLoading || isSessionLoading || isSkillLoading || (showMcpStatus && mcpLoading);
  const mcpStatus = mcpLoadFailed ? t('contextPicker.mcp.loadFailed')
    : mcpUnavailable === 'remoteWorkspace' ? t('contextPicker.mcp.remoteWorkspace')
    : mcpUnavailable === 'unsupportedHost' ? t('contextPicker.mcp.unsupportedHost')
    : mcpCatalog?.modeRestricted ? t('contextPicker.mcp.modeRestricted')
    : null;
  const emptyLabel = isSearchMode
    ? t('contextPicker.noMatchingResults')
    : view === 'skills'
      ? t('chatInput.boostSkillsEmpty')
      : view === 'mcp'
        ? mcpStatus ?? t('contextPicker.mcp.empty')
      : t('contextPicker.emptyDirectory');

  const picker = (
    <div
      data-openbitfun-component="chat-context-picker"
      data-openbitfun-part="root"
      data-openbitfun-state={[
        isLoading && 'loading',
        (fileLoadError || (showMcpStatus && mcpLoadFailed)) && 'error',
      ].filter(Boolean).join(' ') || undefined}
      data-openbitfun-placement={isOverlay ? overlayLayout?.placement ?? 'top' : undefined}
      ref={containerRef}
      className={`chat-context-picker${isOverlay ? ' chat-context-picker--overlay' : ''}${displayItems.some(item => item.kind === 'skill') ? ' chat-context-picker--skills' : ''}`}
      style={style}
      onMouseDown={event => event.preventDefault()}
    >
      <div data-openbitfun-component="chat-context-picker" data-openbitfun-part="header" className="chat-context-picker__header">
        {canNavigateBack && (
          <Tooltip content={t('contextPicker.goBack')}>
            <IconButton
              aria-label={t('contextPicker.goBack')}
              icon={<Icon name="chevron-left" size="lg" aria-hidden="true" />}
              onClick={goBack}
              size="xs"
              variant="quiet"
            />
          </Tooltip>
        )}
        {isSearchMode ? <><Icon name="search" size="lg" style={{ width: 11, height: 11 }} /><span>{t('contextPicker.searchResults')}</span></> : (
          <div className="chat-context-picker__directory-label" title={currentViewLabel}>
            {view === 'files' ? (
              <span
                data-openbitfun-component="chat-context-picker"
                data-openbitfun-part="currentDirectoryPath"
                className="chat-context-picker__directory-path chat-context-picker__directory-path--file"
              >
                {currentDirectoryTailStart > 0 && (
                  <OverflowText title="" className="chat-context-picker__directory-prefix">
                    {currentDirectoryPath.slice(0, currentDirectoryTailStart)}
                  </OverflowText>
                )}
                <OverflowText title="" className="chat-context-picker__directory-tail">
                  {currentDirectoryPath.slice(currentDirectoryTailStart)}
                </OverflowText>
              </span>
            ) : (
              <span
                data-openbitfun-component="chat-context-picker"
                data-openbitfun-part="currentViewLabel"
                className="chat-context-picker__directory-path"
              >
                <OverflowText title="">{currentViewLabel}</OverflowText>
              </span>
            )}
          </div>
        )}
        {showMcpStatus && onRefreshMcp && !mcpUnavailable && (
          <IconButton
            aria-label={t('contextPicker.mcp.refresh')}
            title={t('contextPicker.mcp.refresh')}
            icon={<RotateCcw aria-hidden="true" />}
            onClick={onRefreshMcp}
            disabled={mcpLoading}
            size="xs"
            variant="quiet"
          />
        )}
      </div>
      <div data-openbitfun-component="chat-context-picker" data-openbitfun-part="content" className="chat-context-picker__content">
        <Listbox
          aria-label={isSearchMode
            ? t('contextPicker.searchResults')
            : currentViewLabel}
          className="chat-context-picker__list"
          focusMode="virtual"
        >
          {displayItems.length === 0 && fileLoadError ? (
          <ListboxEmpty data-openbitfun-state="error" className="chat-context-picker__empty">
            <span>{t(fileLoadError === 'search'
              ? 'contextPicker.searchUnavailable'
              : 'contextPicker.browseUnavailable')}</span>
          </ListboxEmpty>
        ) : displayItems.length === 0 && isLoading ? (
          <ListboxEmpty className="chat-context-picker__loading"><Loader2 size={14} className="chat-context-picker__spinner" /><span>{t('contextPicker.loading')}</span></ListboxEmpty>
        ) : displayItems.length === 0 ? (
          <ListboxEmpty className="chat-context-picker__empty"><span>{emptyLabel}</span></ListboxEmpty>
        ) : (
          <>
            {displayItems.map((selection, index) => {
              const isSession = selection.kind === 'session';
              const file = selection.kind === 'file' ? selection.item : null;
              const session = selection.kind === 'session' ? selection.item : null;
              const skill = selection.kind === 'skill' ? selection.item : null;
              const mcp = selection.kind === 'mcp' ? selection.item : null;
              const key = selection.kind === 'source'
                ? `source-${selection.id}`
                : selection.kind === 'action'
                  ? `action-${selection.id}`
                  : isSession
                    ? `session-${session?.sessionId}-${session?.workspacePath}`
                    : skill
                      ? `skill-${skill.key}`
                      : mcp
                        ? mcp.key
                      : `file-${file?.referenceStableKey || file?.path}`;
              const label = selection.kind === 'source'
                ? t(selection.id === 'files'
                  ? 'chatInput.boostAddContext'
                  : selection.id === 'mcp'
                    ? 'contextPicker.mcp.label'
                  : 'chatInput.boostSkills')
                : selection.kind === 'action'
                  ? t(selection.id === 'add-image'
                    ? 'input.addImage'
                    : 'chatInput.boostSkillsLoadFailed')
                  : session?.sessionName ?? skill?.name ?? mcp?.label ?? file?.name;
              const skillDescription = skill?.description?.trim() || undefined;
              return (
                <ListboxOption data-overflow-trigger
                  active={index === selectedIndex}
                  className={skill ? 'chat-context-picker__skill-option' : undefined}
                  title={skill ? '' : undefined}
                  key={key}
                  data-index={index}
                  data-openbitfun-context-kind={selection.kind === 'source' || selection.kind === 'action'
                    ? selection.id
                    : selection.kind === 'mcp' ? `mcp-${selection.item.kind}` : selection.kind}
                  indicator={selection.kind === 'source' || (file?.isDirectory && !isSearchMode)
                    ? <Icon name="chevron-right" size="lg" aria-hidden="true" />
                    : undefined}
                  leading={selection.kind === 'source'
                    ? selection.id === 'mcp'
                      ? <Plug aria-hidden="true" />
                      : <Icon name={selection.id === 'files' ? 'files' : 'spark'} size="lg" aria-hidden="true" />
                    : selection.kind === 'action'
                      ? selection.id === 'add-image'
                        ? <Icon name="image" size="lg" aria-hidden="true" />
                        : <RotateCcw aria-hidden="true" />
                      : skill
                        ? <Icon name="spark" size="lg" aria-hidden="true" />
                        : mcp
                          ? <Plug aria-hidden="true" />
                        : isSession
                          ? <MessageCircle aria-hidden="true" />
                          : file?.isDirectory
                            ? <Icon name="folder" size="lg" aria-hidden="true" />
                            : <File aria-hidden="true" />}
                  metadata={skill && skillDescription
                    ? (
                        <OverflowText
                          aria-label={skillDescription}
                          behavior="marquee"
                          className="chat-context-picker__skill-description"
                          data-openbitfun-component="chat-context-picker"
                          data-openbitfun-part="skillDescription"
                          title=""
                        >
                          {skillDescription}
                        </OverflowText>
                      )
                    : (mcp ? t('contextPicker.mcp.server') : undefined)
                    ?? session?.workspaceLabel
                    ?? (file?.referenceStableKey
                      ? file.referenceDescription || file.path
                      : undefined)}
                  onClick={() => handleItemClick(selection)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (file?.isDirectory) enterDirectory(file);
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  value={key}
                >
                  {skill ? <span className="chat-context-picker__skill-name">{label}</span> : label}
                </ListboxOption>
              );
            })}
            {isLoading && (
              <ListboxEmpty className="chat-context-picker__loading">
                <Loader2 size={14} className="chat-context-picker__spinner" />
                <span>{t('contextPicker.loading')}</span>
              </ListboxEmpty>
            )}
            {fileLoadError && (
              <ListboxEmpty data-openbitfun-state="error" className="chat-context-picker__empty">
                <span>{t(fileLoadError === 'search'
                  ? 'contextPicker.searchUnavailable'
                  : 'contextPicker.browseUnavailable')}</span>
              </ListboxEmpty>
            )}
          </>
        )}
        {showMcpStatus && !mcpLoading && (
          mcpStatus && (isSearchMode || displayItems.length > 0)
            && <ListboxEmpty className="chat-context-picker__empty"><span role="status">{mcpStatus}</span></ListboxEmpty>
        )}
        </Listbox>
      </div>
      {(view === 'skills' || isSearchMode) && !skillsLoading && !skillsLoadFailed && (
        skillDiagnostics.length > 0 ? <details className="chat-context-picker__diagnostics">
          <summary>{t('contextPicker.skillsIncomplete')}</summary>
          {skillDiagnostics.map((item, index) => <p key={index}>{item.path}: {item.message}</p>)}
        </details> : !skillDiagnosticsAvailable && <p role="status">{t('contextPicker.skillsDiagnosticsUnavailable')}</p>
      )}
      <div data-openbitfun-component="chat-context-picker" data-openbitfun-part="footer" className="chat-context-picker__footer">
        <span><KeyHint>↑</KeyHint><KeyHint>↓</KeyHint> {t('contextPicker.navHint')}</span>
        {!isSearchMode && (view === 'sources' || view === 'files') && (
          <span><KeyHint>→</KeyHint> {t('contextPicker.enterHint')}</span>
        )}
        {canNavigateBack && <span><KeyHint>←</KeyHint> {t('contextPicker.backHint')}</span>}
        <span><KeyHint>Enter</KeyHint> {t('contextPicker.selectHint')}</span>
      </div>
    </div>
  );

  return isOverlay ? createPortal(picker, getAppearanceOverlayHost()) : picker;
};

export default ChatContextPicker;
