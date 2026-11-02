import { describe, expect, it } from 'vitest';
import type { ReasoningPresetDescriptor } from '@/infrastructure/config/types';
import {
  presetDisplayLabel, reasoningAutomaticValue, reasoningPresetChoices,
  resolveReasoningPresetChoice,
} from './reasoningPresetPresentation';

const preset = (value: string, order = 0): ReasoningPresetDescriptor => ({
  id: value, label: value, order, source: 'models_dev',
  actions: [{ type: 'effort', value }],
});

describe('reasoning preset presentation', () => {
  it('resolves Auto according to the advertised effort and toggle choices', () => {
    const on: ReasoningPresetDescriptor = { ...preset('on'), actions: [{ type: 'toggle', enabled: true }] };
    const presets = [preset('auto'), preset('none'), on, preset('low'), preset('high')];
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

  it('preserves authored labels', () => {
    const custom: ReasoningPresetDescriptor = { ...preset('high'), label: 'Careful', source: 'model_config' };
    expect(presetDisplayLabel(custom, key => key)).toBe('Careful');
  });
});
