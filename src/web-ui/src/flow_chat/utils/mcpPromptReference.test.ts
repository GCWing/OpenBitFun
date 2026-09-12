import { describe, expect, it } from 'vitest';
import { createMcpPromptReference, getMcpPromptReferenceMatches, parseMcpPromptReference } from './mcpPromptReference';

describe('MCP prompt references', () => {
  it('keeps the existing prompt format and round-trips escaped service identities', () => {
    expect(createMcpPromptReference({ serverName: 'Docs', serverId: 'docs' })).toBe('MCP "Docs" (server: "docs")');
    const reference = { serverName: 'Docs "team"\n<shared>', serverId: 'docs)\\host"' };
    expect(parseMcpPromptReference(createMcpPromptReference(reference))).toEqual(reference);
  });

  it('preserves exact offsets and distinguishes services with the same display name', () => {
    const first = createMcpPromptReference({ serverName: 'Docs', serverId: 'one' });
    const second = createMcpPromptReference({ serverName: 'Docs', serverId: 'two' });
    const text = `Use ${first} then ${second}.`;
    const matches = getMcpPromptReferenceMatches(text);
    expect(matches.map(match => match.payload.serverId)).toEqual(['one', 'two']);
    expect(matches.map(match => text.slice(match.start, match.end))).toEqual([first, second]);
  });

  it.each(['MCP "Docs"', 'MCP "Docs" (server: "")', 'MCP "" (server: "docs")', 'MCP "Docs" (server: "bad\\q")'])('leaves incomplete or malformed references as text: %s', token => {
    expect(parseMcpPromptReference(token)).toBeNull();
    expect(getMcpPromptReferenceMatches(token)).toEqual([]);
  });
});
