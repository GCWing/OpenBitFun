/** Lossless editing of the existing user-level MCP JSON contract. No runtime IO. */
export type McpConfigObject = Record<string, unknown>;
export interface McpConfigDocument extends McpConfigObject {
  mcpServers: Record<string, McpConfigObject>;
}

export type McpFormErrorCode =
  | 'invalidJson' | 'invalidConfig' | 'advancedRequired' | 'nameRequired'
  | 'idRequired' | 'invalidId' | 'idConflict' | 'commandRequired' | 'urlInvalid'
  | 'duplicateKey' | 'invalidKey' | 'invalidValue' | 'tokenRequired' | 'timeoutInvalid'
  | 'selectServers';

export class McpConfigFormError extends Error {
  constructor(public readonly code: McpFormErrorCode, public readonly field = 'config') {
    super(code);
    this.name = 'McpConfigFormError';
  }
}

export interface McpKeyValueRow {
  key: string;
  /** Undefined keeps the saved value without putting a credential in an input. */
  value?: string;
  savedValue?: string;
}

export interface McpServerDraft {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command: string;
  args: string[];
  env: McpKeyValueRow[];
  workingDirectory: string;
  url: string;
  headers: McpKeyValueRow[];
  auth: 'preserve' | 'auto' | 'oauth' | 'token' | 'headers';
  token: string;
  enabled: boolean;
  autoStart: boolean;
  startupSeconds: string;
}

export interface McpImportCandidate {
  sourceId: string;
  targetId: string;
  selected: boolean;
  config: McpConfigObject;
}

function isObject(value: unknown): value is McpConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMcpConfigDocument(text: string): McpConfigDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new McpConfigFormError('invalidJson'); }
  if (!isObject(value) || !isObject(value.mcpServers)
    || Object.values(value.mcpServers).some(server => !isObject(server))) {
    throw new McpConfigFormError('invalidConfig');
  }
  return value as McpConfigDocument;
}

function optionalString(entry: McpConfigObject, key: string): string {
  const value = entry[key];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new McpConfigFormError('advancedRequired', key);
  return value;
}

function optionalBoolean(entry: McpConfigObject, key: string, fallback: boolean): boolean {
  const value = entry[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new McpConfigFormError('advancedRequired', key);
  return value;
}

function rowsFromObject(value: unknown): McpKeyValueRow[] {
  if (value === undefined) return [];
  if (!isObject(value) || Object.values(value).some(item => typeof item !== 'string')) {
    throw new McpConfigFormError('advancedRequired');
  }
  return Object.entries(value).map(([key, savedValue]) => ({ key, savedValue: savedValue as string }));
}

function transportFromConfig(entry: McpConfigObject): McpServerDraft['transport'] {
  const aliases: Record<string, McpServerDraft['transport']> = {
    local: 'stdio', stdio: 'stdio', remote: 'streamable-http', http: 'streamable-http',
    'streamable-http': 'streamable-http', streamable_http: 'streamable-http',
    streamablehttp: 'streamable-http', sse: 'sse',
  };
  const type = optionalString(entry, 'type').trim();
  const explicitTransport = optionalString(entry, 'transport').trim();
  const explicitSource = optionalString(entry, 'source').trim();
  if ((type && !Object.prototype.hasOwnProperty.call(aliases, type))
    || (explicitTransport && (!Object.prototype.hasOwnProperty.call(aliases, explicitTransport)
      || explicitTransport === 'local' || explicitTransport === 'remote'))
    || (explicitSource && explicitSource !== 'local' && explicitSource !== 'remote')) {
    throw new McpConfigFormError('advancedRequired');
  }
  // Match the backend: explicit source/transport override their legacy type
  // counterparts, while "stdio" alone does not declare a source.
  const legacySource = !type || type === 'stdio' ? undefined : type === 'local' ? 'local' : 'remote';
  const source = explicitSource || legacySource;
  const hasCommand = Boolean(optionalString(entry, 'command').trim());
  const hasUrl = Boolean(optionalString(entry, 'url').trim());
  const transport = aliases[explicitTransport || type]
    ?? (hasUrl || source === 'remote' ? 'streamable-http' : 'stdio');
  if ((hasCommand && hasUrl)
    || (source === 'remote' && hasCommand) || (source === 'local' && hasUrl)
    || (transport === 'stdio' && (hasUrl || source === 'remote'))
    || (transport !== 'stdio' && (hasCommand || source === 'local'))) {
    throw new McpConfigFormError('advancedRequired');
  }
  return transport;
}

export function createMcpServerDraft(id = '', entry?: McpConfigObject): McpServerDraft {
  if (!entry) return {
    id, name: '', transport: 'streamable-http', command: '', args: [], env: [],
    workingDirectory: '', url: '', headers: [], auth: 'auto', token: '',
    enabled: false, autoStart: true, startupSeconds: '',
  };
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new McpConfigFormError('advancedRequired', 'args');
  }
  if (entry.timeouts !== undefined && !isObject(entry.timeouts)) {
    throw new McpConfigFormError('advancedRequired', 'startupSeconds');
  }
  const startupMs = (entry.timeouts as McpConfigObject | undefined)?.startupMs;
  if (startupMs !== undefined && (typeof startupMs !== 'number' || !Number.isSafeInteger(startupMs) || startupMs <= 0)) {
    throw new McpConfigFormError('advancedRequired', 'startupSeconds');
  }
  return {
    id, name: optionalString(entry, 'name') || id, transport: transportFromConfig(entry),
    command: optionalString(entry, 'command'), args: [...args] as string[],
    env: rowsFromObject(entry.env), workingDirectory: optionalString(entry, 'workingDirectory'),
    url: optionalString(entry, 'url'), headers: rowsFromObject(entry.headers),
    // Existing OAuth options, environment credentials, and custom headers are
    // left untouched unless the user explicitly chooses a different policy.
    auth: 'preserve', token: '', enabled: optionalBoolean(entry, 'enabled', true),
    autoStart: optionalBoolean(entry, 'autoStart', optionalBoolean(entry, 'auto_start', true)),
    startupSeconds: startupMs === undefined ? '' : String(Number(startupMs) / 1000),
  };
}

