import { unified } from 'unified';
import remarkParse from 'remark-parse';

export interface ToolDefinitionDocument {
  name: string;
  description: string;
  parameters: Record<string, unknown> | boolean;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function readDefinitions(source: string): ToolDefinitionDocument[] | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (!Array.isArray(value) || !value.every(tool => isRecord(tool)
      && typeof tool.name === 'string' && tool.name.trim()
      && typeof tool.description === 'string'
      && (isRecord(tool.parameters) || typeof tool.parameters === 'boolean'))) return undefined;
    return value as ToolDefinitionDocument[];
  } catch {
    return undefined;
  }
}

/** Read the existing host capture without rewriting stored sessions or fetching today's catalog. */
export function parseToolDefinitionsDocument(source: string): {
  tools: ToolDefinitionDocument[];
  notes: string;
  invalid: boolean;
} {
  if (!source.trim()) return { tools: [], notes: '', invalid: false };
  const direct = readDefinitions(source);
  if (direct) return { tools: direct, notes: '', invalid: false };

  const nodes = unified().use(remarkParse).parse(source).children;
  const last = nodes.at(-1);
  if (last?.type === 'code' && last.lang?.toLowerCase() === 'json') {
    const tools = readDefinitions(last.value);
    const separator = nodes.at(-2);
    const end = separator?.type === 'thematicBreak' ? separator.position?.start.offset : last.position?.start.offset;
    return { tools: tools ?? [], notes: source.slice(0, end).trim(), invalid: tools === undefined };
  }
  // PTC-only requests can contain instructions without a native tool schema list.
  const invalid = source.trimStart().startsWith('[');
  return { tools: [], notes: invalid ? '' : source, invalid };
}

export function schemaType(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type) && schema.type.every(type => typeof type === 'string')) return schema.type.join(' | ');
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined || schema.prefixItems !== undefined) return 'array';
  return undefined;
}
