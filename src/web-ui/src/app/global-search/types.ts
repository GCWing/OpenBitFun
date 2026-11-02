import type { WorkspaceInfo } from '@/shared/types';
import type { SettingsDestination } from '@/app/scenes/settings/settingsTypes';
import type { ProductActionId } from './productActionCatalog';

export type GlobalSearchScope = 'all' | 'actions' | 'content';

export type GlobalSearchGroupId =
  | 'actions'
  | 'messages'
  | 'sessions'
  | 'files'
  | 'workspaces'
  | 'assistants'
  | 'capabilities'
  | 'settings';

export type GlobalSearchTarget =
  | { kind: 'action'; actionId: ProductActionId }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'assistant'; workspaceId: string }
  | {
      kind: 'session';
      sessionId: string;
      workspaceId: string;
      workspacePath: string;
      remoteConnectionId?: string;
      remoteSshHost?: string;
      turnId?: string;
      /** One-based visible Turn index used by FlowChat navigation. */
      turnIndex?: number;
    }
  | {
      kind: 'file';
      workspaceId: string;
      workspacePath: string;
      filePath: string;
      fileName: string;
      lineNumber?: number;
    }
  | { kind: 'settings'; destination: SettingsDestination }
  | { kind: 'capability'; capabilityId: string; itemId?: string };

export interface GlobalSearchItem {
  id: string;
  providerId: string;
  group: GlobalSearchGroupId;
  title: string;
  subtitle?: string;
  context?: string;
  badge?: string;
  /** Provider-local relevance. The engine bounds this value to 0..100. */
  score: number;
  target: GlobalSearchTarget;
}

export type GlobalSearchProviderStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface GlobalSearchProviderDiagnostic {
  providerId: string;
  code: string;
  message: string;
  workspaceName?: string;
  workspacePath?: string;
  hostLabel?: string;
  retryable?: boolean;
}

export interface GlobalSearchProviderResult {
  items: GlobalSearchItem[];
  diagnostics?: GlobalSearchProviderDiagnostic[];
  truncated?: boolean;
}

export interface GlobalSearchRequest {
  rawQuery: string;
  query: string;
  scope: GlobalSearchScope;
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo | null;
  limitPerGroup: number;
  tCommon: (key: string, options?: Record<string, unknown>) => string;
  tCapabilities: (key: string, options?: Record<string, unknown>) => string;
  tSettings: (key: string, options?: Record<string, unknown>) => string;
}

export interface GlobalSearchProvider {
  id: string;
  groups: readonly GlobalSearchGroupId[];
  search: (
    request: GlobalSearchRequest,
    signal: AbortSignal,
  ) => Promise<GlobalSearchProviderResult> | GlobalSearchProviderResult;
}

export interface GlobalSearchSnapshot {
  items: GlobalSearchItem[];
  providerStatus: Record<string, GlobalSearchProviderStatus>;
  diagnostics: GlobalSearchProviderDiagnostic[];
  isSearching: boolean;
  truncated: boolean;
}

export const GLOBAL_SEARCH_GROUP_ORDER: readonly GlobalSearchGroupId[] = [
  'actions',
  'settings',
  'capabilities',
  'messages',
  'sessions',
  'files',
  'workspaces',
  'assistants',
];
