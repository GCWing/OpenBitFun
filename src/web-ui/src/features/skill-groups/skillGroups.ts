import type { UserSkillGroup, UserSkillGroupsConfig } from '@/infrastructure/config/types';

export const USER_SKILL_GROUPS_CONFIG_PATH = 'app.user_skill_groups';
const USER_SKILL_GROUPS_CONFIG_VERSION = 1;

export type SkillGroupErrorCode = 'invalidConfig' | 'unsupportedVersion' | 'nameRequired'
  | 'nameDuplicate' | 'conflict' | 'notReady';

export class SkillGroupError extends Error {
  constructor(readonly code: SkillGroupErrorCode) {
    super(`Skill group operation failed: ${code}`);
    this.name = 'SkillGroupError';
  }
}

export interface GroupableSkill {
  key: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  groupKey?: string | null;
  isShadowed?: boolean;
  level?: string;
  sourceLabel?: string;
  sourceSlot?: string;
  runtimeStatus?: string;
}

export type ResolvedSkillGroupKind = 'user' | 'builtin' | 'other';

export interface ResolvedSkillGroup {
  id: string;
  kind: ResolvedSkillGroupKind;
  label: string;
  skills: GroupableSkill[];
  skillKeys: string[];
  unavailableSkillKeys: string[];
}

export interface SkillGroupLabels {
  builtin: (groupKey: string) => string;
  other: string;
}

const BUILTIN_SKILL_GROUP_ORDER = [
  'meta',
  'miniapp',
  'computer-use',
  'office',
  'canvas',
  'debugging',
  'coordination',
  'planning',
];

const BUILTIN_SKILL_GROUP_LABEL_KEYS: Record<string, string> = {
  office: 'office',
  'computer-use': 'computerUse',
  meta: 'meta',
  miniapp: 'miniapp',
  canvas: 'canvas',
  debugging: 'debugging',
  coordination: 'coordination',
  planning: 'planning',
};

function normalizeSkillKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !key.trim())) {
    throw new SkillGroupError('invalidConfig');
  }
  return [...new Set(value.filter((key): key is string => (
    typeof key === 'string' && key.trim().length > 0
  )).map((key) => key.trim()))];
}

function normalizeUserSkillGroup(value: unknown): UserSkillGroup {
  if (!value || typeof value !== 'object') {
    throw new SkillGroupError('invalidConfig');
  }
  const group = value as Partial<UserSkillGroup>;
  const id = typeof group.id === 'string' ? group.id.trim() : '';
  const name = typeof group.name === 'string' ? group.name.trim() : '';
  if (!id || !name) {
    throw new SkillGroupError('invalidConfig');
  }
  return { id, name, skillKeys: normalizeSkillKeys(group.skillKeys) };
}

function activeSkills(skills: GroupableSkill[]): GroupableSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.key.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortSkills(skills: GroupableSkill[]): GroupableSkill[] {
  return [...skills].sort((left, right) => (
    left.name.localeCompare(right.name) || left.key.localeCompare(right.key)
  ));
}

function builtinSkillGroupOrder(groupKey: string): number {
  const index = BUILTIN_SKILL_GROUP_ORDER.indexOf(groupKey);
  return index === -1 ? BUILTIN_SKILL_GROUP_ORDER.length : index;
}

export function builtinSkillGroupLabelKey(groupKey: string): string | null {
  return BUILTIN_SKILL_GROUP_LABEL_KEYS[groupKey] ?? null;
}

