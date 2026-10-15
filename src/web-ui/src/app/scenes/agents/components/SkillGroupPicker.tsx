import { Button, Checkbox, FieldGroup, FieldRow, FormSection, Icon, OverflowText, StatusPill, Toolbar } from '@openbitfun/ui';
import React, { useMemo } from 'react';
import { useI18n, type UseI18nReturn } from '@/infrastructure/i18n/hooks/useI18n';
import type { UserSkillGroup } from '@/infrastructure/config/types';
import {
  type GroupableSkill, type ResolvedSkillGroup, builtinSkillGroupLabelKey,
  resolveSkillGroupSummary, resolveSkillSelectionGroups, setSkillGroupSelection,
  skillGroupKeys,
} from '@/features/skill-groups/skillGroups';
import { AgentCapabilityTooltip, type AgentCapabilityTooltipField } from './AgentCapabilityTooltip';
import { AgentCapabilityOption } from './AgentCapabilityOption';
import { capabilityTooltipAriaLabel } from './agentCapabilityTooltipUtils';
import './SkillGroupPicker.scss';

interface SkillGroupPickerProps {
  skills: GroupableSkill[];
  selectedSkillKeys: readonly string[];
  userGroups: UserSkillGroup[];
  onSelectionChange: (skillKeys: string[]) => void;
  disabled?: boolean;
  testId?: string;
}

interface SkillGroupSummaryProps {
  skills: GroupableSkill[];
  selectedSkillKeys: readonly string[];
  userGroups: UserSkillGroup[];
}

function isGroupEnabled(group: ResolvedSkillGroup, selectedSkillKeys: readonly string[]): boolean {
  const selected = new Set(selectedSkillKeys);
  return group.skills.length > 0 && group.skills.every((skill) => selected.has(skill.key));
}

function selectedGroupSkillCount(group: ResolvedSkillGroup, selectedSkillKeys: readonly string[]): number {
  const selected = new Set(selectedSkillKeys);
  return group.skills.filter((skill) => selected.has(skill.key)).length;
}

function builtinGroupLabel(groupKey: string, t: UseI18nReturn['t']): string {
  const labelKey = builtinSkillGroupLabelKey(groupKey);
  return labelKey ? t(`agentsOverview.skillGroups.${labelKey}`) : groupKey;
}

function groupSectionLabel(group: ResolvedSkillGroup, t: UseI18nReturn['t']): string {
  switch (group.kind) {
    case 'user':
      return t('agentsOverview.skillGroupPicker.myGroups');
    case 'builtin':
      return t('agentsOverview.skillGroupPicker.builtin');
    default:
      return t('agentsOverview.skillGroupPicker.otherSkills');
  }
}

function duplicateSkillNames(skills: GroupableSkill[]): Set<string> {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  return new Set([...counts].flatMap(([name, count]) => count > 1 ? [name] : []));
}

function skillDisplayName(skill: GroupableSkill, duplicateNames: Set<string>): string {
  if (!duplicateNames.has(skill.name)) {
    return skill.name;
  }
  const source = [skill.sourceLabel ?? skill.sourceSlot, skill.level].filter(Boolean).join('/');
  return source ? `${skill.name} [${source}]` : `${skill.name} [${skill.key}]`;
}

function skillTooltipFields(
  skill: GroupableSkill,
  t: UseI18nReturn['t'],
  editing = false,
): AgentCapabilityTooltipField[] {
  const source = [skill.sourceLabel ?? skill.sourceSlot, skill.level].filter(Boolean).join('/');
  return [
    {
      label: t('agentsOverview.capabilityTooltip.skillKey'),
      value: skill.key,
      monospace: true,
    },
    ...(source ? [{
      label: t('agentsOverview.capabilityTooltip.sourceLevel'),
      value: source,
      monospace: true,
    }] : []),
    ...(skill.runtimeStatus ? [{
      label: editing ? t('agentsOverview.capabilityTooltip.savedStatus') : t('agentsOverview.capabilityTooltip.status'),
      value: skill.runtimeStatus,
    }] : skill.isShadowed ? [{
      label: t('agentsOverview.capabilityTooltip.status'),
      value: t('agentsOverview.skillShadowed'),
    }] : []),
  ];
}

