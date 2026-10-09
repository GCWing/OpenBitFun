 
import { createContext, useContext, useEffect } from 'react';
import {
  workspaceManager,
  WorkspaceState,
  WorkspaceEvent,
  type WorkspaceSection,
} from '../services/business/workspaceManager';
import { WorkspaceInfo, WorkspaceKind } from '../../shared/types';

export const getWorkspaceDisplayName = (workspace: WorkspaceInfo | null): string => {
  if (!workspace) {
    return '';
  }

  if (workspace.workspaceKind === WorkspaceKind.Assistant) {
    return workspace.identity?.name?.trim() || workspace.name;
  }

  return workspace.name;
};

export interface WorkspaceContextValue extends WorkspaceState {
  activeWorkspace: WorkspaceInfo | null;
  openedWorkspacesList: WorkspaceInfo[];
  normalWorkspacesList: WorkspaceInfo[];
  assistantWorkspacesList: WorkspaceInfo[];
  allAssistantWorkspacesList: WorkspaceInfo[];
  openWorkspace: (path: string) => Promise<WorkspaceInfo>;
  createAssistantWorkspace: () => Promise<WorkspaceInfo>;
  setPrimaryAssistantWorkspace: (workspaceId: string) => Promise<WorkspaceInfo>;
  closeWorkspace: () => Promise<void>;
  closeWorkspaceById: (workspaceId: string) => Promise<void>;
  deleteAssistantWorkspace: (workspaceId: string) => Promise<void>;
  resetAssistantWorkspace: (workspaceId: string) => Promise<WorkspaceInfo>;
  switchWorkspace: (workspace: WorkspaceInfo) => Promise<WorkspaceInfo>;
  setActiveWorkspace: (workspaceId: string) => Promise<WorkspaceInfo>;
  reorderOpenedWorkspacesInSection: (
    section: WorkspaceSection,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    position: 'before' | 'after'
  ) => Promise<void>;
  updateWorkspaceRelatedPaths: (
    workspaceId: string,
    relatedPaths: WorkspaceInfo['relatedPaths']
  ) => Promise<WorkspaceInfo>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<WorkspaceInfo>;
  scanWorkspaceInfo: () => Promise<WorkspaceInfo | null>;
  refreshRecentWorkspaces: () => Promise<void>;
  removeWorkspaceFromRecent: (workspaceId: string) => Promise<void>;
  hasWorkspace: boolean;
  workspaceName: string;
  workspacePath: string;
}

const workspaceContextGlobal = globalThis as typeof globalThis & {
  __OPENBITFUN_WORKSPACE_CONTEXT__?: ReturnType<typeof createContext<WorkspaceContextValue | null>>;
};

const WorkspaceContext =
  workspaceContextGlobal.__OPENBITFUN_WORKSPACE_CONTEXT__ ?? createContext<WorkspaceContextValue | null>(null);
workspaceContextGlobal.__OPENBITFUN_WORKSPACE_CONTEXT__ = WorkspaceContext;

export const useWorkspaceContext = (): WorkspaceContextValue => {
  const context = useContext(WorkspaceContext);

  if (!context) {
    throw new Error('useWorkspaceContext must be used within a WorkspaceProvider');
  }

  return context;
};

export const useOptionalWorkspaceContext = (): WorkspaceContextValue | null => {
  return useContext(WorkspaceContext);
};

export const useCurrentWorkspace = () => {
  const { activeWorkspace, loading, error, hasWorkspace, workspaceName, workspacePath } = useWorkspaceContext();

  return {
    workspace: activeWorkspace,
    loading,
    error,
    hasWorkspace,
    workspaceName,
    workspacePath,
  };
};

export const useOptionalCurrentWorkspace = () => {
  const context = useOptionalWorkspaceContext();

  if (!context) {
    return {
      workspace: null,
      loading: false,
      error: null,
      hasWorkspace: false,
      workspaceName: '',
      workspacePath: '',
    };
  }

  const { activeWorkspace, loading, error, hasWorkspace, workspaceName, workspacePath } = context;

  return {
    workspace: activeWorkspace,
    loading,
    error,
    hasWorkspace,
    workspaceName,
    workspacePath,
  };
};

export const useWorkspaceEvents = (
  onWorkspaceOpened?: (workspace: WorkspaceInfo) => void,
  onWorkspaceClosed?: (workspaceId: string) => void,
  onWorkspaceSwitched?: (workspace: WorkspaceInfo) => void,
  onWorkspaceUpdated?: (workspace: WorkspaceInfo) => void
) => {
  useEffect(() => {
    const removeListener = workspaceManager.addEventListener((event: WorkspaceEvent) => {
      switch (event.type) {
        case 'workspace:opened':
          onWorkspaceOpened?.(event.workspace);
          break;
        case 'workspace:closed':
          onWorkspaceClosed?.(event.workspaceId);
          break;
        case 'workspace:switched':
          onWorkspaceSwitched?.(event.workspace);
          break;
        case 'workspace:primary-assistant-changed':
          break;
        case 'workspace:updated':
          onWorkspaceUpdated?.(event.workspace);
          break;
        case 'workspace:recent-updated':
          break;
      }
    });

    return removeListener;
  }, [onWorkspaceOpened, onWorkspaceClosed, onWorkspaceSwitched, onWorkspaceUpdated]);
};

export { WorkspaceContext };
