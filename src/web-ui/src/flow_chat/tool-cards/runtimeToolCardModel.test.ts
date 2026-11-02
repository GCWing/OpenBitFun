import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import {
  buildControlHubCardModel, buildListModelsCardModel, formatRuntimeToolValue,
  isControlHubObservation, runtimeToolNeedsConfirmation,
} from './runtimeToolCardModel';
import { getToolItemCardConfig, isCollapsibleTool, usesDefaultToolCard } from './toolCardMetadata';

function item(toolName: string, input: unknown, result?: unknown): FlowToolItem {
  return { id: 'call', type: 'tool', toolName, timestamp: 0, status: 'completed',
    toolCall: { id: 'call', input }, toolResult: result === undefined ? undefined : { success: true, result } };
}

describe('ListModels presentation', () => {
  it('uses recorded provider, model and configuration identities without substituting current settings', () => {
    const result = JSON.stringify({ success: true, models: [
      { provider_name: 'Remote provider', model_name: 'model-v2', model_id: 'primary-remote' },
      { provider_name: 'Other account', model_name: 'model-v2', model_id: 'other-remote' },
    ] });
    const model = buildListModelsCardModel(item('ListModels', { query: 'primary' }, result));
    expect(model.query).toBe('primary');
    expect(model.models.map(row => [row.name, row.id, row.provider])).toEqual([
      ['model-v2', 'primary-remote', 'Remote provider'], ['model-v2', 'other-remote', 'Other account'],
    ]);
    expect(new Set(model.models.map(row => row.key)).size).toBe(2);
  });

  it('distinguishes a real empty result from pending, missing and unrecognized history', () => {
    expect(buildListModelsCardModel(item('ListModels', {}, { models: [] })).empty).toBe(true);
    expect(buildListModelsCardModel({ ...item('ListModels', {}, { models: [] }), status: 'running' }).empty).toBe(false);
    expect(buildListModelsCardModel(item('ListModels', {})).hasModelList).toBe(false);
    const unknown = buildListModelsCardModel(item('ListModels', {}, { models: [{ future_id: 'm1' }] }));
    expect(unknown.empty).toBe(false);
    expect(unknown.hasModelList).toBe(false);
    expect(unknown.fallback).toEqual({ models: [{ future_id: 'm1' }] });
  });

  it('projects deferred streaming parameters without changing the recorded invocation', () => {
    const call = { ...item('CallDeferredTool', { tool_name: 'ListModels', args: {} }), status: 'streaming' as const,
      isParamsStreaming: true, partialParams: { tool_name: 'ListModels', args: { query: 'fast' } } };
    expect(buildListModelsCardModel(call).query).toBe('fast');
    expect(call.toolName).toBe('CallDeferredTool');
    expect(call.toolCall.input).toEqual({ tool_name: 'ListModels', args: {} });
  });
});