export const SkillGroupPicker: React.FC<SkillGroupPickerProps> = ({
  skills,
  selectedSkillKeys,
  userGroups,
  onSelectionChange,
  disabled = false,
  testId,
}) => {
  const { t, formatNumber } = useI18n('scenes/agents');
  const duplicateNames = useMemo(() => duplicateSkillNames(skills), [skills]);
  const groups = useMemo(() => resolveSkillSelectionGroups(skills, userGroups, {
    builtin: (groupKey) => builtinGroupLabel(groupKey, t),
    other: t('agentsOverview.skillGroupPicker.otherSkills'),
  }), [skills, t, userGroups]);
  const sections = useMemo(() => {
    const grouped = new Map<string, ResolvedSkillGroup[]>();
    for (const group of groups) {
      const label = groupSectionLabel(group, t);
      const entries = grouped.get(label) ?? [];
      entries.push(group);
      grouped.set(label, entries);
    }
    return [...grouped.entries()];
  }, [groups, t]);

  return (
    <div data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="root" className="skill-group-picker" data-testid={testId}>
      <Toolbar
        bordered={false}
        data-openbitfun-product-component="skill-group-picker"
        data-openbitfun-product-part="head"
        leading={<span className="skill-group-picker__selected-count">
          {t('agentsOverview.selectionSaveHint')}
        </span>}
      />
      <div className="skill-group-picker__sections" data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="sections">
        {sections.map(([sectionLabel, sectionGroups]) => (
          <FormSection key={sectionLabel} headingAs="h4" title={sectionLabel}
            data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="section">
            {sectionGroups.map((group) => {
              const selectedInGroup = selectedGroupSkillCount(group, selectedSkillKeys);
              const allSelected = isGroupEnabled(group, selectedSkillKeys);
              return (
                <FieldGroup data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="group" key={group.id}>
                  <FieldRow data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="groupHeader">
                    <div className="skill-group-picker__group-head">
                      <div className="skill-group-picker__group-title-wrap">
                        <OverflowText className="skill-group-picker__group-name">{group.label}</OverflowText>
                        <span className="skill-group-picker__group-count">
                          {formatNumber(selectedInGroup)}/{formatNumber(group.skills.length)}
                        </span>
                        {group.unavailableSkillKeys.length > 0 && (
                          <span className="skill-group-picker__unavailable">
                            {t('agentsOverview.skillGroupPicker.unavailableCount', { count: group.unavailableSkillKeys.length })}
                          </span>
                        )}
                      </div>
                      <div className="skill-group-picker__group-actions" data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="groupActions">
                        {selectedInGroup > 0 && !allSelected ? (
                          <Button
                            variant="text"
                            size="xs"
                            onClick={() => onSelectionChange(
                              setSkillGroupSelection(selectedSkillKeys, skillGroupKeys(group), false),
                            )}
                            disabled={disabled}
                          >
                            {t('agentsOverview.clearGroup')}
                          </Button>
                        ) : null}
                        <Checkbox
                          size="sm"
                          label={t('agentsOverview.selectAll')}
                          indeterminate={selectedInGroup > 0 && !allSelected}
                          checked={allSelected}
                          onCheckedChange={(checked) => onSelectionChange(
                            setSkillGroupSelection(
                              selectedSkillKeys,
                              skillGroupKeys(group),
                              checked,
                            ),
                          )}
                          disabled={disabled || group.skills.length === 0}
                          aria-label={allSelected
                            ? t('agentsOverview.skillGroupPicker.clearGroupSkills', { name: group.label })
                            : t('agentsOverview.skillGroupPicker.enableGroupSkills', { name: group.label })}
                        />
                      </div>
                    </div>
                  </FieldRow>
                  <FieldRow align="start">
                    <div className="skill-group-picker__token-grid" data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="tokenGrid">
                      {group.skills.map((skill) => {
                        const selected = selectedSkillKeys.includes(skill.key);
                        const tooltipFields = skillTooltipFields(skill, t, true);
                        return (
                          <AgentCapabilityTooltip
                            key={skill.key}
                            title={skillDisplayName(skill, duplicateNames)}
                            description={skill.description}
                            fields={tooltipFields}
                            placement="top"
                          >
                            <AgentCapabilityOption
                              className="skill-group-picker__token"
                              checked={selected}
                              label={skillDisplayName(skill, duplicateNames)}
                              data-openbitfun-product-component="skill-group-picker"
                              data-openbitfun-product-part="token"
                              data-openbitfun-state={selected ? 'selected' : undefined}
                              onCheckedChange={(checked) => onSelectionChange(
                                setSkillGroupSelection(selectedSkillKeys, [skill.key], checked),
                              )}
                              disabled={disabled}
                              inputAriaLabel={capabilityTooltipAriaLabel(
                                skillDisplayName(skill, duplicateNames),
                                skill.description,
                                tooltipFields,
                              )}
                            />
                          </AgentCapabilityTooltip>
                        );
                      })}
                    </div>
                  </FieldRow>
                </FieldGroup>
              );
            })}
          </FormSection>
        ))}
      </div>
    </div>
  );
};

export const SkillGroupSummary: React.FC<SkillGroupSummaryProps> = ({
  skills,
  selectedSkillKeys,
  userGroups,
}) => {
  const { t } = useI18n('scenes/agents');
  const duplicateNames = useMemo(() => duplicateSkillNames(skills), [skills]);
  const groups = useMemo(() => resolveSkillGroupSummary(skills, userGroups, selectedSkillKeys, {
    builtin: (groupKey) => builtinGroupLabel(groupKey, t),
    other: t('agentsOverview.skillGroupPicker.otherSkills'),
  }), [selectedSkillKeys, skills, t, userGroups]);

  if (groups.length === 0) {
    return <span data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="empty" className="skill-group-summary__empty">{t('agentsOverview.noSkills')}</span>;
  }

  return (
    <div data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="summary" className="skill-group-summary">
      {groups.map((group) => (
        <FormSection key={group.id} headingAs="h4" title={group.label}
          data-openbitfun-product-component="skill-group-picker" data-openbitfun-product-part="summaryGroup">
          <div className="skill-group-summary__skills">
            {group.skills.map((skill) => {
              const tooltipFields = skillTooltipFields(skill, t);
              return (
                <AgentCapabilityTooltip
                  key={skill.key}
                  title={skillDisplayName(skill, duplicateNames)}
                  description={skill.description}
                  fields={tooltipFields}
                >
                  <StatusPill
                    tone="neutral"
                    className="skill-group-summary__item"
                    leading={<Icon name="check-line" size="xs" />}
                  >
                    {skillDisplayName(skill, duplicateNames)}
                  </StatusPill>
                </AgentCapabilityTooltip>
              );
            })}
          </div>
        </FormSection>
      ))}
    </div>
  );
};
