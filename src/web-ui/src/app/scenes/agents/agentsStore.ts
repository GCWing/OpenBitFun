/**
 * Agents scene state management
 */
import { create } from 'zustand';
import type { SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import type { ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import type { AgentModelTargetSelection } from '@/infrastructure/config/types';
import {
  CAPABILITY_ACCENT,
  CAPABILITY_CATEGORIES,
  type CapabilityCategory,
} from './agentAppearance';

export { CAPABILITY_CATEGORIES };
export type { CapabilityCategory };

export type { AgentKind } from '@/shared/agents/identity';

export interface AgentCapability {
  category: CapabilityCategory;
  level: number;
}

type PrimaryAgentEntry = ModeInfo & {
  key: string;
  agentKind: 'harness' | 'agent';
  subagentSource?: never;
  visibility?: never;
  externalProviderLabel?: never;
  supportsFollowUp?: never;
};

/** Invocation roles retain their own metadata instead of fabricating SubagentInfo for a Harness. */
export type AgentWithCapabilities = (PrimaryAgentEntry | (SubagentInfo & { agentKind: 'subagent' })) & {
  capabilities: AgentCapability[];
  iconKey?: string;
  visibleSubagentCount?: number;
  /** Explicit model selection for this Subagent, if it overrides the shared default. */
  subagentModelOverride?: AgentModelTargetSelection;
  /** Display name for an explicitly configured Subagent model override. */
  subagentModelDisplayName?: string;
};

export const CAPABILITY_COLORS: Record<CapabilityCategory, string> = CAPABILITY_ACCENT;

export type AgentsScenePage = 'home' | 'createAgent';
export type AgentEditorMode = 'create' | 'edit';
export type AgentFilterLevel = 'all' | 'builtin' | 'user' | 'project' | 'external';
export type AgentFilterType = 'all' | 'agent' | 'subagent';

interface AgentsStoreState {
  page: AgentsScenePage;
  agentEditorMode: AgentEditorMode;
  editingAgentId: string | null;
  searchQuery: string;
  agentFilterLevel: AgentFilterLevel;
  agentFilterType: AgentFilterType;
  setPage: (page: AgentsScenePage) => void;
  setSearchQuery: (query: string) => void;
  setAgentFilterLevel: (filter: AgentFilterLevel) => void;
  setAgentFilterType: (filter: AgentFilterType) => void;
  openHome: () => void;
  openCreateAgent: () => void;
  openEditAgent: (agentId: string) => void;
}

export const useAgentsStore = create<AgentsStoreState>((set) => ({
  page: 'home',
  agentEditorMode: 'create',
  editingAgentId: null,
  searchQuery: '',
  agentFilterLevel: 'all',
  agentFilterType: 'all',
  setPage: (page) => set({ page }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setAgentFilterLevel: (filter) => set({ agentFilterLevel: filter }),
  setAgentFilterType: (filter) => set({ agentFilterType: filter }),
  openHome: () => set({ page: 'home', agentEditorMode: 'create', editingAgentId: null }),
  openCreateAgent: () => set({
    page: 'createAgent',
    agentEditorMode: 'create',
    editingAgentId: null,
  }),
  openEditAgent: (agentId: string) => set({
    page: 'createAgent',
    agentEditorMode: 'edit',
    editingAgentId: agentId,
  }),
}));
