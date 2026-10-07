import { describe, expect, it } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import { buildBuiltinToolCardModel, redactBuiltinToolValue } from './builtinToolCardModel';
import { SEMANTIC_BUILTIN_TOOL_NAMES, type SemanticBuiltinToolName } from './builtinToolCardPolicy';
import { getToolItemCardConfig } from './toolCardMetadata';
import { resolveBuiltinAgentSessions } from './builtinAgentSessions';

const t = (key: string, params?: Record<string, unknown>) => key.replace('toolCards.builtin.', '') + (params ? JSON.stringify(params) : '');
function item(name: string, input: unknown = {}, result?: unknown): FlowToolItem {
  return { id: 'call', type: 'tool', toolName: name, timestamp: 0, status: 'completed',
    toolCall: { id: 'call', input }, toolResult: result === undefined ? undefined : { success: true, result } };
}
function model(name: SemanticBuiltinToolName, input: unknown, result?: unknown, status: FlowToolItem['status'] = 'completed') {
  return buildBuiltinToolCardModel({ ...item(name, input, result), status }, name, t, String);
}

describe('built-in historical result presentation', () => {
  it.each(SEMANTIC_BUILTIN_TOOL_NAMES)('%s preserves unfamiliar results without claiming an empty or successful business outcome', name => {
    const result = { future_schema: { message: 'Preserve this result' } };
    const card = model(name, {}, result);
    expect(card.rawResult).toEqual(result);
    expect(card.emptyContent).toBeUndefined();
    expect(card.outcome).toBeUndefined();
  });

  it('reads goal budget facts without inventing objective completion', () => {
    const card = model('get_goal', {}, { goal: { objective: 'Audit navigation', status: 'active', tokenBudget: 500, tokensUsed: 500, timeUsedSeconds: 12 }, remainingTokens: 0 });
    expect(card.summary).toBe('Audit navigation');
    expect(card.outcome?.label).toBe('states.active');
    expect(card.fields).toContainEqual({ label: 'fields.tokensRemaining', value: '0' });
    expect(card.fields).toContainEqual({ label: 'fields.elapsed', value: 'seconds{"value":"12"}' });
    expect(model('get_goal', {}, {}).emptyContent).toBe('noGoal');
    expect(model('get_goal', {}, undefined).emptyContent).toBeUndefined();
  });

  it.each(['cancelled', 'rejected', 'error'] as const)('preserves %s instead of claiming a business outcome', status => {
    const card = model('PublishMiniApp', {}, { status: 'submitted', success: false }, status);
    expect(card.status).toBe(status);
    expect(card.outcome).toBeUndefined();
  });

  it('retains partial results and nested failure details after successful transport', () => {
    const card = model('ReviewPlatform', { action: 'submit_review' }, JSON.stringify({ ok: true, data: {
      result: { ok: false, error: { message: 'Review rejected' } }, body: 'Partial notes',
    } }));
    expect(card.status).toBe('error'); expect(card.error).toBe('Review rejected');
    expect(card.sections.some(section => section.content === 'Partial notes')).toBe(true);
  });

  it('redacts credentials in params, nested JSON, results and error echoes while omitting binary content', () => {
    const input = { token: 'private-token', credentials: JSON.stringify({ password: 'secret-password' }) };
    const value = { error: 'private-token / secret-password', headers: { Authorization: 'Bearer something' },
      message: JSON.stringify({ api_key: 'another-secret' }), content: [{ type: 'image', data: 'huge-image-bytes', mimeType: 'image/png' }] };
    const redacted = JSON.stringify(redactBuiltinToolValue(value, input, '[hidden]'));
    expect(redacted).not.toMatch(/private-token|secret-password|another-secret|Bearer something|huge-image-bytes/);
    expect(redacted).toContain('image/png');
    const call = item('ReviewPlatform', input, {}); call.toolResult!.error = 'Rejected private-token';
    expect(buildBuiltinToolCardModel(call, 'ReviewPlatform', t, String).error).toBe('Rejected redacted');
  });

  it('uses the actual allocated port and distinguishes local exposure', () => {
    const card = model('PortForward', { operation: 'start', target: 'ssh:dev', local_port: 5173 }, {
      operation: 'start', target: 'ssh:dev', local_address: '127.0.0.1:5174', local_url: 'http://127.0.0.1:5174', local_port_moved: true,
      forward: { id: 'forward-1', remotePort: 3000, localHost: '127.0.0.1', requestedLocalPort: 5173, localPort: 5174 },
    });
    expect(card.connection?.to).toBe('127.0.0.1:5174'); expect(card.notice).toBe('portMoved');
    expect(card.links[0]?.value).toBe('http://127.0.0.1:5174/');
    expect(model('PortForward', { operation: 'start', local_port: 5173 }).links).toEqual([]);
  });

  it.each(['PublishMiniApp', 'PublishAppearance'] as const)('%s separates sign-in, submission and review', name => {
    expect(model(name, {}, { status: 'pending_review', submission_id: 's1' }).outcome?.label).toBe('states.pendingReview');
    expect(model(name, {}, { status: 'submitted', submission_id: 's1' }).outcome?.label).toBe('states.submitted');
    const signIn = model(name, {}, { status: 'sign_in_required', authorization_url: 'https://example.com/auth' });
    expect(signIn.outcome?.label).toBe('states.signIn'); expect(signIn.links[0]?.kind).toBe('url');
    expect(signIn.links[0]?.intent).toBe('primary');
    expect(model(name, {}, { status: 'sign_in_required', authorization_url: 'javascript:alert(1)' }).links).toEqual([]);
  });

  it('shows compile and rollback facts, not a generic success interpretation', () => {
    expect(model('FinalizeMiniApp', {}, { app_id: 'clock', version: '1.0.1', changed: false }).outcome?.label).toBe('states.unchanged');
    const rolledBack = model('FrontendWorkbench', { action: 'apply' }, { status: 'rolled_back', activeRevision: 'old', reason: 'Timeout' });
    expect(rolledBack.outcome).toEqual({ label: 'states.rolledBack', tone: 'warning' });
    expect(rolledBack.sections[0]?.content).toBe('Timeout');
    expect(model('Playbook', { action: 'run' }, { steps: [{ domain: 'browser', action: 'click' }] }).notice).toBe('playbookInstructions');
  });

  it('associates source and session controls with their own recorded objects', () => {
    const workbench = model('FrontendWorkbench', { action: 'prepare' }, {
      files: { css: '/remote/style.css', javascript: '/remote/app.js', apiReference: '/remote/api.md' },
      commands: [{ id: 'inspect', title: 'Inspect UI' }],
    });
    expect(workbench.links).toEqual([]);
    expect(workbench.records.map(record => record.title)).toEqual(['style.css', 'app.js', 'api.md', 'Inspect UI']);
    expect(workbench.records[1].links?.[0].value).toBe('/remote/app.js');
    const trees = model('Worktree', { operation: 'list' }, { worktrees: [{ id: 'tree', path: '/remote/tree', branch: 'topic',
      sessions: [{ sessionId: 'one', sessionName: 'First' }, { sessionId: 'two', sessionName: 'Second' }] }] });
    expect(trees.records[0].links).toEqual([]);
    expect(trees.records[0].fields?.filter(field => field.links).map(field => [field.value, field.links?.[0].value]))
      .toEqual([['/remote/tree', '/remote/tree'], ['First', 'one'], ['Second', 'two']]);
  });

  it('keeps a failed analysis source available without inventing a missing target', () => {
    const failed = model('analyze_image', { path: '/remote/original.png' }, { error: 'Analysis unavailable' }, 'error');
    expect(failed.links).toContainEqual({ kind: 'file', value: '/remote/original.png', label: 'links.openImage' });
    expect(model('analyze_image', {}, { error: 'Missing image' }, 'error').links).toEqual([]);
  });

  it('keeps transcripts, MCP catalogs, image analysis and recorded timestamps inspectable', () => {
    const history = model('SessionHistory', { session_id: 's1', turns: [1, 2] }, { transcript: { transcript_path: '/remote/history.md', index_range: { start_line: 3, end_line: 18 } } });
    expect(history.links[0]?.value).toBe('/remote/history.md');
    expect(history.fields).toContainEqual({ label: 'fields.index', value: '3–18' });
    expect(model('ListMCPResources', {}, { resources: [] }).emptyContent).toBe('empty');
    expect(model('ListMCPResources', {}, { resources: 'unknown' }).emptyContent).toBeUndefined();
    expect(model('analyze_image', { path: '/remote/image.png', prompt: 'Find buttons' }, { analysis: 'Two buttons', width: 800, height: 600 }).sections)
      .toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Two buttons' })]));
    expect(model('GetTime', {}, { local_time: '2025-01-01T12:00:00Z' }).summary).toBe('2025-01-01T12:00:00Z');
  });

  it('deletion reports selected roots separately from total deleted descendants', () => {
    const card = model('AgentDelete', { agent_ids: 'a1' }, { agent_ids: ['a1'], status: 'deleted', deleted_agents: 4 });
    expect(card.records).toHaveLength(1); expect(card.resultSummary).toBe('deletedAgents{"value":"4"}');
    expect(card.notice).toBe('deleteAgentScope');
  });

  it.each([
    ['Worktree', { operation: 'list' }, 'ambient'], ['Worktree', { operation: 'remove' }, 'prominent'],
    ['PortForward', { operation: 'detect' }, 'ambient'], ['PortForward', { operation: 'start' }, 'prominent'],
    ['ReviewPlatform', { action: 'list_pull_requests' }, 'ambient'], ['ReviewPlatform', { action: 'submit_review' }, 'prominent'],
    ['FrontendWorkbench', { action: 'status' }, 'ambient'], ['FrontendWorkbench', { action: 'apply' }, 'prominent'],
  ] as const)('%s shares action classification with deferred streaming wrappers', (name, input, attention) => {
    const call = { ...item('CallDeferredTool', { tool_name: name, args: {} }), isParamsStreaming: true,
      partialParams: { tool_name: name, args: input } };
    expect(buildBuiltinToolCardModel(call, name, t, String).attention).toBe(attention);
    expect(getToolItemCardConfig(call).attention).toBe(attention);
    expect(call.toolName).toBe('CallDeferredTool');
  });

  it('uses recorded operations for old nested results with no input', () => {
    const call = item('Worktree', {}, { ok: true, data: { operation: 'list', worktrees: [] } });
    expect(getToolItemCardConfig(call).attention).toBe('ambient');
    expect(buildBuiltinToolCardModel(call, 'Worktree', t, String).emptyContent).toBe('empty');
  });
});

it('agent alias links stop at the recorded roster and require a real earlier session link', () => {
  const earlier: FlowToolItem = { ...item('AgentSpawn', { agent_id: 'reviewer' }, { session_id: 'child-before' }), id: 'launch' };
  const roster = item('AgentList');
  const later = { ...earlier, id: 'later', toolResult: { success: true, result: { session_id: 'child-after' } } };
  const parent = { sessionId: 'parent', dialogTurns: [{ modelRounds: [{ items: [earlier, roster, later] }] }] } as Session;
  const sessions = new Map([['parent', parent]]);
  expect(resolveBuiltinAgentSessions(roster, sessions, 'parent')).toEqual({ reviewer: 'child-before' });
  expect(resolveBuiltinAgentSessions({ ...roster, id: 'not-hydrated' }, sessions, 'parent')).toEqual({});
  earlier.toolResult = { success: true, result: {} };
  expect(resolveBuiltinAgentSessions(roster, sessions, 'parent')).toEqual({});
});
