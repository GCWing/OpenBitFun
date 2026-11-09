import { describe, expect, it } from 'vitest';
import { magpieConnections, magpieGatewayUrl, magpieModelImportIssue, mergeMagpieModels } from './magpieModels';
import type { AIModelConfig } from '../types';
const base = 'http://127.0.0.1:3425/v1';
const key = 'magpie-openbitfun';
const legacy: AIModelConfig = { id: 'legacy', name: 'Magpie', provider: 'openai', base_url: base,
  api_key: key, model_name: 'group/work', enabled: false, category: 'general_chat', capabilities: ['text_chat'],
  metadata: { future: { keep: true } }, custom_headers: { 'x-custom': 'keep' }, context_window: 1234 };

describe('Magpie source import', () => {
  it('preserves references, unavailable models and unknown settings while importing idempotently', () => {
    const catalog = [{ id: 'provider/new', tool_call: true, context_window: 100000 }];
    const first = mergeMagpieModels([legacy], catalog, ['provider/new'], base, key);
    expect(first[0]).toMatchObject(legacy);
    expect(first[1]).toMatchObject({ id: 'provider/new', capabilities: ['text_chat', 'function_calling'], context_window: 100000 });
    expect(mergeMagpieModels(first, catalog, ['provider/new'], base, key)).toEqual(first);
    expect(magpieConnections(first)).toHaveLength(1);
  });
  it('keeps unknown context and capabilities unknown and preserves exact catalog IDs', () => {
    const result = mergeMagpieModels([], [{ id: 'group/Case:high' }], ['group/Case:high'], base, key);
    expect(result[0]).toMatchObject({ model_name: 'group/Case:high', capabilities: ['text_chat'] });
    expect(result[0].context_window).toBeUndefined();
    expect(result[0].max_tokens).toBeUndefined();
  });
  it('updates one connection credentials without changing other connections or stable IDs', () => {
    const unrelated = { ...legacy, id: 'other', base_url: 'https://other.test/v1', api_key: 'other' };
    const first = mergeMagpieModels([legacy, unrelated], [], [], base, key);
    const connection = magpieConnections(first)[0];
    const next = mergeMagpieModels(first, [], [], 'https://remote.test/prefix/v1', 'new-key', connection);
    expect(next[0]).toMatchObject({ id: 'legacy', enabled: false, api_key: 'new-key', base_url: 'https://remote.test/prefix/v1' });
    expect(next[1]).toEqual(unrelated);
    expect(magpieConnections(next)[0].baseUrl).toBe('https://remote.test/prefix/v1');
  });
  it('fits advertised output ceilings to the host budget without inflating context', () => {
    const result = mergeMagpieModels([], [{ id: 'provider/big', context_window: 200000, max_output_tokens: 128000 }], ['provider/big'], base, key);
    expect(result[0]).toMatchObject({ context_window: 200000, max_tokens: 80000, metadata: { magpie_max_output_tokens: 128000 } });
    expect(magpieModelImportIssue({ id: 'small', context_window: 8192 })).toBe('contextTooSmall');
    expect(magpieModelImportIssue({ id: 'invalid', context_window: 2 ** 32 })).toBe('invalidLimits');
    expect(() => mergeMagpieModels([], [{ id: 'small', context_window: 8192 }], ['small'], base, key)).toThrow('Unsupported Magpie model limits');
  });
  it('does not identify a generic loopback configuration as Magpie', () => {
    expect(magpieConnections([{ ...legacy, name: 'Other local service' }])).toEqual([]);
    expect(magpieConnections([{ ...legacy, name: 'Renamed gateway', metadata: { model_source: 'magpie' } }])).toHaveLength(1);
  });
  it('normalizes root and versioned addresses with reverse-proxy prefixes', () => {
    expect(magpieGatewayUrl('https://gateway.test/proxy/v1/')).toBe('https://gateway.test/proxy/v1');
    expect(magpieGatewayUrl('https://gateway.test/proxy')).toBe('https://gateway.test/proxy/v1');
  });
});
