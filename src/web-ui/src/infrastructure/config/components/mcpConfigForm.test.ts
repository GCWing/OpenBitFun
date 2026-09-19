import { describe, expect, it } from 'vitest';
import {
  createMcpServerDraft, importMcpServers, parseMcpConfigDocument, parseMcpImport,
  suggestMcpServerId, updateMcpServerConfig, type McpConfigObject,
} from './mcpConfigForm';

const documentWith = (entry: McpConfigObject) => parseMcpConfigDocument(JSON.stringify({
  extension: { keep: [1, { future: true }] },
  mcpServers: { existing: entry, other: { command: 'other', enabled: true } },
}));

describe('MCP visual configuration compatibility', () => {
  it.each([
    { command: 'npx', args: ['-y', '@example/server', 'C:\\A directory', ''], env: { TOKEN: ' secret ', EMPTY: '' } },
    { type: 'local', command: 'uvx', auto_start: false, inheritParentEnvironment: false, future: { version: 2 } },
    { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' }, oauth: false },
    { type: 'sse', url: 'https://example.test/sse', oauthEnabled: false, autoStart: false },
    { type: 'http', url: 'https://example.test/mcp', oauth: { scopes: ['read'], callbackPort: 3210 }, xaa: { issuer: 'issuer' } },
    { source: 'remote', transport: 'streamable_http', url: 'https://example.test/mcp', timeouts: { startupMs: 12001, catalogMs: 7000, future: 23 } },
    { type: ' remote ', transport: ' http ', source: ' remote ', url: 'https://example.test/mcp' },
    { type: 'local', source: 'remote', transport: 'http', url: 'https://example.test/mcp' },
  ])('round-trips existing data without adding defaults or dropping fields: %j', entry => {
    const document = documentWith(entry);
    const original = JSON.stringify(document);
    const result = updateMcpServerConfig(document, createMcpServerDraft('existing', entry), 'existing');
    expect(result).toEqual(document);
    expect(JSON.stringify(document)).toBe(original);
  });

  it('renames the display name without changing identity, provenance, credentials, or other servers', () => {
    const entry = { command: 'server', env: { TOKEN: 'secret' }, _openbitfunImport: { sourceCandidateId: 'origin' }, future: ['keep'] };
    const document = documentWith(entry);
    const draft = createMcpServerDraft('existing', entry);
    draft.name = 'Renamed';
    draft.id = 'must-not-rename-the-identity';
    const result = updateMcpServerConfig(document, draft, 'existing');
    expect(result.mcpServers.existing).toEqual({ ...entry, name: 'Renamed' });
    expect(result.mcpServers.other).toEqual(document.mcpServers.other);
    expect(result.extension).toEqual(document.extension);
    expect(Object.keys(result.mcpServers)).toEqual(['existing', 'other']);
  });

  it('creates a disabled HTTP server without executing or replacing existing entries', () => {
    const document = documentWith({ command: 'original' });
    const draft = { ...createMcpServerDraft(), id: 'docs', name: 'Docs', url: 'https://docs.test/mcp' };
    const result = updateMcpServerConfig(document, draft);
    expect(result.mcpServers.docs).toMatchObject({ name: 'Docs', url: 'https://docs.test/mcp', transport: 'streamable-http', enabled: false });
    expect(result.mcpServers.existing).toEqual(document.mcpServers.existing);
    expect(() => updateMcpServerConfig(document, { ...draft, id: 'existing' })).toThrow('idConflict');
  });

  it('retains argument boundaries and distinguishes empty values, replacement, and deletion', () => {
    const entry = { command: 'npx', env: { SAVED: 'do-not-echo', CLEAR: 'old', DELETE: 'old' } };
    const document = documentWith(entry);
    const draft = createMcpServerDraft('existing', entry);
    expect(draft.env[0].value).toBeUndefined();
    draft.args = ['-y', '@example/server', 'a path with spaces', '', '--flag=a b'];
    draft.env = [draft.env[0], { ...draft.env[1], value: '' }];
    const saved = updateMcpServerConfig(document, draft, 'existing').mcpServers.existing;
    expect(saved.args).toEqual(draft.args);
    expect(saved.env).toEqual({ SAVED: 'do-not-echo', CLEAR: '' });
  });

  it('updates timeout units without losing other phases or future timeout fields', () => {
    const entry = { command: 'server', timeouts: { startupMs: 1000, catalogMs: 2000, future: 'keep' } };
    const document = documentWith(entry);
    const draft = createMcpServerDraft('existing', entry);
    for (const [seconds, milliseconds] of [['1.25', 1250], ['1.001', 1001], ['0.001', 1]] as const) {
      draft.startupSeconds = seconds;
      expect(updateMcpServerConfig(document, draft, 'existing').mcpServers.existing.timeouts).toEqual({ startupMs: milliseconds, catalogMs: 2000, future: 'keep' });
    }
    draft.startupSeconds = '';
    expect(updateMcpServerConfig(document, draft, 'existing').mcpServers.existing.timeouts).toEqual({ catalogMs: 2000, future: 'keep' });
    for (const invalid of ['0', '-1', 'NaN', '0.0001', '1e20']) {
      expect(() => updateMcpServerConfig(document, { ...draft, startupSeconds: invalid }, 'existing')).toThrow('timeoutInvalid');
    }
  });

  it('changes transport without conflicting legacy aliases and leaves the source draft intact', () => {
    const entry = { type: 'stdio', source: 'local', command: 'server', args: ['--old'], env: { SECRET: 'old' }, future: { keep: true } };
    const document = documentWith(entry);
    const draft = { ...createMcpServerDraft('existing', entry), transport: 'streamable-http' as const, url: 'https://example.test/mcp' };
    const saved = updateMcpServerConfig(document, draft, 'existing').mcpServers.existing;
    expect(saved).toEqual({ transport: 'streamable-http', url: draft.url, future: { keep: true } });
    expect(draft.env[0].savedValue).toBe('old');
    expect(document.mcpServers.existing).toEqual(entry);
  });

  it('preserves custom headers while replacing Authorization and legacy OAuth flags', () => {
    const entry = { url: 'https://example.test/mcp', oauth: false, headers: { authorization: 'Basic old', 'X-Account': 'org' } };
    const document = documentWith(entry);
    const draft = createMcpServerDraft('existing', entry);
    draft.auth = 'token'; draft.token = 'new-token';
    const saved = updateMcpServerConfig(document, draft, 'existing').mcpServers.existing;
    expect(saved.headers).toEqual({ 'X-Account': 'org', Authorization: 'Bearer new-token' });
    expect(saved.oauthEnabled).toBe(false);
    expect(saved).not.toHaveProperty('oauth');
    draft.auth = 'oauth';
    const oauth = updateMcpServerConfig(document, draft, 'existing').mcpServers.existing;
    expect(oauth.headers).toEqual({ 'X-Account': 'org' });
    expect(oauth.oauthEnabled).toBe(true);
  });

  it('rejects ambiguous Header names and header injection before persistence', () => {
    const document = documentWith({ url: 'https://example.test/mcp' });
    const draft = createMcpServerDraft('existing', document.mcpServers.existing);
    draft.headers = [{ key: 'X-Key', value: 'one' }, { key: 'x-key', value: 'two' }];
    expect(() => updateMcpServerConfig(document, draft, 'existing')).toThrow('duplicateKey');
    draft.headers = [{ key: 'X-Key', value: 'token\r\nInjected: true' }];
    expect(() => updateMcpServerConfig(document, draft, 'existing')).toThrow('invalidValue');
  });

  it.each([{ args: [1], command: 'server' }, { env: { KEY: { secretRef: 'future' } }, command: 'server' }, { transport: 'future', url: 'https://example.test' }])('requires advanced JSON instead of losing unsupported fields: %j', entry => {
    expect(() => createMcpServerDraft('existing', entry)).toThrow('advancedRequired');
  });

  it.each([
    { source: 'remote', command: 'server' },
    { source: 'local', url: 'https://example.test/mcp' },
    { type: 'local', transport: 'http', url: 'https://example.test/mcp' },
    { transport: 'remote', url: 'https://example.test/mcp' },
  ])('rejects transport contradictions the runtime cannot apply: %j', entry => {
    expect(() => parseMcpImport(JSON.stringify({ mcpServers: { invalid: entry } }), [])).toThrow('advancedRequired');
  });

  it('preserves advanced JSON edits on a return to the form', () => {
    const document = documentWith({ command: 'server', future: { old: true } });
    const raw = { command: 'other-command', future: { addedInJson: true }, env: { KEY: 'secret' } };
    const draft = createMcpServerDraft('existing', raw);
    draft.name = 'Edited in form';
    expect(updateMcpServerConfig(document, draft, 'existing', raw).mcpServers.existing).toEqual({ ...raw, name: draft.name });
  });

  it('treats special object keys as data without prototype mutation', () => {
    const document = parseMcpConfigDocument('{"mcpServers":{"__proto__":{"command":"server"}}}');
    const draft = createMcpServerDraft('__proto__', document.mcpServers.__proto__);
    draft.name = 'Renamed';
    const updated = updateMcpServerConfig(document, draft, '__proto__');
    expect(Object.prototype.hasOwnProperty.call(updated.mcpServers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(updated.mcpServers)).toBe(Object.prototype);
    expect(updated.mcpServers.__proto__).toEqual({ command: 'server', name: 'Renamed' });
  });

  it('generates unique stable IDs without treating display names as shell commands', () => {
    expect(suggestMcpServerId('Team Docs', ['team-docs', 'team-docs-2'])).toBe('team-docs-3');
    expect(suggestMcpServerId('知识库', ['mcp-server'])).toBe('mcp-server-2');
  });
});

describe('MCP import preview', () => {
  it('skips conflicts until explicitly renamed and keeps imports disabled', () => {
    const document = documentWith({ command: 'original' });
    const candidates = parseMcpImport(JSON.stringify({ mcpServers: {
      existing: { command: 'replacement', enabled: true },
      docs: { url: 'https://example.test/mcp', enabled: true, future: [1], _openbitfunImport: { forged: true } },
    } }), Object.keys(document.mcpServers));
    expect(candidates.map(item => item.selected)).toEqual([false, true]);
    const imported = importMcpServers(document, candidates);
    expect(imported.mcpServers.existing).toEqual({ command: 'original' });
    expect(imported.mcpServers.docs).toEqual({ url: 'https://example.test/mcp', enabled: false, future: [1] });
    candidates[0].selected = true;
    expect(() => importMcpServers(document, candidates)).toThrow('idConflict');
    candidates[0].targetId = 'separate-server';
    expect(importMcpServers(document, candidates).mcpServers['separate-server']).toEqual({ command: 'replacement', enabled: false });
    expect(candidates[1].config.enabled).toBe(true);
  });

  it('rejects invalid inputs and duplicate selected target IDs without replacing the document', () => {
    const document = documentWith({ command: 'original' });
    const candidates = parseMcpImport('{"mcpServers":{"a":{"command":"a"},"b":{"command":"b"}}}', []);
    candidates[1].targetId = 'a';
    expect(() => importMcpServers(document, candidates)).toThrow('idConflict');
    expect(() => importMcpServers(document, [])).toThrow('selectServers');
    for (const raw of ['{bad', 'null', '{"mcpServers":[]}', '{"mcpServers":{"a":null}}']) {
      expect(() => parseMcpImport(raw, [])).toThrow();
    }
    expect(document.mcpServers.existing).toEqual({ command: 'original' });
  });
});
