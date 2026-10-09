import { ConfigLoadingState, ConfigRetryState } from '@/infrastructure/config/components/common';
import {
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  MenuPopover,
  NumberInput,
  Select,
  Switch,
  Tooltip,
  type MenuEntry,
  type SelectOption,
} from '@openbitfun/ui';
import { FolderOpen, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import {
  ConfigPageRow,
  ConfigPageSection,
  ConfigPageSectionStack
} from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getModelDisplayName } from '@/infrastructure/config/services/modelConfigs';
import type { AIModelConfig, MemoriesConfig as MemoriesConfigShape } from '@/infrastructure/config/types';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('MemorySettings');

const DEFAULT_MEMORIES_CONFIG: MemoriesConfigShape = {
  generate_memories: true,
  generate_for_btw_sessions: false,
  use_memories: true,
  external_context_policy: 'clear_tool_results',
  max_raw_memories_for_consolidation: 64,
  max_unused_days: 30,
  max_rollout_age_days: 10,
  max_rollouts_per_startup: 5,
  max_rollouts_scan_limit: 2000,
  min_rollout_idle_hours: 6,
  phase1_max_concurrency: 1,
  phase1_retry_backoff_minutes: 60,
  phase1_lease_seconds: 60 * 60,
  phase2_lease_seconds: 60 * 60,
  phase2_success_cooldown_seconds: 6 * 60 * 60,
  phase2_retry_delay_seconds: 60 * 60,
  extract_model: null,
  consolidation_model: null,
};

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved == null ? '' : String(resolved);
}

function normalizeMemoriesConfig(config: Partial<MemoriesConfigShape> | null | undefined): MemoriesConfigShape {
  const normalized = {
    ...DEFAULT_MEMORIES_CONFIG,
    ...(config ?? {}),
  };
  return {
    generate_memories: normalized.generate_memories,
    generate_for_btw_sessions: normalized.generate_for_btw_sessions,
    use_memories: normalized.use_memories,
    external_context_policy: normalized.external_context_policy,
    max_raw_memories_for_consolidation: normalized.max_raw_memories_for_consolidation,
    max_unused_days: normalized.max_unused_days,
    max_rollout_age_days: Math.min(normalized.max_rollout_age_days, normalized.max_unused_days),
    max_rollouts_per_startup: normalized.max_rollouts_per_startup,
    max_rollouts_scan_limit: normalized.max_rollouts_scan_limit,
    min_rollout_idle_hours: normalized.min_rollout_idle_hours,
    phase1_max_concurrency: normalized.phase1_max_concurrency,
    phase1_retry_backoff_minutes: normalized.phase1_retry_backoff_minutes,
    phase1_lease_seconds: normalized.phase1_lease_seconds,
    phase2_lease_seconds: normalized.phase2_lease_seconds,
    phase2_success_cooldown_seconds: normalized.phase2_success_cooldown_seconds,
    phase2_retry_delay_seconds: normalized.phase2_retry_delay_seconds,
    extract_model: normalized.extract_model,
    consolidation_model: normalized.consolidation_model,
  };
}

function isValidMemoryWindowConfig(config: MemoriesConfigShape): boolean {
  return config.max_rollout_age_days <= config.max_unused_days;
}