export function suggestMcpServerId(name: string, existingIds: readonly string[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'mcp-server';
  let id = base;
  for (let suffix = 2; existingIds.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

function rowMap(rows: McpKeyValueRow[], field: 'env' | 'headers'): Record<string, string> {
  const keys = new Set<string>();
  const entries = rows.map(row => {
    const key = row.key.trim();
    const value = row.value ?? row.savedValue ?? '';
    if (!key || (field === 'env' ? /[=\0]/.test(key) : !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key))) {
      throw new McpConfigFormError('invalidKey', field);
    }
    const identity = field === 'headers' ? key.toLowerCase() : key;
    if (keys.has(identity)) throw new McpConfigFormError('duplicateKey', field);
    keys.add(identity);
    if ((field === 'headers' ? /[\r\n\0]/ : /\0/).test(value)) {
      throw new McpConfigFormError('invalidValue', field);
    }
    return [key, value];
  });
  return Object.fromEntries(entries);
}

function validateId(id: string): void {
  if (!id) throw new McpConfigFormError('idRequired', 'id');
  if (!/^[a-z0-9_.-]{1,128}$/i.test(id)) throw new McpConfigFormError('invalidId', 'id');
}

/** Keep identity handling identical for form and advanced JSON writes. */
export function writeMcpServerEntry(
  document: McpConfigDocument,
  serverId: string,
  entry: McpConfigObject,
  originalId?: string,
): McpConfigDocument {
  if (originalId !== undefined && !Object.prototype.hasOwnProperty.call(document.mcpServers, originalId)) {
    throw new McpConfigFormError('invalidConfig');
  }
  const id = originalId ?? serverId.trim();
  if (originalId === undefined) {
    validateId(id);
    if (Object.prototype.hasOwnProperty.call(document.mcpServers, id)) throw new McpConfigFormError('idConflict', 'id');
  }
  return {
    ...document,
    mcpServers: {
      ...document.mcpServers,
      [id]: originalId === undefined ? { ...entry, enabled: false } : entry,
    },
  };
}

/** Edit only owned fields, retaining raw unknown fields and legacy spellings. */
export function mcpServerDraftToConfig(
  draft: McpServerDraft,
  base?: McpConfigObject,
  { validate = true }: { validate?: boolean } = {},
): McpConfigObject {
  const initial = createMcpServerDraft(draft.id, base);
  if (validate && !draft.name.trim()) throw new McpConfigFormError('nameRequired', 'name');
  const local = draft.transport === 'stdio';
  if (validate && local && !draft.command.trim()) throw new McpConfigFormError('commandRequired', 'command');
  if (local && (draft.command.includes('\0') || draft.args.some(arg => arg.includes('\0')))) {
    throw new McpConfigFormError('invalidValue', 'command');
  }
  if (validate && !local) {
    try {
      const url = new URL(draft.url.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch { throw new McpConfigFormError('urlInvalid', 'url'); }
  }
  const entry: McpConfigObject = { ...base };
  const isNew = !base;
  const changedTransport = draft.transport !== initial.transport;
  const patch = (field: string, value: unknown, previous: unknown) => {
    if (isNew || JSON.stringify(value) !== JSON.stringify(previous)) entry[field] = value;
  };
  patch('name', draft.name.trim(), initial.name);
  patch('enabled', draft.enabled, initial.enabled);
  patch('autoStart', draft.autoStart, initial.autoStart);
  if (isNew || changedTransport) {
    delete entry.type;
    delete entry.source;
    entry.transport = draft.transport;
    if (isNew || (initial.transport === 'stdio') !== local) {
      for (const key of local ? ['url', 'headers', 'oauth', 'oauthEnabled', 'xaa'] : ['command', 'args', 'env', 'workingDirectory', 'inheritParentEnvironment']) {
        delete entry[key];
      }
    }
  }
  if (local) {
    patch('command', draft.command.trim(), initial.command);
    patch('args', draft.args, initial.args);
    patch('env', rowMap(draft.env, 'env'), rowMap(initial.env, 'env'));
    if (draft.workingDirectory !== initial.workingDirectory) {
      if (draft.workingDirectory.trim()) entry.workingDirectory = draft.workingDirectory;
      else delete entry.workingDirectory;
    }
  } else {
    patch('url', draft.url.trim(), initial.url);
    const headers = rowMap(draft.headers, 'headers');
    if (draft.auth !== 'preserve') {
      if (typeof entry.oauth === 'boolean') delete entry.oauth;
      entry.oauthEnabled = draft.auth === 'auto' || draft.auth === 'oauth';
      if (draft.auth === 'token') {
        const token = draft.token.trim();
        if (validate && !token) throw new McpConfigFormError('tokenRequired', 'token');
        if (/[\r\n\0]/.test(token)) throw new McpConfigFormError('invalidValue', 'token');
        Object.keys(headers).filter(key => key.toLowerCase() === 'authorization').forEach(key => { delete headers[key]; });
        if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
      }
      if (draft.auth === 'oauth' || draft.auth === 'auto') {
        Object.keys(headers).filter(key => key.toLowerCase() === 'authorization').forEach(key => { delete headers[key]; });
      }
    }
    patch('headers', headers, rowMap(initial.headers, 'headers'));
  }
  if (draft.startupSeconds !== initial.startupSeconds) {
    const timeouts = { ...(isObject(entry.timeouts) ? entry.timeouts : {}) };
    if (draft.startupSeconds.trim()) {
      const seconds = Number(draft.startupSeconds);
      const milliseconds = Math.round(seconds * 1000);
      // Round binary floating-point noise (for example, 1.001 * 1000),
      // but reject values that would lose actual sub-millisecond precision.
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds / 1000 !== seconds) {
        throw new McpConfigFormError('timeoutInvalid', 'startupSeconds');
      }
      timeouts.startupMs = milliseconds;
    } else delete timeouts.startupMs;
    if (Object.keys(timeouts).length) entry.timeouts = timeouts;
    else delete entry.timeouts;
  }
  return entry;
}

export function updateMcpServerConfig(
  document: McpConfigDocument,
  draft: McpServerDraft,
  originalId?: string,
  baseOverride?: McpConfigObject,
): McpConfigDocument {
  const base = baseOverride ?? (originalId === undefined ? undefined : document.mcpServers[originalId]);
  const entry = mcpServerDraftToConfig({ ...draft, id: originalId ?? draft.id }, base);
  return writeMcpServerEntry(document, draft.id, entry, originalId);
}

export function parseMcpImport(text: string, existingIds: readonly string[]): McpImportCandidate[] {
  const document = parseMcpConfigDocument(text);
  const entries = Object.entries(document.mcpServers);
  if (!entries.length) throw new McpConfigFormError('selectServers');
  return entries.map(([sourceId, config]) => {
    const draft = createMcpServerDraft(sourceId, config);
    // Check supported field shapes and connection input before offering import.
    updateMcpServerConfig(document, draft, sourceId);
    return { sourceId, targetId: sourceId, selected: !existingIds.includes(sourceId), config };
  });
}

export function importMcpServers(document: McpConfigDocument, candidates: McpImportCandidate[]): McpConfigDocument {
  const selected = candidates.filter(candidate => candidate.selected);
  if (!selected.length) throw new McpConfigFormError('selectServers');
  let servers = { ...document.mcpServers };
  for (const candidate of selected) {
    const id = candidate.targetId.trim();
    validateId(id);
    if (Object.prototype.hasOwnProperty.call(servers, id)) throw new McpConfigFormError('idConflict', 'id');
    const { _openbitfunImport: _untrustedOrigin, ...entry } = candidate.config;
    // Import is a configuration write, never permission to execute a program.
    servers = { ...servers, [id]: { ...entry, enabled: false } };
  }
  return { ...document, mcpServers: servers };
}
