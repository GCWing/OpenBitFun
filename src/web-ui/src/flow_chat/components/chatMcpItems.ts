import type { ChatMcpTool } from '@/infrastructure/api/service-api/ChatMcpAPI';
import { createMcpPromptReference } from '../utils/mcpPromptReference';

export interface ContextPickerMcpItem {
  key: string;
  kind: 'server';
  label: string;
  reference: string;
}

export function chatMcpItems(tools: readonly ChatMcpTool[], query = ''): ContextPickerMcpItem[] {
  const servers = new Map<string, ChatMcpTool[]>();
  for (const tool of tools) {
    const group = servers.get(tool.serverId) ?? [];
    group.push(tool);
    servers.set(tool.serverId, group);
  }
  const items: ContextPickerMcpItem[] = [];
  const search = query.trim().toLowerCase();
  for (const [serverId, group] of servers) {
    const serverName = group[0].serverName;
    const matchesServer = !search || ['mcp', serverName, serverId].some(value => value.toLowerCase().includes(search));
    const matchesTool = group.some(tool => [tool.name, tool.toolName, tool.description]
      .some(value => value.toLowerCase().includes(search)));
    if (matchesServer || matchesTool) items.push({
      key: `server:${serverId}`, kind: 'server', label: serverName,
      reference: createMcpPromptReference({ serverId, serverName }),
    });
  }
  return items;
}
