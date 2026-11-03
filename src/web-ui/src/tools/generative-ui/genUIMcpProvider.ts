import type { ChatMcpCatalog, ChatMcpTool } from '@/infrastructure/api/service-api/ChatMcpAPI';
import { MCPAPI } from '@/infrastructure/api/service-api/MCPAPI';
import type {
  GenUIAsyncCapability,
  GenUIAsyncContext,
  GenUIAsyncProvider,
  GenUITargetEvent,
} from './genUIAsyncCapabilities';

/**
 * Turns the already-authorized chat MCP catalog into the provider OpenUI uses
 * for Query and Mutation. The catalog is the admission list: a source cannot
 * call an arbitrary MCP server or invent a tool name.
 */
export interface GenUIMcpProviderOptions {
  target?: GenUIAsyncCapability['target'];
  permissions?: Record<string, string | undefined>;
  /** Mutation is opt-in because the catalog itself does not encode side effects. */
  mutationTools?: readonly string[];
  /** Host-declared events are separate from MCP tools and never become queries. */
  eventCapabilities?: Record<string, Omit<GenUIAsyncCapability, 'kind'>>;
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
}

export interface GenUIMcpProvider extends GenUIAsyncProvider {
  readonly catalog: ChatMcpCatalog;
}

function toolKey(tool: ChatMcpTool): string {
  return tool.name;
}

const SEMANTIC_ALIASES = {
  'image.search': ['image.search', 'image_search', 'search_image'],
  'map.lookup': ['map.lookup', 'map_lookup', 'geocode'],
  'map.route': ['map.route', 'map_route', 'street_route', 'street-route'],
} as const;

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function semanticCapabilityFor(tool: ChatMcpTool): string | undefined {
  const candidates = [tool.name, tool.toolName].map(normalizeToolName);
  for (const [capability, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    if (aliases.some(alias => candidates.includes(normalizeToolName(alias)))) return capability;
  }
  return undefined;
}

function errorFromJsonRpc(value: unknown): Error | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error) return undefined;
  if (typeof error === 'string') return new Error(error);
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(error);
    const result = new Error(message || 'MCP tool call failed');
    result.name = 'McpToolError';
    return result;
  }
  return new Error('MCP tool call failed');
}

function unwrapMcpResult(response: Record<string, unknown>): unknown {
  const jsonRpcError = errorFromJsonRpc(response);
  if (jsonRpcError) throw jsonRpcError;
  const hasResult = Object.prototype.hasOwnProperty.call(response, 'result');
  if (hasResult && response.result === null) return null;
  const result = hasResult && response.result && typeof response.result === 'object'
    ? response.result as Record<string, unknown>
    : response;
  if (result.isError === true || result.is_error === true) {
    const message = Array.isArray(result.content)
      ? result.content.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
        .map(item => String((item as Record<string, unknown>).text ?? '')).join('\n')
      : 'MCP tool call failed';
    const error = new Error(message || 'MCP tool call failed');
    error.name = 'McpToolError';
    throw error;
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
      .map(item => String((item as Record<string, unknown>).text ?? '')).join('')
    : '';
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

export function createGenUIMcpProvider(catalog: ChatMcpCatalog, options: GenUIMcpProviderOptions = {}): GenUIMcpProvider {
  const mutationNames = new Set(options.mutationTools ?? []);
  const toolsInCatalog = catalog.tools.filter(tool => Boolean(tool)
    && typeof tool.name === 'string' && tool.name.trim().length > 0
    && typeof tool.serverId === 'string' && tool.serverId.trim().length > 0
    && typeof tool.toolName === 'string' && tool.toolName.trim().length > 0);
  const tools = new Map<string, ChatMcpTool>();
  const toolCapabilities: Record<string, GenUIAsyncCapability> = {};
  for (const tool of toolsInCatalog) {
    const name = toolKey(tool);
    const semantic = semanticCapabilityFor(tool);
    const permission = options.permissions?.[name] ?? options.permissions?.[tool.toolName] ?? (semantic ? options.permissions?.[semantic] : undefined);
    const capability = {
      kind: mutationNames.has(name) || mutationNames.has(tool.toolName) ? 'mutation' : 'query',
      target: options.target ?? 'local',
      description: tool.description,
      ...(permission ? { permission } : {}),
    } satisfies GenUIAsyncCapability;
    tools.set(name, tool);
    toolCapabilities[name] = capability;

    // OpenUI components use stable semantic capabilities for media and maps.
    // An alias is admitted only when the already-authorized catalog contains an
    // exact, known host tool name; arbitrary model-provided names never become
    // a provider capability.
    if (semantic && !tools.has(semantic)) {
      tools.set(semantic, tool);
      toolCapabilities[semantic] = { ...capability, description: `${tool.description || tool.toolName} (${semantic})` };
    }
  }
  const eventCapabilities = Object.fromEntries(Object.entries(options.eventCapabilities ?? {}).map(([name, capability]) => [name, { ...capability, kind: 'event' as const }]));

  return {
    catalog,
    capabilities: { ...toolCapabilities, ...eventCapabilities },
    call: async (name: string, args: Record<string, unknown>, context: GenUIAsyncContext) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`MCP tool ${name} is not present in the authorized chat catalog`);
      const response = await MCPAPI.sendMCPAppMessage({
        serverId: tool.serverId,
        jsonrpc: '2.0',
        id: context.requestId,
        method: 'tools/call',
        params: { name: tool.toolName, arguments: args },
        signal: context.signal,
      });
      return unwrapMcpResult(response);
    },
    // The transport receives the AbortSignal above. MCP Apps has no portable
    // cancellation method; keeping this hook explicit lets future hosts add a
    // cancellation notification without changing the OpenUI boundary.
    emit: options.onTargetEvent,
  };
}
