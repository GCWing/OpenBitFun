import { useCallback, useEffect, useMemo, useState } from 'react';
import { useExplorerController, useExplorerSnapshot } from '@/tools/file-explorer';
import { workspaceAPI } from '@/infrastructure/api';
import type { FileSystemNode, FileSystemOptions } from '../types';

export interface UseFileSystemOptions extends FileSystemOptions {
  workspaceId?: string;
  rootPath?: string;
  remoteConnectionId?: string;
  autoLoad?: boolean;
  enableAutoWatch?: boolean;
}

export interface UseFileSystemReturn {
  fileTree: FileSystemNode[];
  selectedFile?: string;
  expandedFolders: Set<string>;
  loading: boolean;
  error?: string;
  loadingPaths: Set<string>;
  loadFileTree: (path?: string, silent?: boolean) => Promise<void>;
  selectFile: (filePath: string) => void;
  expandFolder: (folderPath: string, expanded?: boolean) => void;
  expandFolderLazy: (folderPath: string) => Promise<void>;
  expandFolderEnsure: (folderPath: string) => Promise<void>;
  removePath: (path: string) => void;
  searchFiles: (query: string) => Promise<FileSystemNode[]>;
  refreshFileTree: () => Promise<void>;
  updateOptions: (options: Partial<FileSystemOptions>) => void;
}

export function useFileSystem(options: UseFileSystemOptions = {}): UseFileSystemReturn {
  const [optionOverrides, setOptionOverrides] = useState<Partial<FileSystemOptions>>({});

  useEffect(() => {
    setOptionOverrides({});
  }, [options.workspaceId]);

  const controllerConfig = useMemo(() => ({
    workspaceId: options.workspaceId,
    rootPath: options.rootPath,
    remoteConnectionId: options.remoteConnectionId,
    autoLoad: options.autoLoad ?? true,
    enableAutoWatch: options.enableAutoWatch ?? true,
    enablePathCompression: optionOverrides.enablePathCompression ?? options.enablePathCompression ?? true,
    showHiddenFiles: optionOverrides.showHiddenFiles ?? options.showHiddenFiles ?? false,
    sortBy: optionOverrides.sortBy ?? options.sortBy ?? 'name',
    sortOrder: optionOverrides.sortOrder ?? options.sortOrder ?? 'asc',
    maxDepth: optionOverrides.maxDepth ?? options.maxDepth,
    excludePatterns: optionOverrides.excludePatterns ?? options.excludePatterns ?? [],
  }), [
    options.workspaceId,
    options.rootPath,
    options.remoteConnectionId,
    options.autoLoad,
    options.enableAutoWatch,
    options.enablePathCompression,
    options.showHiddenFiles,
    options.sortBy,
    options.sortOrder,
    options.maxDepth,
    options.excludePatterns,
    optionOverrides,
  ]);
  const controller = useExplorerController(controllerConfig);
  const snapshot = useExplorerSnapshot(controller);

  const loadFileTree = useCallback((path?: string, silent = false) => {
    return controller.loadFileTree(path, silent);
  }, [controller]);

  const selectFile = useCallback((filePath: string) => {
    controller.selectFile(filePath);
  }, [controller]);

  const expandFolder = useCallback((folderPath: string, expanded?: boolean) => {
    controller.expandFolder(folderPath, expanded);
  }, [controller]);

  const expandFolderLazy = useCallback((folderPath: string) => {
    return controller.expandFolderLazy(folderPath);
  }, [controller]);

  const expandFolderEnsure = useCallback((folderPath: string) => {
    return controller.expandFolderEnsure(folderPath);
  }, [controller]);

  const removePath = useCallback((path: string) => {
    controller.removePath(path);
  }, [controller]);

  const refreshFileTree = useCallback(() => {
    return controller.loadFileTree(undefined, false);
  }, [controller]);

  const searchFiles = useCallback(async (query: string) => {
    const workspaceId = controllerConfig.workspaceId;
    if (!workspaceId || !query.trim()) {
      return [];
    }

    const results = await workspaceAPI.searchFilenamesOnly(
      workspaceId, query.trim(), false, false, false, undefined, undefined, true,
    );
    return results.map((result) => ({
      path: result.path,
      name: result.name,
      isDirectory: result.isDirectory,
    }));
  }, [controllerConfig.workspaceId]);

  const updateOptions = useCallback((nextOptions: Partial<FileSystemOptions>) => {
    setOptionOverrides(prev => ({
      ...prev,
      ...nextOptions,
      excludePatterns: nextOptions.excludePatterns ?? prev.excludePatterns,
    }));
  }, []);

  return {
    fileTree: snapshot.fileTree,
    selectedFile: snapshot.selectedFile,
    expandedFolders: snapshot.expandedFolders,
    loading: snapshot.loading,
    error: snapshot.error,
    loadingPaths: snapshot.loadingPaths,
    loadFileTree,
    selectFile,
    expandFolder,
    expandFolderLazy,
    expandFolderEnsure,
    removePath,
    searchFiles,
    refreshFileTree,
    updateOptions,
  };
}
