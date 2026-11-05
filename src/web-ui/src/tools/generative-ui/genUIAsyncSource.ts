/**
 * Returns whether an OpenUI source can make a host-owned asynchronous call.
 *
 * This is only a loading optimisation. The async runtime still performs the
 * real capability and permission admission for every call. Keeping this
 * predicate at the source boundary prevents ordinary Markdown/forms from
 * opening an MCP catalog connection, while Image/SearchImage fallback,
 * Map and explicit Query/Mutation documents receive the provider before they
 * mount.
 */
export function requiresGenUIAsyncProvider(app?: unknown): boolean {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return false;
  const source = (app as { source?: unknown }).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const record = source as { kind?: unknown; content?: unknown };
  return record.kind === 'openui-lang'
    && typeof record.content === 'string'
    && /\b(?:Query|Mutation|SearchImage|Image|Map)\s*\(/.test(record.content);
}
