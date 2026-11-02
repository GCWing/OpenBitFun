import type { ReasoningPresetDescriptor } from '@/infrastructure/config/types';

type Translate = (key: string, options?: Record<string, unknown>) => string;
const effortLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningPresetSemanticKey = typeof effortLevels[number] | 'off' | 'on' | 'auto' | 'adaptive';

function semanticKey(value: string): ReasoningPresetSemanticKey | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return 'off';
  return [...effortLevels, 'off', 'on', 'auto', 'adaptive'].includes(normalized)
    ? normalized as ReasoningPresetSemanticKey : undefined;
}

export function presetLabel(preset: ReasoningPresetDescriptor, t: Translate): string {
  if (preset.source === 'model_config') return preset.label || preset.id;
  return t(`reasoningEffort.${preset.id}`, { defaultValue: preset.label || preset.id });
}

export function presetDisplayLabel(preset: ReasoningPresetDescriptor, t: Translate): string {
  const fallback = presetLabel(preset, t);
  if (isAutomaticReasoningPreset(preset)) return t('reasoningSelector.auto');
  if (preset.source === 'model_config') return fallback;
  const meaning = presetSemanticKey(preset);
  return meaning ? t(`reasoningSelector.levels.${meaning}`, { defaultValue: fallback }) : fallback;
}

export function presetSemanticKey(preset: ReasoningPresetDescriptor): ReasoningPresetSemanticKey | undefined {
  if (preset.effective_effort) return semanticKey(preset.effective_effort);
  // Actions own meaning. Authored names never turn a budget or patch into an effort level.
  if (preset.actions.some(action => action.type === 'request_patch')) return undefined;
  const toggle = preset.actions.find(action => action.type === 'toggle');
  if (toggle?.type === 'toggle' && !toggle.enabled) return 'off';
  const effort = preset.actions.find(action => action.type === 'effort');
  if (effort?.type === 'effort') return semanticKey(effort.value);
  if (preset.actions.some(action => action.type === 'budget_tokens')) return undefined;
  if (toggle?.type === 'toggle') return 'on';
  return preset.source === 'model_config' ? undefined : semanticKey(preset.id);
}

export function reasoningPresetKind(preset: ReasoningPresetDescriptor): 'level' | 'budget' | 'special' | 'custom' {
  const meaning = presetSemanticKey(preset);
  if (meaning === 'off' || meaning === 'on' || meaning === 'auto' || meaning === 'adaptive') return 'special';
  if (preset.actions.some(action => action.type === 'request_patch')) return 'custom';
  if (preset.actions.some(action => action.type === 'effort')) return 'level';
  if (preset.actions.some(action => action.type === 'budget_tokens')) return 'budget';
  return meaning ? 'level' : 'custom';
}

function equivalenceKey(preset: ReasoningPresetDescriptor): string {
  // Only the executing adapter may declare provider aliases equivalent.
  // Authored presets may combine effort with other actions and keep their names.
  if (preset.source !== 'model_config' && presetSemanticKey(preset) === 'off') return 'special:off';
  return preset.source !== 'model_config' && preset.effective_effort
    ? `effort:${preset.effective_effort}` : `preset:${preset.id}`;
}

export function isAutomaticReasoningPreset(preset: ReasoningPresetDescriptor): boolean {
  const meaning = presetSemanticKey(preset);
  return (meaning === 'on' || meaning === 'auto' || meaning === 'adaptive')
    && (preset.source !== 'model_config' || ['on', 'auto', 'adaptive'].includes(preset.id));
}

/** One Auto choice; the execution channel owns its concrete request. */
export function reasoningAutomaticValue(
  presets: ReasoningPresetDescriptor[],
  allowDefaultReset: boolean,
): string | null | undefined {
  const automatic = presets.filter(isAutomaticReasoningPreset);
  const explicit = automatic.find(preset => presetSemanticKey(preset) !== 'on');
  if (explicit) return explicit.id;
  // Toggle-only models need an explicit enable action to leave Off.
  const hasIntensity = presets.some(preset => ['level', 'budget'].includes(reasoningPresetKind(preset)));
  if ((!hasIntensity || !allowDefaultReset) && automatic.length > 0) return automatic[0].id;
  return allowDefaultReset ? null : undefined;
}

export function reasoningPresetChoices(presets: ReasoningPresetDescriptor[]): ReasoningPresetDescriptor[] {
  const choices = new Map<string, ReasoningPresetDescriptor>();
  for (const preset of [...presets].sort((left, right) => left.order - right.order)) {
    const key = equivalenceKey(preset);
    const existing = choices.get(key);
    const canonical = preset.actions.some(action => action.type === 'effort' && action.value === preset.effective_effort);
    if (!existing || canonical) choices.set(key, preset);
  }
  return [...choices.values()];
}

export function resolveReasoningPresetChoice(
  preset: ReasoningPresetDescriptor | undefined,
  presets: ReasoningPresetDescriptor[],
): ReasoningPresetDescriptor | undefined {
  return preset && (reasoningPresetChoices(presets).find(candidate => equivalenceKey(candidate) === equivalenceKey(preset)) ?? preset);
}

export function reasoningSelectionLabel(
  selected: ReasoningPresetDescriptor | undefined,
  t: Translate,
): string {
  return selected ? presetDisplayLabel(selected, t) : t('reasoningSelector.auto');
}
