import {
  OverflowText,
  Checkbox,
  DialogFooter,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  StatusPill,
  Toolbar,
  Button,
  Icon,
  IconButton,
  Input,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useMemo, useState } from 'react';

import { useI18n, type UseI18nReturn } from '@/infrastructure/i18n/hooks/useI18n';

import { confirmDanger } from '@/infrastructure/confirm-dialog';
import type { UserToolGroup } from '@/infrastructure/config/types';
import { useNotification } from '@/shared/notification-system';
import {
  type GroupableTool,
  type ResolvedToolGroup,
  groupToolNames,
  resolveToolGroupSummary,
  resolveToolGroups,
  setToolGroupSelection,
  unavailableUserToolNames,
} from './toolGroups';
import {
  AgentCapabilityTooltip,
  type AgentCapabilityTooltipField,
} from './AgentCapabilityTooltip';
import { capabilityTooltipAriaLabel } from './agentCapabilityTooltipUtils';
import { AgentCapabilityOption } from './AgentCapabilityOption';
import './ToolGroupPicker.scss';

interface ToolGroupPickerProps {
  grouped?: boolean;
  tools: GroupableTool[];
  managementTools?: GroupableTool[];
  selectedToolNames: readonly string[];
  userGroups: UserToolGroup[];
  onSelectionChange: (toolNames: string[]) => void;
  onSaveUserGroups: (groups: UserToolGroup[]) => Promise<void>;
  showSelectionCount?: boolean;
  disabled?: boolean;
  testId?: string;
}

interface ToolGroupSummaryProps {
  grouped?: boolean;
  tools: GroupableTool[];
  selectedToolNames: readonly string[];
  userGroups: UserToolGroup[];
}

function createGroupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tool_group_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function hasDuplicateName(groups: UserToolGroup[], name: string, exceptId?: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return groups.some((group) => (
    group.id !== exceptId && group.name.trim().toLocaleLowerCase() === normalized
  ));
}

function isGroupEnabled(group: ResolvedToolGroup, selectedToolNames: readonly string[]): boolean {
  const selected = new Set(selectedToolNames);
  return group.tools.length > 0 && group.tools.every((tool) => selected.has(tool.name));
}

function selectedGroupToolCount(group: ResolvedToolGroup, selectedToolNames: readonly string[]): number {
  const selected = new Set(selectedToolNames);
  return group.tools.filter((tool) => selected.has(tool.name)).length;
}

