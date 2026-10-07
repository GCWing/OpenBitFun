import { describe, expect, it } from 'vitest';
import type { ReasoningPresetDescriptor } from '@/infrastructure/config/types';
import {
  presetDisplayLabel, reasoningAutomaticValue, reasoningPresetChoices,
  reasoningVisualTier, resolveReasoningPresetChoice,
} from './reasoningPresetPresentation';

const preset = (value: string, order = 0): ReasoningPresetDescriptor => ({
  id: value, label: value, order, source: 'models_dev',
  actions: [{ type: 'effort', value }],
});

describe('reasoning preset presentation', () => {
  it.each([
    [['high', 'max'], [1, 4]],
    [['low', 'high', 'max'], [1, 3, 4]],
    [['low', 'medium', 'xhigh'], [1, 3, 4]],
    [['minimal', 'low', 'medium', 'high'], [1, 2, 3, 4]],
    [['low', 'medium', 'high', 'xhigh', 'max'], [1, 2, 3, 3, 4]],
  ])('maps advertised levels %j to four materials with an exclusive peak', (levels, expected) => {
    const presets = (levels as string[]).map(preset);
    expect(presets.map(item => reasoningVisualTier(item, presets))).toEqual(expected);
    expect(reasoningPresetChoices(presets)).toHaveLength(levels.length);
  });

  it('does not rank automatic, off or toggle values as reasoning levels', () => {
    const on: ReasoningPresetDescriptor = { ...preset('on'), actions: [{ type: 'toggle', enabled: true }] };
    const presets = [preset('auto'), preset('none'), on, preset('low'), preset('high')];
    expect(presets.map(item => reasoningVisualTier(item, presets))).toEqual([1, 1, 1, 1, 4]);
    expect(reasoningAutomaticValue(presets, false)).toBe('auto');
    expect(reasoningAutomaticValue([on, preset('none')], true)).toBe('on');
    expect(reasoningAutomaticValue([on, preset('low'), preset('high')], true)).toBeNull();
    expect(reasoningAutomaticValue([preset('low'), preset('high')], false)).toBeUndefined();
  });

  it('groups only adapter-confirmed aliases and keeps a legacy selection readable', () => {
    const presets = ['low', 'medium', 'high', 'xhigh', 'max'].map((value, index) => ({
      ...preset(value, index), effective_effort: index < 3 ? 'high' : 'max',
    }));
    expect(reasoningPresetChoices(presets).map(item => item.id)).toEqual(['high', 'max']);
    expect(resolveReasoningPresetChoice(presets[0], presets)?.id).toBe('high');
    expect(presets[0].actions).toEqual([{ type: 'effort', value: 'low' }]);
    expect(reasoningPresetChoices(presets.map(({ effective_effort: _, ...item }) => item))).toHaveLength(5);
  });

  it('preserves authored labels and compares budgets by their actual token amounts', () => {
    const custom: ReasoningPresetDescriptor = { ...preset('high'), label: 'Careful', source: 'model_config' };
    expect(presetDisplayLabel(custom, key => key)).toBe('Careful');
    const budgets = [8192, 1024, 4096].map((value, order): ReasoningPresetDescriptor => ({
      ...preset(`budget-${value}`, order), actions: [{ type: 'budget_tokens', value }],
    }));
    expect(budgets.map(item => reasoningVisualTier(item, budgets))).toEqual([4, 1, 3]);
    const patch: ReasoningPresetDescriptor = { ...preset('max'), actions: [{ type: 'request_patch', body: { custom: true } }] };
    expect(reasoningVisualTier(patch, [patch])).toBe(1);
  });
});
