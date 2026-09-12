import { describe, expect, it } from 'vitest';
import { chatMcpItems } from './chatMcpItems';

const tools = [
  { name: 'mcp__docs__search', serverId: 'docs', serverName: 'Documentation', toolName: 'search', description: 'Find manuals' },
  { name: 'mcp__docs__read', serverId: 'docs', serverName: 'Documentation', toolName: 'read', description: 'Read pages' },
  { name: 'mcp__other__read', serverId: 'other', serverName: 'Other', toolName: 'read', description: 'Read issues' },
];
describe('MCP mention choices', () => {
  it('offers each service once without separate tool choices', () => {
    const items = chatMcpItems(tools);
    expect(items.map(item => item.kind)).toEqual(['server', 'server']);
    expect(items[1].reference).toBe('MCP "Other" (server: "other")');
    expect(items[0].reference).toBe('MCP "Documentation" (server: "docs")');
  });
  it('finds the owning service by server or tool metadata without expanding tools', () => {
    expect(chatMcpItems(tools, 'documentation')).toHaveLength(1);
    expect(chatMcpItems(tools, 'manuals').map(item => item.key)).toEqual(['server:docs']);
    expect(chatMcpItems(tools, 'read')).toHaveLength(2);
    expect(chatMcpItems(tools, 'MCP')).toHaveLength(2);
    expect(chatMcpItems(tools, 'absent')).toEqual([]);
  });
});