function flattenToolGroups(groups: ResolvedToolGroup[]): ResolvedToolGroup[] {
  const tools = [...new Map(groups.flatMap(group => group.tools).map(tool => [tool.name, tool])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  return tools.length > 0 ? [{ id: 'all', kind: 'other', label: '', tools }] : [];
}

function groupSectionLabel(group: ResolvedToolGroup, t: UseI18nReturn['t']): string {
  switch (group.kind) {
    case 'user':
      return t('agentsOverview.toolGroups.myGroups');
    case 'extension':
      return t('agentsOverview.toolGroups.extensions');
    case 'other':
      return t('agentsOverview.toolGroups.otherTools');
    default:
      return t('agentsOverview.toolGroups.builtin');
  }
}

function toolTooltipFields(
  tool: GroupableTool,
  t: UseI18nReturn['t'],
): AgentCapabilityTooltipField[] {
  const mcpServerName = tool.dynamic_info?.mcp?.serverName?.trim();
  const providerId = tool.dynamic_info?.providerId?.trim();
  const provider = mcpServerName || providerId;
  const access = [
    tool.is_readonly
      ? t('agentsOverview.toolGroups.readonly')
      : t('agentsOverview.capabilityTooltip.standardPermission'),
    tool.needs_permissions ? t('agentsOverview.toolGroups.permissionRequired') : null,
  ].filter(Boolean).join(' · ');

  return [
    {
      label: t('agentsOverview.capabilityTooltip.executionPermission'),
      value: access,
    },
    ...(provider ? [{
      label: mcpServerName
        ? t('agentsOverview.capabilityTooltip.mcpServer')
        : t('agentsOverview.capabilityTooltip.provider'),
      value: provider,
      monospace: true,
    }] : []),
  ];
}

interface GroupManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tools: GroupableTool[];
  groups: UserToolGroup[];
  onSaveGroups: (groups: UserToolGroup[]) => Promise<void>;
}

const GroupManagerModal: React.FC<GroupManagerModalProps> = ({
  isOpen,
  onClose,
  tools,
  groups,
  onSaveGroups,
}) => {
  const { t } = useI18n('scenes/agents');
  const notification = useNotification();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  const [toolNames, setToolNames] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const selectableTools = useMemo(
    () => [...tools].sort((left, right) => left.name.localeCompare(right.name)),
    [tools],
  );
  const editingGroup = groups.find((group) => group.id === editingId) ?? null;
  const isEditing = editingId !== null;

  const closeEditor = () => {
    setEditingId(null);
    setName('');
    setNameError(false);
    setToolNames(new Set());
  };

  const startCreate = () => {
    setEditingId('__new__');
    setName('');
    setNameError(false);
    setToolNames(new Set());
  };

  const startEdit = (group: UserToolGroup) => {
    setEditingId(group.id);
    setName(group.name);
    setNameError(false);
    setToolNames(new Set(group.toolNames));
  };

  const setToolSelected = (toolName: string, checked: boolean) => {
    setToolNames((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(toolName);
      } else {
        next.delete(toolName);
      }
      return next;
    });
  };

  const saveEditor = async () => {
    const trimmedName = name.trim();
    const selectedNames = Array.from(toolNames);
    const existingId = editingGroup?.id;
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    if (hasDuplicateName(groups, trimmedName, existingId)) {
      notification.error(t('agentsOverview.toolGroups.validation.nameDuplicate'));
      return;
    }
    if (selectedNames.length === 0) {
      notification.error(t('agentsOverview.toolGroups.validation.toolsRequired'));
      return;
    }

    const nextGroup: UserToolGroup = {
      id: existingId ?? createGroupId(),
      name: trimmedName,
      toolNames: selectedNames,
    };
    const nextGroups = existingId
      ? groups.map((group) => group.id === existingId ? nextGroup : group)
      : [...groups, nextGroup];

    setSaving(true);
    try {
      await onSaveGroups(nextGroups);
      closeEditor();
    } catch {
      notification.error(t('agentsOverview.toolGroups.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (group: UserToolGroup) => {
    const confirmed = await confirmDanger(
      t('agentsOverview.toolGroups.deleteTitle'),
      t('agentsOverview.toolGroups.deleteMessage', { name: group.name }),
      { confirmText: t('agentsOverview.toolGroups.deleteConfirm') },
    );
    if (!confirmed) {
      return;
    }
    setSaving(true);
    try {
      await onSaveGroups(groups.filter((candidate) => candidate.id !== group.id));
      if (editingId === group.id) {
        closeEditor();
      }
    } catch {
      notification.error(t('agentsOverview.toolGroups.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const moveGroup = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= groups.length) {
      return;
    }
    const nextGroups = [...groups];
    [nextGroups[index], nextGroups[nextIndex]] = [nextGroups[nextIndex], nextGroups[index]];
    setSaving(true);
    try {
      await onSaveGroups(nextGroups);
    } catch {
      notification.error(t('agentsOverview.toolGroups.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeEditor();
          onClose();
        }
      }}
      size="lg"
      data-testid="tool-group-manager"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('agentsOverview.toolGroups.manageTitle')}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
        <div className="tool-group-manager" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="manager">
          {isEditing ? (
            <div className="tool-group-manager__editor" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="managerEditor">
              <Field
                label={t('agentsOverview.toolGroups.groupName')}
                error={nameError ? t('agentsOverview.toolGroups.validation.nameRequired') : undefined}
              >
                <Input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError) setNameError(false);
                  }}
                  placeholder={t('agentsOverview.toolGroups.groupNamePlaceholder')}
                  invalid={nameError}
                  disabled={saving}
                  size="sm"
                />
              </Field>
              <FormSection headingAs="h4" title={t('agentsOverview.toolGroups.groupTools')}>
                <div className="tool-group-manager__token-grid" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="tokenGrid">
                  {selectableTools.map((tool) => {
                    const selected = toolNames.has(tool.name);
                    const tooltipFields = toolTooltipFields(tool, t);
                    return (
                      <AgentCapabilityTooltip
                        key={tool.name}
                        title={tool.name}
                        description={tool.description}
                        fields={tooltipFields}
                        titleMonospace
                        placement="top"
                      >
                        <AgentCapabilityOption
                          className="tool-group-manager__token"
                          data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="token"
                          data-openbitfun-state={selected ? 'selected' : undefined}
                          checked={selected}
                          label={tool.name}
                          onCheckedChange={(checked) => setToolSelected(tool.name, checked)}
                          disabled={saving}
                          inputAriaLabel={capabilityTooltipAriaLabel(tool.name, tool.description, tooltipFields)}
                        />
                      </AgentCapabilityTooltip>
                    );
                  })}
                </div>
              </FormSection>
            </div>
          ) : (
            <FormSection
              description={t('agentsOverview.toolGroups.manageSubtitle')}
              actions={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startCreate}
                  disabled={saving}
                  leadingIcon={<Icon name="plus" />}
                >
                  {t('agentsOverview.toolGroups.createGroup')}
                </Button>
              )}
            >
              {groups.length === 0 ? (
                <p className="tool-group-manager__empty">{t('agentsOverview.toolGroups.noUserGroups')}</p>
              ) : (
                <FieldGroup className="tool-group-manager__list" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="managerList">
                  {groups.map((group, index) => {
                    const unavailable = unavailableUserToolNames(group, tools);
                    return (
                      <FieldRow key={group.id} data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="managerGroup">
                        <div className="tool-group-manager__group-row">
                          <div className="tool-group-manager__group-copy">
                            <OverflowText className="tool-group-manager__group-name">{group.name}</OverflowText>
                            <span className="tool-group-manager__group-meta">
                              {t('agentsOverview.toolGroups.groupCount', { count: group.toolNames.length })}
                              {unavailable.length > 0
                                ? ` · ${t('agentsOverview.toolGroups.unavailableCount', { count: unavailable.length })}`
                                : ''}
                            </span>
                          </div>
                          <div className="tool-group-manager__group-actions" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="groupActions">
                            <Tooltip content={t('agentsOverview.toolGroups.moveUp')}>
                              <IconButton
                                size="sm"
                                aria-label={t('agentsOverview.toolGroups.moveUp')}
                                onClick={() => void moveGroup(index, -1)}
                                disabled={saving || index === 0}
                                icon={<Icon name="arrow-up" />}
                              />
                            </Tooltip>
                            <Tooltip content={t('agentsOverview.toolGroups.moveDown')}>
                              <IconButton
                                size="sm"
                                aria-label={t('agentsOverview.toolGroups.moveDown')}
                                onClick={() => void moveGroup(index, 1)}
                                disabled={saving || index === groups.length - 1}
                                icon={<Icon name="arrow-down" />}
                              />
                            </Tooltip>
                            <Tooltip content={t('agentsOverview.toolGroups.editGroup')}>
                              <IconButton
                                size="sm"
                                aria-label={t('agentsOverview.toolGroups.editGroup')}
                                onClick={() => startEdit(group)}
                                disabled={saving}
                                icon={<Icon name="edit" />}
                              />
                            </Tooltip>
                            <Tooltip content={t('agentsOverview.toolGroups.deleteGroup')}>
                              <IconButton
                                size="sm"
                                tone="danger"
                                aria-label={t('agentsOverview.toolGroups.deleteGroup')}
                                onClick={() => void deleteGroup(group)}
                                disabled={saving}
                                icon={<Icon name="delete" />}
                              />
                            </Tooltip>
                          </div>
                        </div>
                      </FieldRow>
                    );
                  })}
                </FieldGroup>
              )}
            </FormSection>
          )}
        </div>
      </DialogBody>
      {isEditing ? (
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeEditor} disabled={saving}>
            {t('agentsOverview.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void saveEditor()} loading={saving}>
            {editingGroup ? t('agentsOverview.toolGroups.saveGroup') : t('agentsOverview.toolGroups.createGroup')}
          </Button>
        </DialogFooter>
      ) : null}
    </Dialog>
  );
};