const MemorySettingsSection: React.FC = () => {
  const { t } = useTranslation('settings/memory');
  const { error: notifyError, success: notifySuccess } = useNotification();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [config, setConfig] = useState<MemoriesConfigShape>(DEFAULT_MEMORIES_CONFIG);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [savingKey, setSavingKey] = useState<keyof MemoriesConfigShape | null>(null);
  const [actionBusy, setActionBusy] = useState<'reset-settings' | 'open-directory' | 'reset-memory' | null>(null);
  const [resetMemoryConfirmOpen, setResetMemoryConfirmOpen] = useState(false);
  const [resetSettingsConfirmOpen, setResetSettingsConfirmOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionMenuAnchorRef = useRef<HTMLButtonElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [loadedConfig, loadedModels] = await Promise.all([
        configManager.getConfig<Partial<MemoriesConfigShape>>('memories'),
        configManager.getConfig<AIModelConfig[]>('ai.models'),
      ]);
      setConfig(normalizeMemoriesConfig(loadedConfig));
      setModels(Array.isArray(loadedModels) ? loadedModels : []);
    } catch (error) {
      log.error('Failed to load memories config', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const enabledModels = useMemo(() => models.filter((model) => model.enabled && model.id), [models]);

  const buildModelOptions = useCallback((followLabel: string, selectedValue: string | null): SelectOption[] => {
    const options: SelectOption[] = [
      { value: '', label: followLabel },
      { value: 'primary', label: t('models.primary') },
      { value: 'fast', label: t('models.fast') },
      ...enabledModels.map((model) => ({
        value: model.id as string,
        label: getModelDisplayName(model),
      })),
    ];
    if (selectedValue
      && selectedValue !== 'primary'
      && selectedValue !== 'fast'
      && !options.some(option => option.value === selectedValue)) {
      options.push({ value: selectedValue, label: t('models.unavailable', { id: selectedValue }), disabled: true });
    }
    return options;
  }, [enabledModels, t]);

  const externalContextPolicyOptions = useMemo<SelectOption[]>(() => [
    { value: 'clear_tool_results', label: t('externalContextPolicy.clearToolResults') },
    { value: 'allow', label: t('externalContextPolicy.allow') },
    { value: 'skip_session', label: t('externalContextPolicy.skipSession') },
  ], [t]);

  const updateConfig = useCallback(async <K extends keyof MemoriesConfigShape>(
    key: K,
    value: MemoriesConfigShape[K],
  ) => {
    const previous = config;
    const next = {
      ...config,
      [key]: value,
    };
    if (!isValidMemoryWindowConfig(next)) {
      notifyError(t('messages.rolloutAgeExceedsRetention'));
      return;
    }
    setSavingKey(key);
    setConfig(next);
    try {
      const persisted = await configManager.updateConfig<Partial<MemoriesConfigShape>>(
        'memories',
        current => {
          const latest = {
            ...normalizeMemoriesConfig(current),
            [key]: value,
          };
          if (!isValidMemoryWindowConfig(latest)) {
            throw new Error(t('messages.rolloutAgeExceedsRetention'));
          }
          return latest;
        },
      );
      setConfig(normalizeMemoriesConfig(persisted));
      notifySuccess(t('messages.saved'));
    } catch (error) {
      log.error('Failed to save memories config', { key, error });
      setConfig(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [config, notifyError, notifySuccess, t]);

  const updateMemoryEnabled = useCallback(async (enabled: boolean) => {
    const previous = config;
    const next = {
      ...config,
      generate_memories: enabled,
      use_memories: enabled,
    };
    setSavingKey('generate_memories');
    setConfig(next);
    try {
      const persisted = await configManager.updateConfig<Partial<MemoriesConfigShape>>(
        'memories',
        current => ({
          ...normalizeMemoriesConfig(current),
          generate_memories: enabled,
          use_memories: enabled,
        }),
      );
      setConfig(normalizeMemoriesConfig(persisted));
      notifySuccess(t('messages.saved'));
    } catch (error) {
      log.error('Failed to save memory enabled state', error);
      setConfig(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [config, notifyError, notifySuccess, t]);

  const updateModelSelector = useCallback((
    key: 'extract_model' | 'consolidation_model',
    value: string | number | (string | number)[],
  ) => {
    const selector = normalizeSelectValue(value).trim();
    void updateConfig(key, selector ? selector : null);
  }, [updateConfig]);

  const handleResetSettings = useCallback(async () => {
    setResetSettingsConfirmOpen(false);
    setActionBusy('reset-settings');
    try {
      await configManager.resetConfig('memories');
      await loadData();
      notifySuccess(t('messages.settingsReset'));
    } catch (error) {
      log.error('Failed to reset memories settings', error);
      notifyError(error instanceof Error ? error.message : t('messages.settingsResetFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [loadData, notifyError, notifySuccess, t]);

  const handleOpenMemoryDirectory = useCallback(async () => {
    setActionBusy('open-directory');
    try {
      const paths = await agentAPI.getMemoryPaths();
      await workspaceAPI.revealInExplorer(paths.memoriesRootDir);
    } catch (error) {
      log.error('Failed to open memory directory', error);
      notifyError(error instanceof Error ? error.message : t('messages.openDirectoryFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [notifyError, t]);

  const handleResetMemory = useCallback(async () => {
    setResetMemoryConfirmOpen(false);
    setActionBusy('reset-memory');
    try {
      await agentAPI.resetMemory();
      notifySuccess(t('messages.memoryReset'));
    } catch (error) {
      log.error('Failed to reset memory', error);
      notifyError(error instanceof Error ? error.message : t('messages.memoryResetFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [notifyError, notifySuccess, t]);

  const actionMenuItems = useMemo<MenuEntry[]>(() => [
    {
      id: 'open-directory',
      label: t('actions.openDirectory'),
      icon: <FolderOpen size={16} />,
      disabled: actionBusy !== null,
      onSelect: () => { void handleOpenMemoryDirectory(); },
    },
    {
      id: 'reset-settings',
      label: t('actions.resetSettings'),
      icon: <RotateCcw size={16} />,
      disabled: actionBusy !== null,
      onSelect: () => setResetSettingsConfirmOpen(true),
    },
    {
      id: 'separator-danger',
      label: '',
      separator: true,
    },
    {
      id: 'clear-memory',
      label: t('actions.resetMemory'),
      icon: <Icon name="delete" size="sm" />,
      tone: 'danger',
      disabled: actionBusy !== null,
      onSelect: () => setResetMemoryConfirmOpen(true),
    },
  ], [actionBusy, handleOpenMemoryDirectory, t]);

  const sectionAnchor = useSettingsSectionAnchor('memory', !loading);

  if (loading || loadFailed) {
    return (
      <div id={sectionAnchor}
        className="openbitfun-memories-config"
        data-openbitfun-component="config"
        data-openbitfun-part="root"
      >
        <ConfigPageSectionStack>
          {loading ? (
            <ConfigLoadingState label={t('messages.loading')} />
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void loadData()}
            />
          )}
        </ConfigPageSectionStack>
      </div>
    );
  }

  const memoryEnabled = config.generate_memories && config.use_memories;
  const memoryWorkDisabled = !memoryEnabled;

  return (
    <div id={sectionAnchor}
      className="openbitfun-memories-config"
      data-openbitfun-component="config"
      data-openbitfun-part="root"
    >
      <ConfigPageSectionStack>
        <ConfigPageSection
          title={t('sections.basic.title')}
          description={t('sections.basic.description')}
        >
          <ConfigPageRow
            label={t('fields.memoryEnabled.label')}
            description={t('fields.memoryEnabled.description')}
            align="center"
          >
            <Switch
              checked={memoryEnabled}
              onChange={(event) => void updateMemoryEnabled(event.target.checked)}
              disabled={savingKey === 'generate_memories' || savingKey === 'use_memories'}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.generateForBtwSessions.label')}
            description={t('fields.generateForBtwSessions.description')}
            align="center"
          >
            <Switch
              checked={config.generate_for_btw_sessions}
              onChange={(event) => void updateConfig('generate_for_btw_sessions', event.target.checked)}
              disabled={savingKey === 'generate_for_btw_sessions' || memoryWorkDisabled}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.externalContextPolicy.label')}
            description={t('fields.externalContextPolicy.description')}
            align="center"
          >
            <Select
              value={config.external_context_policy}
              onValueChange={(value) => {
                void updateConfig(
                  'external_context_policy',
                  normalizeSelectValue(value) as MemoriesConfigShape['external_context_policy'],
                );
              }}
              options={externalContextPolicyOptions}
              size="sm"
              disabled={savingKey === 'external_context_policy' || memoryWorkDisabled}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.memoryActions.label')}
            description={t('fields.memoryActions.description')}
            align="center"
          >
            <>
              <Button
                ref={actionMenuAnchorRef}
                type="button"
                variant="outline"
                size="sm"
                trailingIcon={<Icon name="chevron-down" size="sm" />}
                onClick={() => setActionMenuOpen((open) => !open)}
                loading={actionBusy !== null}
                disabled={actionBusy !== null}
                aria-label={t('fields.memoryActions.label')}
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
              >
                {t('actions.manage')}
              </Button>
              <MenuPopover
                items={actionMenuItems}
                open={actionMenuOpen}
                onClose={() => setActionMenuOpen(false)}
                anchorRef={actionMenuAnchorRef}
                placement="bottom"
                aria-label={t('fields.memoryActions.label')}
              />
            </>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.models.title')}
          description={t('sections.models.description')}
        >
          <ConfigPageRow
            label={t('fields.extractModel.label')}
            description={t('fields.extractModel.description')}
            align="center"
          >
            <Select
              value={config.extract_model ?? ''}
              onValueChange={(value) => updateModelSelector('extract_model', value)}
              options={buildModelOptions(t('models.followPrimary'), config.extract_model ?? null)}
              size="sm"
              disabled={savingKey === 'extract_model' || memoryWorkDisabled}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('fields.consolidationModel.label')}
            description={t('fields.consolidationModel.description')}
            align="center"
          >
            <Select
              value={config.consolidation_model ?? ''}
              onValueChange={(value) => updateModelSelector('consolidation_model', value)}
              options={buildModelOptions(t('models.followExtraction'), config.consolidation_model ?? null)}
              size="sm"
              disabled={savingKey === 'consolidation_model' || memoryWorkDisabled}
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.advanced.title')}
          description={t('sections.advanced.description')}
          descriptionLayout={advancedOpen ? 'stacked' : 'inline'}
          extra={(
            <Tooltip
              content={t(advancedOpen ? 'actions.collapseAdvanced' : 'actions.expandAdvanced')}
              placement="bottom"
            >
              <IconButton
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-label={t(advancedOpen ? 'actions.collapseAdvanced' : 'actions.expandAdvanced')}
                aria-expanded={advancedOpen}
                icon={<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size="lg" />}
              />
            </Tooltip>
          )}
        >
          {advancedOpen && (
            <>
              <ConfigPageRow
                label={t('fields.minRolloutIdleHours.label')}
                description={t('fields.minRolloutIdleHours.description')}
                align="center"
              >
                <NumberInput
                  value={config.min_rollout_idle_hours}
                  onValueChange={(value) => void updateConfig('min_rollout_idle_hours', value)}
                  min={1}
                  max={48}
                  step={1}
                  unit={t('units.hours')}
                  size="sm"
                  disabled={savingKey === 'min_rollout_idle_hours' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutAgeDays.label')}
                description={t('fields.maxRolloutAgeDays.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollout_age_days}
                  onValueChange={(value) => void updateConfig('max_rollout_age_days', value)}
                  min={0}
                  max={config.max_unused_days}
                  step={1}
                  unit={t('units.days')}
                  size="sm"
                  disabled={savingKey === 'max_rollout_age_days' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutsPerStartup.label')}
                description={t('fields.maxRolloutsPerStartup.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollouts_per_startup}
                  onValueChange={(value) => void updateConfig('max_rollouts_per_startup', value)}
                  min={1}
                  max={128}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'max_rollouts_per_startup' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutsScanLimit.label')}
                description={t('fields.maxRolloutsScanLimit.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollouts_scan_limit}
                  onValueChange={(value) => void updateConfig('max_rollouts_scan_limit', value)}
                  min={1}
                  max={50000}
                  step={100}
                  size="sm"
                  disabled={savingKey === 'max_rollouts_scan_limit' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.phase1MaxConcurrency.label')}
                description={t('fields.phase1MaxConcurrency.description')}
                align="center"
              >
                <NumberInput
                  value={config.phase1_max_concurrency}
                  onValueChange={(value) => void updateConfig('phase1_max_concurrency', value)}
                  min={1}
                  max={16}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'phase1_max_concurrency' || memoryWorkDisabled}
                />
              </ConfigPageRow>
              <ConfigPageRow
                label={t('fields.maxRawMemories.label')}
                description={t('fields.maxRawMemories.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_raw_memories_for_consolidation}
                  onValueChange={(value) => void updateConfig('max_raw_memories_for_consolidation', value)}
                  min={1}
                  max={4096}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'max_raw_memories_for_consolidation' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxUnusedDays.label')}
                description={t('fields.maxUnusedDays.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_unused_days}
                  onValueChange={(value) => void updateConfig('max_unused_days', value)}
                  min={config.max_rollout_age_days}
                  max={365}
                  step={1}
                  unit={t('units.days')}
                  size="sm"
                  disabled={savingKey === 'max_unused_days' || memoryWorkDisabled}
                />
              </ConfigPageRow>
            </>
          )}
        </ConfigPageSection>
      </ConfigPageSectionStack>
      <ConfirmDialog
        open={resetSettingsConfirmOpen}
        onOpenChange={() => setResetSettingsConfirmOpen(false)}
        onConfirm={() => void handleResetSettings()}
        title={t('actions.resetSettingsConfirmTitle')}
        message={t('actions.resetSettingsConfirm')}
        type="warning"
        confirmText={t('actions.resetSettingsConfirmAction')}
      />
      <ConfirmDialog
        open={resetMemoryConfirmOpen}
        onOpenChange={() => setResetMemoryConfirmOpen(false)}
        onConfirm={() => void handleResetMemory()}
        title={t('actions.resetMemory')}
        message={t('actions.resetMemoryConfirm')}
        type="warning"
        confirmDanger
        confirmText={t('actions.resetMemoryConfirmAction')}
      />
    </div>
  );
};

export default MemorySettingsSection;