describe('ControlHub presentation', () => {
  it.each([
    ['browser', 'snapshot', true], ['browser', 'screenshot', true], ['browser', 'list_pages', true],
    ['meta', 'capabilities', true], ['terminal', 'list_sessions', true],
    ['browser', 'click', false], ['browser', 'fill', false], ['browser', 'evaluate', false],
    ['browser', 'cdp', false], ['terminal', 'interrupt', false], ['terminal', 'kill', false],
    ['future', 'get', false], ['browser', 'future_action', false],
  ])('keeps %s.%s attention consistent between wrapper and native card', (domain, action, observation) => {
    const input = { domain, action, params: { selector: '@e7' } };
    const call = item('CallDeferredTool', { tool_name: 'ControlHub', args: input });
    const model = buildControlHubCardModel(call);
    expect(isControlHubObservation(input)).toBe(observation);
    expect(model.attention).toBe(observation ? 'ambient' : 'prominent');
    expect(getToolItemCardConfig(call).attention).toBe(model.attention);
    expect(isCollapsibleTool('ControlHub')).toBe(false);
    expect(usesDefaultToolCard('ControlHub')).toBe(false);
    expect(usesDefaultToolCard('ListModels')).toBe(false);
  });

  it('reads structured failures inside successful transport and legacy nested envelopes', () => {
    const failed = { ok: false, domain: 'browser', action: 'click',
      error: { code: 'STALE_REF', message: 'The element reference expired.', hints: ['Read the page again.'] },
      data: { text: 'Partial output' }, warnings: ['Page changed.'] };
    for (const result of [failed, { ok: true, data: failed }]) {
      const model = buildControlHubCardModel(item('ControlHub', { domain: 'browser', action: 'click' }, result));
      expect(model.status).toBe('error');
      expect(model.errorCode).toBe('STALE_REF');
      expect(model.error).toBe('The element reference expired.');
      expect(model.output).toBe('Partial output');
      expect(model.notices).toEqual(['Page changed.', 'Read the page again.']);
    }
  });

  it('preserves cancellation/rejection and does not leave terminal calls awaiting approval', () => {
    for (const status of ['cancelled', 'rejected'] as const) {
      const call = { ...item('ControlHub', { domain: 'terminal', action: 'interrupt' }, { success: false }), status, requiresConfirmation: true };
      expect(buildControlHubCardModel(call).status).toBe(status);
      expect(runtimeToolNeedsConfirmation(call, status)).toBe(false);
    }
  });

  it('shows the snapshot reader and preserves indentation and target identity', () => {
    const model = buildControlHubCardModel(item('ControlHub', { domain: 'browser', action: 'snapshot' }, {
      ok: true, data: { url: 'https://example.org', title: 'Remote page', snapshot: '  @e1 button Save\n', elements: [{ ref: '@e1' }] },
    }));
    expect(model.output).toBe('  @e1 button Save\n');
    expect(model.outputIsCode).toBe(true);
    expect(model.target).toBe('Remote page');
  });

  it('keeps old raw results and future payloads readable', () => {
    const raw = { custom: { value: 42 } };
    expect(buildControlHubCardModel(item('ControlHub', {}, raw)).fallback).toEqual(raw);
    expect(buildControlHubCardModel(item('ControlHub', {}, 'Legacy output')).output).toBe('Legacy output');
    const model = buildControlHubCardModel(item('ControlHub', {}, { ok: true, domain: 'terminal', action: 'list_sessions', data: { sessions: [] } }));
    expect(model.hasRecordList).toBe(true);
    expect(model.attention).toBe('ambient');
  });

  it('preserves remote terminal details and sanitizes internal and binary fields', () => {
    const model = buildControlHubCardModel(item('ControlHub', { domain: 'terminal', action: 'list_sessions' }, {
      sessions: [{ terminal_session_id: 'remote-1', name: 'Build', cwd: '/work/project', status: 'running' }],
    }));
    expect(model.records[0]).toMatchObject({ id: 'remote-1', title: 'Build', description: '/work/project', status: 'running' });
    expect(formatRuntimeToolValue({ _trace: 'private', output: { data_base64: 'binary', text: 'safe' } })).toBe('{\n  "output": {\n    "text": "safe"\n  }\n}');
  });

  it('reports unavailable targets without turning a successful capability query into a failure', () => {
    const model = buildControlHubCardModel(item('ControlHub', { domain: 'meta', action: 'capabilities' }, {
      ok: true, data: { domains: { browser: { available: true, targets: { builtin: { available: false, session_count: 0 } } },
        terminal: { available: false, reason: 'No terminal host' } } },
    }));
    expect(model.status).toBe('completed');
    expect(model.capabilities).toContainEqual({ key: 'browser.builtin', domain: 'browser', target: 'builtin', available: false, sessionCount: 0, reason: undefined });
    expect(model.capabilities.find(entry => entry.domain === 'terminal')?.reason).toBe('No terminal host');
  });
});
