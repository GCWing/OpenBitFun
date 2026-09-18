import { api } from './ApiClient';
import { workspaceScopedRequest } from './legacyWorkspaceCompatibility';
import { globalEventBus } from '@/infrastructure/event-bus';

export type AgentSource = 'builtin' | 'project' | 'user' | 'external';
export type CustomAgentKind = 'mode' | 'subagent';
export type CustomAgentLevel = 'user' | 'project';
export type UserContextSection =
  | 'workspace_context'
  | 'workspace_instructions'
  | 'project_layout';

export interface CustomAgentDetail {
  agentId: string;
  kind: CustomAgentKind;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  readonly: boolean;
  review: boolean;
  model: string;
  path: string;
  level: CustomAgentLevel;
  userContextPolicy: UserContextSection[];
}

export interface GetCustomAgentDetailPayload {
  agentId: string;
  workspaceId?: string;
}

export interface CreateCustomAgentPayload {
  kind: CustomAgentKind;
  level?: CustomAgentLevel;
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  readonly?: boolean;
  review?: boolean;
  model?: string;
  userContextPolicy?: UserContextSection[];
  workspaceId?: string;
}

export interface UpdateCustomAgentPayload {
  agentId: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  readonly?: boolean;
  review?: boolean;
  model?: string;
  userContextPolicy?: UserContextSection[];
  workspaceId?: string;
}

function emitCustomAgentCatalogUpdated(payload: {
  agentId?: string;
  kind?: CustomAgentKind;
  workspaceId?: string;
}) {
  globalEventBus.emit('custom-agent:updated', payload);
  globalEventBus.emit('mode:config:updated', {
    reason: 'custom-agent-catalog-updated',
    ...payload,
  });
}

export const CustomAgentAPI = {
  async getCustomAgentDetail(
    payload: GetCustomAgentDetailPayload,
  ): Promise<CustomAgentDetail> {
    return api.invoke<CustomAgentDetail>('get_custom_agent_detail', {
      request: await workspaceScopedRequest(payload),
    });
  },

  async createCustomAgent(payload: CreateCustomAgentPayload): Promise<void> {
    await api.invoke('create_custom_agent', {
      request: await workspaceScopedRequest(payload),
    });
    emitCustomAgentCatalogUpdated({
      agentId: payload.id,
      kind: payload.kind,
      workspaceId: payload.workspaceId,
    });
  },

  async updateCustomAgent(payload: UpdateCustomAgentPayload): Promise<void> {
    await api.invoke('update_custom_agent', {
      request: await workspaceScopedRequest(payload),
    });
    emitCustomAgentCatalogUpdated({
      agentId: payload.agentId,
      workspaceId: payload.workspaceId,
    });
  },

  async deleteCustomAgent(agentId: string, workspaceId?: string): Promise<void> {
    await api.invoke('delete_custom_agent', {
      request: await workspaceScopedRequest({ agentId, workspaceId }),
    });
    emitCustomAgentCatalogUpdated({ agentId, workspaceId });
  },

  async reloadCustomAgents(workspaceId?: string): Promise<void> {
    await api.invoke('reload_custom_agents', {
      request: await workspaceScopedRequest({ workspaceId }),
    });
    emitCustomAgentCatalogUpdated({ workspaceId });
  },
};
