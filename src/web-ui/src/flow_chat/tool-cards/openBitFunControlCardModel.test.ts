import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { getToolItemCardConfig } from './toolCardMetadata';
import { buildOpenBitFunControlCardModel, getOpenBitFunControlInput } from './openBitFunControlCardModel';

function call(input: unknown, result?: unknown, status: FlowToolItem['status'] = 'completed'): FlowToolItem {
  return {
    id: 'control-1', type: 'tool', toolName: 'OpenBitFunControl', timestamp: 0, status,
    toolCall: { id: 'call-1', input },
    toolResult: result === undefined ? undefined : { success: true, result },
  };
}

describe('OpenBitFun control card projection', () => {
  it.each([
    ['list', { items: [] }, 'ambient'],
    ['search', { items: [{ capabilityId: 'remote.feature', titleEn: 'Remote feature' }] }, 'ambient'],
    ['get', { capability: { id: 'remote.feature', titleEn: 'Remote feature' } }, 'ambient'],
    ['open', { opened: true }, 'prominent'],
    ['execute', { executed: true }, 'prominent'],
    ['configure', { configured: true }, 'prominent'],
  ])('projects %s with its host acknowledgement and attention level', (action, result, attention) => {
    const item = call({ action }, result);
    expect(buildOpenBitFunControlCardModel(item, 'en-US')).toMatchObject({ action, confirmed: true, failed: false });
    expect(getToolItemCardConfig(item).attention).toBe(attention);
  });

  it.each([
    [{ value_boolean: false }, false], [{ value_integer: 0 }, 0], [{ value_string: '' }, ''],
    [{ value_null: true }, null], [{ value_array: [] }, []], [{ value_object: { enabled: false } }, { enabled: false }],
    [{ value: null }, null],
  ])('preserves typed and legacy configuration values across a history round trip', (valueInput, expected) => {
    const legacy = call(JSON.stringify({ action: 'configure', capabilityId: 'remote.settings', optionId: 'enabled', ...valueInput }),
      JSON.stringify({ configured: true, effectiveValue: expected, futureField: 'preserved' }));
    const reloaded = JSON.parse(JSON.stringify(legacy)) as FlowToolItem;
    const before = JSON.stringify(reloaded);
    const model = buildOpenBitFunControlCardModel(reloaded, 'en-US');
    expect(model).toMatchObject({ capabilityId: 'remote.settings', optionId: 'enabled', confirmed: true });
    expect(model.requestedValue).toEqual(expected);
    expect(model.effectiveValue).toEqual(expected);
    expect(model.result.futureField).toBe('preserved');
    expect(JSON.stringify(reloaded)).toBe(before);
  });

  it('uses executing-host labels first and preserves unknown remote IDs', () => {
    const item = call({ action: 'get', capability_id: 'feature.browser' }, {
      capability: { id: 'feature.browser', titleEn: 'Peer browser', titleZh: '远端浏览器' },
      controlAvailability: { status: 'unavailable', reason: 'No presentation surface' },
    });
    const model = buildOpenBitFunControlCardModel(item, 'en-US', { id: 'feature.browser', titleEn: 'Local browser' });
    expect(model).toMatchObject({ target: 'Peer browser', confirmed: true, failed: false, availability: 'unavailable' });
    expect(buildOpenBitFunControlCardModel(call({ action: 'open', capability_id: 'peer.future-feature' }), 'en-US',
      { id: 'feature.browser', titleEn: 'Local browser' }).target).toBe('peer.future-feature');
  });

  it('does not equate a completed invocation with an applied change or invent an effective value', () => {
    for (const result of [undefined, 'not JSON', [], { success: true }, { futureOutcome: true }]) {
      const model = buildOpenBitFunControlCardModel(call({ action: 'configure', value_boolean: true }, result), 'en-US');
      expect(model.confirmed).toBe(false);
      expect(model.effectiveValue).toBeUndefined();
    }
    expect(buildOpenBitFunControlCardModel(call({ action: 'configure' }, { configured: false }), 'en-US'))
      .toMatchObject({ failed: true, confirmed: false, status: 'error' });
    const failed = call({ action: 'open' }, { opened: true });
    failed.toolResult!.success = false;
    expect(buildOpenBitFunControlCardModel(failed, 'en-US').confirmed).toBe(false);
  });

  it.each(['cancelled', 'rejected'] as const)('preserves %s instead of showing a failure or success', status => {
    const model = buildOpenBitFunControlCardModel(call({ action: 'execute' }, { executed: false, success: false }, status), 'en-US');
    expect(model).toMatchObject({ status, failed: false, confirmed: false });
  });

  it('keeps discovery pagination and partial presentation sync explicit', () => {
    const page = buildOpenBitFunControlCardModel(call({ action: 'search', query: 'theme' },
      { items: [{ id: 'setting.appearance' }], totalCount: 12, nextCursor: 1 }), 'en-US');
    expect(page).toMatchObject({ totalCount: 12, hasMore: true, confirmed: true });
    expect(page.items).toHaveLength(1);
    const saved = buildOpenBitFunControlCardModel(call({ action: 'configure', value_string: 'dark' },
      { configured: true, effectiveValue: 'dark', presentationSync: { status: 'notAttached' } }), 'en-US');
    expect(saved).toMatchObject({ confirmed: true, failed: false, syncPending: true, effectiveValue: 'dark' });
  });

  it('classifies deferred and streamed inputs consistently without losing finalized values', () => {
    const gateway = { ...call({ tool_name: 'OpenBitFunControl', args: { action: 'search', query: 'theme' } }),
      toolName: 'CallDeferredTool' };
    expect(getToolItemCardConfig(gateway).attention).toBe('ambient');
    const projected = projectEffectiveToolItem(gateway);
    projected.isParamsStreaming = true;
    projected.partialParams = { tool_name: 'OpenBitFunControl', args: { action: 'configure', value_boolean: false } };
    expect(getOpenBitFunControlInput(projected)).toMatchObject({ action: 'configure', value_boolean: false });
    expect(getToolItemCardConfig(projected).attention).toBe('prominent');
    projected.isParamsStreaming = false;
    projected.toolCall.input = { action: 'open', capability_id: 'feature.browser' };
    expect(buildOpenBitFunControlCardModel(projected, 'en-US').action).toBe('open');
    expect(getOpenBitFunControlInput(projected)).not.toHaveProperty('value_boolean');
    expect(getToolItemCardConfig(call({ action: 'future-action' })).attention).toBe('prominent');
  });
});
