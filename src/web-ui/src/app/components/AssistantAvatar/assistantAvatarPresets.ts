import inkMintAvatar from '@/flow_chat/assets/subagent-avatars/robot-04.svg';

export const ASSISTANT_AVATAR_PRESETS = [
  {
    id: 'joystick-ink-mint',
    family: 'joystick',
    imageSrc: inkMintAvatar,
  },
] as const;

export type AssistantAvatarPreset = typeof ASSISTANT_AVATAR_PRESETS[number];
export type AssistantAvatarPresetId = AssistantAvatarPreset['id'];
export type AssistantAvatarFamily = AssistantAvatarPreset['family'];

const PRESETS_BY_ID = new Map<string, AssistantAvatarPreset>(
  ASSISTANT_AVATAR_PRESETS.map((preset) => [preset.id, preset]),
);

// Keep persisted Claw and earlier preset IDs readable after retiring their artwork.
const LEGACY_PRESET_ALIASES = new Map<string, AssistantAvatarPresetId>([
  ['claw', 'joystick-ink-mint'],
  ['claw-orbit', 'joystick-ink-mint'],
  ['signal-pulse', 'joystick-ink-mint'],
  ['signal-wave', 'joystick-ink-mint'],
  ['orbit-nova', 'joystick-ink-mint'],
  ['orbit-loop', 'joystick-ink-mint'],
  ['mosaic-grid', 'joystick-ink-mint'],
  ['mosaic-stack', 'joystick-ink-mint'],
  ['companion-spark', 'joystick-ink-mint'],
  ['companion-calm', 'joystick-ink-mint'],
]);

export function getAssistantAvatarPreset(value?: string | null): AssistantAvatarPreset | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  const canonicalId = LEGACY_PRESET_ALIASES.get(normalized) ?? normalized;
  return PRESETS_BY_ID.get(canonicalId) ?? null;
}

export function resolveAssistantAvatarPreset(
  value?: string | null,
  _stableKey?: string | null,
): AssistantAvatarPreset {
  return getAssistantAvatarPreset(value) ?? ASSISTANT_AVATAR_PRESETS[0];
}