export function normalizeUserSkillGroupsConfig(value: unknown): UserSkillGroupsConfig {
  // Missing on older installs; unreadable or future data must never become an empty write.
  if (value === undefined || value === null) {
    return { version: USER_SKILL_GROUPS_CONFIG_VERSION, groups: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new SkillGroupError('invalidConfig');
  const record = value as Partial<UserSkillGroupsConfig>;
  const version = record.version ?? USER_SKILL_GROUPS_CONFIG_VERSION;
  if (version !== USER_SKILL_GROUPS_CONFIG_VERSION) throw new SkillGroupError('unsupportedVersion');
  if (!Array.isArray(record.groups)) throw new SkillGroupError('invalidConfig');
  const groups = record.groups.map(normalizeUserSkillGroup);
  if (new Set(groups.map(group => group.id)).size !== groups.length) {
    throw new SkillGroupError('invalidConfig');
  }
  return { version, groups };
}

export function createUserSkillGroupsConfig(groups: UserSkillGroup[]): UserSkillGroupsConfig {
  return normalizeUserSkillGroupsConfig({
    version: USER_SKILL_GROUPS_CONFIG_VERSION,
    groups,
  });
}

export function resolveSkillGroups(
  skills: GroupableSkill[],
  userGroups: UserSkillGroup[],
  labels: SkillGroupLabels,
): ResolvedSkillGroup[] {
  const availableSkills = activeSkills(skills);
  const availableByKey = new Map(availableSkills.map((skill) => [skill.key, skill]));
  const resolvedUserGroups = userGroups.map((group) => {
    const groupSkills = group.skillKeys
      .map((key) => availableByKey.get(key))
      .filter((skill): skill is GroupableSkill => skill !== undefined);
    return {
      id: `user:${group.id}`, kind: 'user' as const, label: group.name,
      skills: sortSkills(groupSkills), skillKeys: group.skillKeys,
      unavailableSkillKeys: group.skillKeys.filter(key => !availableByKey.has(key)),
    };
  });

  const builtinByGroup = new Map<string, GroupableSkill[]>();
  for (const skill of availableSkills) {
    const groupKey = skill.isBuiltin ? skill.groupKey?.trim() : '';
    if (!groupKey) {
      continue;
    }
    const groupSkills = builtinByGroup.get(groupKey) ?? [];
    groupSkills.push(skill);
    builtinByGroup.set(groupKey, groupSkills);
  }
  const resolvedBuiltinGroups = [...builtinByGroup.entries()]
    .map(([groupKey, groupSkills]) => ({
      id: `builtin:${groupKey}`,
      kind: 'builtin' as const,
      label: labels.builtin(groupKey),
      skills: sortSkills(groupSkills),
      skillKeys: groupSkills.map(skill => skill.key),
      unavailableSkillKeys: [],
      groupKey,
    }))
    .sort((left, right) => (
      builtinSkillGroupOrder(left.groupKey) - builtinSkillGroupOrder(right.groupKey)
      || left.label.localeCompare(right.label)
    ));

  return [...resolvedUserGroups, ...resolvedBuiltinGroups];
}

/** Browsing categories belong only in the picker, never in the managed group collection. */
export function resolveSkillSelectionGroups(
  skills: GroupableSkill[],
  userGroups: UserSkillGroup[],
  labels: SkillGroupLabels,
): ResolvedSkillGroup[] {
  const groups = resolveSkillGroups(skills, userGroups, labels);
  const groupedKeys = new Set(groups.flatMap(group => group.skillKeys));
  const otherSkills = sortSkills(activeSkills(skills).filter(skill => !groupedKeys.has(skill.key)));
  const otherGroup = otherSkills.length > 0
    ? [{
      id: 'other', kind: 'other' as const, label: labels.other, skills: otherSkills,
      skillKeys: otherSkills.map(skill => skill.key), unavailableSkillKeys: [],
    }]
    : [];

  return [...groups, ...otherGroup];
}

export function resolveSkillGroupSummary(
  skills: GroupableSkill[],
  userGroups: UserSkillGroup[],
  selectedSkillKeys: readonly string[],
  labels: SkillGroupLabels,
): ResolvedSkillGroup[] {
  const selected = new Set(selectedSkillKeys);
  const displayed = new Set<string>();
  return resolveSkillSelectionGroups(skills, userGroups, labels).flatMap((group) => {
    const groupSkills = group.skills.filter((skill) => {
      if (!selected.has(skill.key) || displayed.has(skill.key)) {
        return false;
      }
      displayed.add(skill.key);
      return true;
    });
    return groupSkills.length > 0 ? [{ ...group, skills: groupSkills }] : [];
  });
}

export function skillGroupKeys(group: ResolvedSkillGroup): string[] {
  return group.skills.map((skill) => skill.key);
}

export function setSkillGroupSelection(
  selectedSkillKeys: readonly string[],
  groupKeys: readonly string[],
  enabled: boolean,
): string[] {
  const groupKeySet = new Set(groupKeys);
  if (!enabled) {
    return selectedSkillKeys.filter((key) => !groupKeySet.has(key));
  }
  return [...new Set([...selectedSkillKeys, ...groupKeys])];
}

export function toggleSkillSelection(selectedSkillKeys: readonly string[], skillKey: string): string[] {
  return selectedSkillKeys.includes(skillKey)
    ? selectedSkillKeys.filter((key) => key !== skillKey)
    : [...selectedSkillKeys, skillKey];
}

function sameGroup(left: UserSkillGroup | undefined, right: UserSkillGroup): boolean {
  return left?.id === right.id && left.name === right.name
    && left.skillKeys.length === right.skillKeys.length
    && left.skillKeys.every((key, index) => key === right.skillKeys[index]);
}

/** Apply an edit to the latest collection without overwriting another group's changes. */
export function saveUserSkillGroup(
  groups: UserSkillGroup[], group: UserSkillGroup, original: UserSkillGroup | null,
): UserSkillGroup[] {
  const name = group.name.trim();
  if (!name) throw new SkillGroupError('nameRequired');
  const current = groups.find(item => item.id === group.id);
  if (original ? !sameGroup(current, original) : current) throw new SkillGroupError('conflict');
  if (groups.some(item => item.id !== group.id && item.name.toLowerCase() === name.toLowerCase())) {
    throw new SkillGroupError('nameDuplicate');
  }
  const next = normalizeUserSkillGroup({ ...group, name });
  return original ? groups.map(item => item.id === group.id ? next : item) : [...groups, next];
}

export function deleteUserSkillGroup(groups: UserSkillGroup[], original: UserSkillGroup): UserSkillGroup[] {
  if (!sameGroup(groups.find(group => group.id === original.id), original)) {
    throw new SkillGroupError('conflict');
  }
  return groups.filter(group => group.id !== original.id);
}

export function moveUserSkillGroup(groups: UserSkillGroup[], id: string, direction: -1 | 1): UserSkillGroup[] {
  const index = groups.findIndex(group => group.id === id);
  if (index === -1) throw new SkillGroupError('conflict');
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= groups.length) return groups;
  const next = [...groups];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}
