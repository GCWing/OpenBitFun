import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { workspaceAPI } from '@/infrastructure/api';
import type {
  FileSearchResult,
  FileSearchResultGroup,
  SearchMetadata,
} from '@/infrastructure/api/service-api/tauri-commands';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useExplorerSearch');

export type ExplorerSearchMode = 'filenames' | 'content' | 'both';

export interface ExplorerSearchOptions {
  caseSensitive: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

export interface ExplorerSearchPhase {
  phase: 'idle' | 'searching' | 'complete';
  mode: ExplorerSearchMode;
  filenameComplete: boolean;
  contentComplete: boolean;
}

export interface UseExplorerSearchOptions {
  workspaceId?: string;
  /** Optional host/workspace-scoped presentation key. Results are always fetched fresh. */
  stateKey?: string;
  initialMode?: ExplorerSearchMode;
  filenameSearchDebounce?: number;
  contentSearchDebounce?: number;
  minFilenameLength?: number;
  minContentLength?: number;
  filenameMaxResults?: number;
  contentMaxResults?: number;
}

export interface UseExplorerSearchResult {
  query: string;
  setQuery: (query: string) => void;
  triggerSearch: (query: string) => void;
  searchMode: ExplorerSearchMode;
  setSearchMode: Dispatch<SetStateAction<ExplorerSearchMode>>;
  filenameGroups: FileSearchResultGroup[];
  contentGroups: FileSearchResultGroup[];
  allGroups: FileSearchResultGroup[];
  filenameResults: FileSearchResult[];
  contentResults: FileSearchResult[];
  allResults: FileSearchResult[];
  contentSearchMetadata: SearchMetadata | null;
  searchPhase: ExplorerSearchPhase;
  filenameLimit: number;
  contentLimit: number;
  filenameTruncated: boolean;
  contentTruncated: boolean;
  hasTruncatedResults: boolean;
  isSearching: boolean;
  error: string | null;
  searchOptions: ExplorerSearchOptions;
  setSearchOptions: Dispatch<SetStateAction<ExplorerSearchOptions>>;
  clearSearch: () => void;
}

function buildIdlePhase(mode: ExplorerSearchMode): ExplorerSearchPhase {
  return {
    phase: 'idle',
    mode,
    filenameComplete: mode === 'content',
    contentComplete: mode === 'filenames',
  };
}

function buildSearchingPhase(
  mode: ExplorerSearchMode,
  shouldRunFilename: boolean,
  shouldRunContent: boolean
): ExplorerSearchPhase {
  return {
    phase: 'searching',
    mode,
    filenameComplete: !shouldRunFilename,
    contentComplete: !shouldRunContent,
  };
}

function flattenSearchGroups(groups: FileSearchResultGroup[]): FileSearchResult[] {
  const flattened: FileSearchResult[] = [];

  for (const group of groups) {
    if (group.fileNameMatch) {
      flattened.push(group.fileNameMatch);
    }
    if (group.contentMatches.length > 0) {
      flattened.push(...group.contentMatches);
    }
  }

  return flattened;
}

function mergeSearchGroups(
  previous: FileSearchResultGroup[],
  nextBatch: FileSearchResultGroup[]
): FileSearchResultGroup[] {
  if (nextBatch.length === 0) {
    return previous;
  }

  if (previous.length === 0) {
    return nextBatch;
  }

  const merged = new Map<string, FileSearchResultGroup>();

  for (const group of previous) {
    merged.set(group.path, {
      ...group,
      contentMatches: [...group.contentMatches],
    });
  }

  for (const group of nextBatch) {
    const existing = merged.get(group.path);
    if (!existing) {
      merged.set(group.path, {
        ...group,
        contentMatches: [...group.contentMatches],
      });
      continue;
    }

    merged.set(group.path, {
      ...existing,
      name: group.name,
      isDirectory: group.isDirectory,
      fileNameMatch: group.fileNameMatch ?? existing.fileNameMatch,
      contentMatches:
        group.contentMatches.length > 0
          ? [...existing.contentMatches, ...group.contentMatches]
          : existing.contentMatches,
    });
  }

  return Array.from(merged.values());
}

function combineSearchGroups(
  filenameGroups: FileSearchResultGroup[],
  contentGroups: FileSearchResultGroup[]
): FileSearchResultGroup[] {
  return mergeSearchGroups(filenameGroups, contentGroups);
}

const searchPreferences = new Map<string, { query: string; mode: ExplorerSearchMode; options: ExplorerSearchOptions }>();

export function useExplorerSearch(
  options: UseExplorerSearchOptions = {}
): UseExplorerSearchResult {
  const {
    workspaceId,
    stateKey,
    initialMode = 'filenames',
    filenameSearchDebounce = 300,
    contentSearchDebounce = 300,
    minFilenameLength = 1,
    minContentLength = 2,
    filenameMaxResults = 500,
    contentMaxResults = 1000,
  } = options;

  const saved = stateKey ? searchPreferences.get(stateKey) : undefined;
  const [query, setQueryState] = useState(saved?.query ?? '');
  const [searchMode, setSearchMode] = useState<ExplorerSearchMode>(saved?.mode ?? initialMode);
  const [filenameGroups, setFilenameGroups] = useState<FileSearchResultGroup[]>([]);
  const [contentGroups, setContentGroups] = useState<FileSearchResultGroup[]>([]);
  const [contentSearchMetadata, setContentSearchMetadata] = useState<SearchMetadata | null>(null);
  const [searchPhase, setSearchPhase] = useState<ExplorerSearchPhase>(() => buildIdlePhase(initialMode));
  const [filenameLimit, setFilenameLimit] = useState(filenameMaxResults);
  const [contentLimit, setContentLimit] = useState(contentMaxResults);
  const [filenameTruncated, setFilenameTruncated] = useState(false);
  const [contentTruncated, setContentTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOptions, setSearchOptions] = useState<ExplorerSearchOptions>(saved?.options ?? {
    caseSensitive: false,
    useRegex: false,
    wholeWord: false,
  });
  useEffect(() => {
    if (stateKey) searchPreferences.set(stateKey, { query, mode: searchMode, options: searchOptions });
  }, [stateKey, query, searchMode, searchOptions]);

  const filenameAbortController = useRef<AbortController | null>(null);
  const contentAbortController = useRef<AbortController | null>(null);
  const filenameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRunIdRef = useRef(0);
  const requestIdRef = useRef(0);

  const nextSearchId = useCallback((kind: 'filenames' | 'content'): string => {
    requestIdRef.current += 1;
    return `explorer-${kind}-${requestIdRef.current}`;
  }, []);

  const cancelFilenameSearch = useCallback(() => {
    filenameAbortController.current?.abort();
    filenameAbortController.current = null;
    if (filenameTimer.current) {
      clearTimeout(filenameTimer.current);
      filenameTimer.current = null;
    }
  }, []);

  const cancelContentSearch = useCallback(() => {
    contentAbortController.current?.abort();
    contentAbortController.current = null;
    if (contentTimer.current) {
      clearTimeout(contentTimer.current);
      contentTimer.current = null;
    }
  }, []);

  const cancelAllSearches = useCallback(() => {
    cancelFilenameSearch();
    cancelContentSearch();
  }, [cancelContentSearch, cancelFilenameSearch]);

  const clearSearch = useCallback(() => {
    cancelAllSearches();
    searchRunIdRef.current += 1;
    setQueryState('');
    setFilenameGroups([]);
    setContentGroups([]);
    setFilenameLimit(filenameMaxResults);
    setContentLimit(contentMaxResults);
    setFilenameTruncated(false);
    setContentTruncated(false);
    setContentSearchMetadata(null);
    setSearchPhase(buildIdlePhase(searchMode));
    setError(null);
  }, [cancelAllSearches, contentMaxResults, filenameMaxResults, searchMode]);

  const executeFilenameSearch = useCallback(
    async (searchQuery: string, runId: number) => {
      if (!workspaceId) {
        return;
      }

      const controller = new AbortController();
      filenameAbortController.current = controller;
      const searchId = nextSearchId('filenames');

      try {
        const response = await workspaceAPI.searchFilenamesOnlyStreamDetailed(
          workspaceId,
          searchQuery,
          searchOptions.caseSensitive,
          searchOptions.useRegex,
          searchOptions.wholeWord,
          searchId,
          filenameMaxResults,
          true,
          {
            onProgress: (event) => {
              if (runId !== searchRunIdRef.current) {
                return;
              }

              setFilenameGroups((prev) => mergeSearchGroups(prev, event.results));
            },
          },
          controller.signal,
        );

        if (runId !== searchRunIdRef.current) {
          return;
        }

        setFilenameLimit(response.limit);
        setFilenameTruncated(response.truncated);
        setSearchPhase((prev) => {
          const nextPhase = { ...prev, filenameComplete: true };
          return {
            ...nextPhase,
            phase: nextPhase.filenameComplete && nextPhase.contentComplete ? 'complete' : 'searching',
          };
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }

        if (runId !== searchRunIdRef.current) {
          return;
        }

        log.error('Filename search failed', { query: searchQuery, error: err });
        setError(err instanceof Error ? err.message : 'Filename search failed');
        setSearchPhase((prev) => ({ ...prev, filenameComplete: true, phase: prev.contentComplete ? 'complete' : prev.phase }));
      }
    },
    [
      workspaceId,
      searchOptions.caseSensitive,
      searchOptions.useRegex,
      searchOptions.wholeWord,
      nextSearchId,
      filenameMaxResults,
    ]
  );

  const executeContentSearch = useCallback(
    async (searchQuery: string, runId: number) => {
      if (!workspaceId) {
        return;
      }

      const controller = new AbortController();
      contentAbortController.current = controller;
      const searchId = nextSearchId('content');

      try {
        const response = await workspaceAPI.searchContentOnlyStreamDetailed(
          workspaceId,
          searchQuery,
          searchOptions.caseSensitive,
          searchOptions.useRegex,
          searchOptions.wholeWord,
          searchId,
          contentMaxResults,
          {
            onProgress: (event) => {
              if (runId !== searchRunIdRef.current) {
                return;
              }

              setContentGroups((prev) => mergeSearchGroups(prev, event.results));
            },
          },
          controller.signal
        );

        if (runId !== searchRunIdRef.current) {
          return;
        }

        setContentSearchMetadata(response.searchMetadata ?? null);
        setContentLimit(response.limit);
        setContentTruncated(response.truncated);
        setSearchPhase((prev) => {
          const nextPhase = { ...prev, contentComplete: true };
          return {
            ...nextPhase,
            phase: nextPhase.filenameComplete && nextPhase.contentComplete ? 'complete' : 'searching',
          };
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }

        if (runId !== searchRunIdRef.current) {
          return;
        }

        log.error('Content search failed', { query: searchQuery, error: err });
        setError(err instanceof Error ? err.message : 'Content search failed');
        setSearchPhase((prev) => ({ ...prev, contentComplete: true, phase: prev.filenameComplete ? 'complete' : prev.phase }));
      }
    },
    [
      workspaceId,
      searchOptions.caseSensitive,
      searchOptions.useRegex,
      searchOptions.wholeWord,
      nextSearchId,
      contentMaxResults,
    ]
  );

  const setQuery = useCallback((newQuery: string) => {
    setQueryState(newQuery);
  }, []);

  const triggerSearch = useCallback((newQuery: string) => {
    setQueryState(newQuery);
  }, []);

  useEffect(() => {
    cancelAllSearches();

    const trimmedQuery = query.trim();
    const shouldRunFilename =
      searchMode !== 'content' && trimmedQuery.length >= minFilenameLength;
    const shouldRunContent =
      searchMode !== 'filenames' && trimmedQuery.length >= minContentLength;

    if (!workspaceId || (!shouldRunFilename && !shouldRunContent)) {
      setFilenameGroups([]);
      setContentGroups([]);
      setFilenameLimit(filenameMaxResults);
      setContentLimit(contentMaxResults);
      setFilenameTruncated(false);
      setContentTruncated(false);
      setContentSearchMetadata(null);
      setSearchPhase(buildIdlePhase(searchMode));
      setError(null);
      return;
    }

    const runId = ++searchRunIdRef.current;
    setError(null);
    setFilenameGroups([]);
    setContentGroups([]);
    setFilenameLimit(filenameMaxResults);
    setContentLimit(contentMaxResults);
    setFilenameTruncated(false);
    setContentTruncated(false);
    setContentSearchMetadata(null);
    setSearchPhase(buildSearchingPhase(searchMode, shouldRunFilename, shouldRunContent));

    if (shouldRunFilename) {
      filenameTimer.current = setTimeout(() => {
        void executeFilenameSearch(trimmedQuery, runId);
      }, filenameSearchDebounce);
    }

    if (shouldRunContent) {
      contentTimer.current = setTimeout(() => {
        void executeContentSearch(trimmedQuery, runId);
      }, contentSearchDebounce);
    }

    return () => {
      cancelAllSearches();
    };
  }, [
    cancelAllSearches,
    contentMaxResults,
    contentSearchDebounce,
    executeContentSearch,
    executeFilenameSearch,
    filenameMaxResults,
    filenameSearchDebounce,
    minContentLength,
    minFilenameLength,
    query,
    searchMode,
    workspaceId,
  ]);

  useEffect(() => {
    return () => {
      cancelAllSearches();
    };
  }, [cancelAllSearches]);

  const allResults = useMemo(() => {
    const filenameResults = flattenSearchGroups(filenameGroups);
    const contentResults = flattenSearchGroups(contentGroups);

    switch (searchMode) {
      case 'filenames':
        return filenameResults;
      case 'content':
        return contentResults;
      default:
        return [...filenameResults, ...contentResults];
    }
  }, [contentGroups, filenameGroups, searchMode]);

  const filenameResults = useMemo(
    () => flattenSearchGroups(filenameGroups),
    [filenameGroups]
  );

  const contentResults = useMemo(
    () => flattenSearchGroups(contentGroups),
    [contentGroups]
  );

  const allGroups = useMemo(() => {
    switch (searchMode) {
      case 'filenames':
        return filenameGroups;
      case 'content':
        return contentGroups;
      default:
        return combineSearchGroups(filenameGroups, contentGroups);
    }
  }, [contentGroups, filenameGroups, searchMode]);

  return {
    query,
    setQuery,
    triggerSearch,
    searchMode,
    setSearchMode,
    filenameGroups,
    contentGroups,
    allGroups,
    filenameResults,
    contentResults,
    allResults,
    contentSearchMetadata,
    searchPhase,
    filenameLimit,
    contentLimit,
    filenameTruncated,
    contentTruncated,
    hasTruncatedResults: filenameTruncated || contentTruncated,
    isSearching: searchPhase.phase === 'searching',
    error,
    searchOptions,
    setSearchOptions,
    clearSearch,
  };
}
