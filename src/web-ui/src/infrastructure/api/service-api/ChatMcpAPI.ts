import { api } from './ApiClient';
import { legacyWorkspacePayload } from './legacyWorkspaceCompatibility';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';

export interface ChatMcpTool {
  name: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
}

export interface ChatMcpCatalog {
  tools: ChatMcpTool[];
  modeRestricted: boolean;
}

export interface ChatMcpCatalogRequest {
  modeId: string;
  workspaceId?: string;
  workspaceKind?: string;
}

export class ChatMcpUnavailableError extends Error {
  constructor(readonly reason: 'remoteWorkspace' | 'unsupportedHost') {
    super(`MCP chat catalog unavailable: ${reason}`);
  }
}

export async function getChatMcpCatalog(request: ChatMcpCatalogRequest): Promise<ChatMcpCatalog> {
  const scope = getActiveSurfaceScope();
  if (request.workspaceKind === 'remote') throw new ChatMcpUnavailableError('remoteWorkspace');
  if (!isLocalSurface(scope.surfaceId)
    && peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.chatMcpCatalogV1 !== true) {
    throw new ChatMcpUnavailableError('unsupportedHost');
  }
  const legacy = !isLocalSurface(scope.surfaceId)
    && peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.workspaceIdReferencesV1 !== true;
  const payload = legacy && request.workspaceId
    ? { ...request, ...await legacyWorkspacePayload(request.workspaceId, () => scope.assertCurrent('resolve legacy workspace')) }
    : request;
  const catalog = await api.invoke<ChatMcpCatalog>('get_chat_mcp_catalog', { request: payload });
  scope.assertCurrent('read MCP chat catalog');
  // An old or incompatible host must not look like an empty catalog.
  if (!catalog || !Array.isArray(catalog.tools) || typeof catalog.modeRestricted !== 'boolean') {
    throw new ChatMcpUnavailableError('unsupportedHost');
  }
  return catalog;
}
