import { invokePrepared } from './invokePrepared';
import { workspaceScopedRequest } from './legacyWorkspaceCompatibility';
import { globalEventBus } from '@/infrastructure/event-bus';
import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

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

function emitCustomAgentCatalogUpdated(scope: SurfaceScope, payload: {
  agentId?: string;
  kind?: CustomAgentKind;
  workspaceId?: string;
}) {
  scope.assertCurrent('publish custom agent catalog update');
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
    return invokePrepared<CustomAgentDetail>('get_custom_agent_detail', async () => ({
      request: await workspaceScopedRequest(payload),
    }));
  },

  async createCustomAgent(payload: CreateCustomAgentPayload): Promise<void> {
    const scope = getActiveSurfaceScope();
    await invokePrepared('create_custom_agent', async () => ({
      request: await workspaceScopedRequest(payload),
    }));
    emitCustomAgentCatalogUpdated(scope, {
      agentId: payload.id,
      kind: payload.kind,
      workspaceId: payload.workspaceId,
    });
  },

  async updateCustomAgent(payload: UpdateCustomAgentPayload): Promise<void> {
    const scope = getActiveSurfaceScope();
    await invokePrepared('update_custom_agent', async () => ({
      request: await workspaceScopedRequest(payload),
    }));
    emitCustomAgentCatalogUpdated(scope, {
      agentId: payload.agentId,
      workspaceId: payload.workspaceId,
    });
  },

  async deleteCustomAgent(agentId: string, workspaceId?: string): Promise<void> {
    const scope = getActiveSurfaceScope();
    await invokePrepared('delete_custom_agent', async () => ({
      request: await workspaceScopedRequest({ agentId, workspaceId }),
    }));
    emitCustomAgentCatalogUpdated(scope, { agentId, workspaceId });
  },

  async reloadCustomAgents(workspaceId?: string): Promise<void> {
    const scope = getActiveSurfaceScope();
    await invokePrepared('reload_custom_agents', async () => ({
      request: await workspaceScopedRequest({ workspaceId }),
    }));
    emitCustomAgentCatalogUpdated(scope, { workspaceId });
  },
};