export const ToolGroupPicker: React.FC<ToolGroupPickerProps> = ({
  grouped = true,
  tools,
  managementTools,
  selectedToolNames,
  userGroups,
  onSelectionChange,
  onSaveUserGroups,
  showSelectionCount = true,
  disabled = false,
  testId,
}) => {
  const { t, formatNumber } = useI18n('scenes/agents');
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const groups = useMemo(() => resolveToolGroups(tools, userGroups, t), [t, tools, userGroups]);
  const selectedCount = new Set(selectedToolNames).size;
  const sections = useMemo<Array<[string, ResolvedToolGroup[]]>>(() => {
    if (!grouped) return [['', flattenToolGroups(groups)]];
    const sectionsByLabel = new Map<string, ResolvedToolGroup[]>();
    for (const group of groups) {
      const label = groupSectionLabel(group, t);
      const entries = sectionsByLabel.get(label) ?? [];
      entries.push(group);
      sectionsByLabel.set(label, entries);
    }
    return [...sectionsByLabel.entries()];
  }, [grouped, groups, t]);

  return (
    <div data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="root" className="tool-group-picker" data-testid={testId}>
      <Toolbar
        data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="head"
        bordered={false}
        leading={(
          <span className="tool-group-picker__selected-count">
            {showSelectionCount && (
              <>{t('agentsOverview.toolGroups.selectedCount', { count: selectedCount })}{' · '}</>
            )}
            {t('agentsOverview.selectionSaveHint')}
          </span>
        )}
        trailing={grouped && (
          <Button
            variant="text"
            size="sm"
            onClick={() => setIsManagerOpen(true)}
            disabled={disabled}
            leadingIcon={<Icon name="settings" />}
          >
            {t('agentsOverview.toolGroups.manageGroups')}
          </Button>
        )}
      />
      <div className="tool-group-picker__sections" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="sections">
        {sections.map(([sectionLabel, sectionGroups]) => (
          <FormSection
            key={sectionLabel}
            headingAs="h4"
            title={grouped ? sectionLabel : undefined}
            data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="section"
          >
            {sectionGroups.map((group) => {
              const selectedInGroup = selectedGroupToolCount(group, selectedToolNames);
              const allSelected = isGroupEnabled(group, selectedToolNames);
              return (
                <FieldGroup key={group.id} appearance={grouped ? 'subtle' : 'plain'} dividers={grouped} data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="group">
                  {grouped && <FieldRow data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="groupHeader">
                    <div className="tool-group-picker__group-head">
                      <div className="tool-group-picker__group-title-wrap">
                        <OverflowText className="tool-group-picker__group-name">{group.label}</OverflowText>
                        <span className="tool-group-picker__group-count">
                          {formatNumber(selectedInGroup)}/{formatNumber(group.tools.length)}
                        </span>
                      </div>
                      <div className="tool-group-picker__group-actions" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="groupActions">
                        {selectedInGroup > 0 && !allSelected ? (
                          <Button
                            variant="text"
                            size="xs"
                            onClick={() => onSelectionChange(
                              setToolGroupSelection(selectedToolNames, groupToolNames(group), false),
                            )}
                            disabled={disabled}
                          >
                            {t('agentsOverview.clearGroup')}
                          </Button>
                        ) : null}
                        <Checkbox
                          size="sm"
                          label={t('agentsOverview.selectAll')}
                          checked={allSelected}
                          indeterminate={selectedInGroup > 0 && !allSelected}
                          onCheckedChange={(checked) => onSelectionChange(
                            setToolGroupSelection(selectedToolNames, groupToolNames(group), checked),
                          )}
                          disabled={disabled || group.tools.length === 0}
                          aria-label={allSelected
                            ? t('agentsOverview.toolGroups.clearGroupTools', { name: group.label })
                            : t('agentsOverview.toolGroups.enableGroupTools', { name: group.label })}
                        />
                      </div>
                    </div>
                  </FieldRow>}
                  <FieldRow align="start" padding={grouped ? 'md' : 'none'}>
                    <div className="tool-group-picker__token-grid" data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="tokenGrid">
                      {group.tools.map((tool) => {
                        const selected = selectedToolNames.includes(tool.name);
                        const tooltipFields = toolTooltipFields(tool, t);
                        return (
                          <AgentCapabilityTooltip
                            key={tool.name}
                            title={tool.name}
                            description={tool.description}
                            fields={tooltipFields}
                            titleMonospace
                            placement="top"
                          >
                            <AgentCapabilityOption
                              className="tool-group-picker__token"
                              data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="token"
                              data-openbitfun-state={selected ? 'selected' : undefined}
                              checked={selected}
                              label={tool.name}
                              onCheckedChange={(checked) => onSelectionChange(
                                setToolGroupSelection(selectedToolNames, [tool.name], checked),
                              )}
                              disabled={disabled}
                              inputAriaLabel={capabilityTooltipAriaLabel(tool.name, tool.description, tooltipFields)}
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
      <GroupManagerModal
        isOpen={isManagerOpen}
        onClose={() => setIsManagerOpen(false)}
        tools={managementTools ?? tools}
        groups={userGroups}
        onSaveGroups={onSaveUserGroups}
      />
    </div>
  );
};

export const ToolGroupSummary: React.FC<ToolGroupSummaryProps> = ({
  grouped = true,
  tools,
  selectedToolNames,
  userGroups,
}) => {
  const { t } = useI18n('scenes/agents');
  const groups = useMemo(
    () => {
      const summary = resolveToolGroupSummary(tools, userGroups, selectedToolNames, t);
      return grouped ? summary : flattenToolGroups(summary);
    },
    [grouped, selectedToolNames, t, tools, userGroups],
  );

  if (groups.length === 0) {
    return <span data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="empty" className="tool-group-summary__empty">{t('agentsOverview.toolGroups.noEnabledTools')}</span>;
  }

  return (
    <div data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="summary" className="tool-group-summary">
      {groups.map((group) => (
        <FormSection key={group.id} headingAs="h4" title={grouped ? group.label : undefined} data-openbitfun-product-component="tool-group-picker" data-openbitfun-product-part="summaryGroup">
          <div className="tool-group-summary__tools">
            {group.tools.map((tool) => {
              const tooltipFields = toolTooltipFields(tool, t);
              return (
                <AgentCapabilityTooltip
                  key={tool.name}
                  title={tool.name}
                  description={tool.description}
                  fields={tooltipFields}
                  titleMonospace
                >
                  <StatusPill
                    tone="neutral"
                    className="tool-group-summary__item"
                    leading={<Icon name="check-line" size="xs" tone="success" />}
                  >
                    {tool.name.replace(/_/g, ' ')}
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
