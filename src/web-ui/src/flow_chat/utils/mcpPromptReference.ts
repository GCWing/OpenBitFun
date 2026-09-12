export interface McpPromptReference {
  serverId: string;
  serverName: string;
}

const JSON_STRING_PATTERN = String.raw`"(?:[^"\\\r\n]|\\[^\r\n])*"`;
const MCP_REFERENCE_PATTERN = String.raw`MCP (${JSON_STRING_PATTERN}) \(server: (${JSON_STRING_PATTERN})\)`;

/** Keep the existing readable prompt/draft format; the editor renders it as a pill. */
export function createMcpPromptReference(reference: McpPromptReference): string {
  return `MCP ${JSON.stringify(reference.serverName)} (server: ${JSON.stringify(reference.serverId)})`;
}

export function parseMcpPromptReference(token: string): McpPromptReference | null {
  const match = new RegExp(`^${MCP_REFERENCE_PATTERN}$`).exec(token);
  if (!match) return null;
  try {
    const serverName: unknown = JSON.parse(match[1]);
    const serverId: unknown = JSON.parse(match[2]);
    return typeof serverName === 'string' && serverName.trim()
      && typeof serverId === 'string' && serverId.trim()
      ? { serverName, serverId } : null;
  } catch {
    return null;
  }
}

export function getMcpPromptReferenceMatches(text: string) {
  return Array.from(text.matchAll(new RegExp(`\\b${MCP_REFERENCE_PATTERN}`, 'g')))
    .flatMap(match => {
      const payload = parseMcpPromptReference(match[0]);
      return payload ? [{ token: match[0], start: match.index!, end: match.index! + match[0].length, payload }] : [];
    });
}
