import ReviewCapacitySection from '@/app/scenes/settings/pages/ai/ReviewCapacitySection';
import ToolJsonRepairSection from '@/app/scenes/settings/pages/ai/ToolJsonRepairSection';
import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import { useSceneStore } from '@/app/stores/sceneStore';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState,
  formatStandaloneUiText
} from '@/infrastructure/config/components/common';
import { useModelSelectPresentation } from '@/infrastructure/config/components/ModelSelectPresentation';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  AIModelConfig,
  SubagentModelSelection
} from '@/infrastructure/config/types';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  Combobox,
  Icon,
  IconButton,
  NumberInput,
  Select,
  Switch,
  Tooltip,
  type ComboboxOption,
  type SelectOption
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
type DescribedSelectOption = SelectOption & { description?: string };

const log = createLogger('ExecutionSettingsPage');

type SubagentBatchExecutionPolicy = 'safe_only' | 'force_parallel' | 'serial';

const DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY: SubagentBatchExecutionPolicy = 'force_parallel';

const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 5;

const DEFAULT_SWARM_MAX_CONCURRENCY = 16;

const SUBAGENT_MAX_CONCURRENCY_LIMIT = 32;

const SWARM_MAX_CONCURRENCY_LIMIT = 64;

function normalizeSubagentBatchExecutionPolicy(value: unknown): SubagentBatchExecutionPolicy {
  return value === 'force_parallel' || value === 'serial' || value === 'safe_only'
    ? value
    : DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY;
}

const ExecutionSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/runtime');

  const { t: tTools } = useTranslation('settings/agentic-tools');

  const { t: tModels } = useTranslation('settings/models');

  const { buildModelOption } = useModelSelectPresentation();

  const [subagentDefaultModel, setSubagentDefaultModel] = useState<SubagentModelSelection>({ kind: 'fixed', model_id: 'fast' });

  const [configuredModels, setConfiguredModels] = useState<AIModelConfig[]>([]);

  const [isLoading, setIsLoading] = useState(true);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(false);

  const [enableDeferredToolLoading, setEnableDeferredToolLoading] = useState(true);

  const [subagentMaxConcurrency, setSubagentMaxConcurrency] = useState(DEFAULT_SUBAGENT_MAX_CONCURRENCY);

  const [swarmMaxConcurrency, setSwarmMaxConcurrency] = useState(DEFAULT_SWARM_MAX_CONCURRENCY);

  const [executionTimeout, setExecutionTimeout] = useState('');

  const [userQuestionTimeout, setUserQuestionTimeout] = useState('180');

  const [subagentBatchExecutionPolicy, setSubagentBatchExecutionPolicy] =
    useState<SubagentBatchExecutionPolicy>(DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY);

  const [toolExecConfigLoading, setToolExecConfigLoading] = useState(false);

  const [deferredToolLoadingConfigSaving, setDeferredToolLoadingConfigSaving] = useState(false);

  const subagentBatchExecutionPolicyOptions: DescribedSelectOption[] = [
    {
      value: 'safe_only',
      label: tTools('config.subagentBatchPolicy.safeOnly'),
      description: tTools('config.subagentBatchPolicy.safeOnlyDesc'),
    },
    {
      value: 'force_parallel',
      label: tTools('config.subagentBatchPolicy.forceParallel'),
      description: tTools('config.subagentBatchPolicy.forceParallelDesc'),
    },
  ];

  const handleDeferredToolLoadingChange = async (checked: boolean) => {
    const previous = enableDeferredToolLoading;
    setEnableDeferredToolLoading(checked);
    setDeferredToolLoadingConfigSaving(true);
    try {
      await configManager.setConfig('ai.enable_deferred_tool_loading', checked);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save enable_deferred_tool_loading', error);
      notificationService.error(
        `${t('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
      setEnableDeferredToolLoading(previous);
    } finally {
      setDeferredToolLoadingConfigSaving(false);
    }
  };

  const handleSubagentBatchExecutionPolicyChange = async (value: string | number | (string | number)[]) => {
    const nextPolicy = normalizeSubagentBatchExecutionPolicy(Array.isArray(value) ? value[0] : value);
    const previousPolicy = subagentBatchExecutionPolicy;
    setSubagentBatchExecutionPolicy(nextPolicy);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.subagent_batch_execution_policy', nextPolicy);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch (error) {
      log.error('Failed to save subagent_batch_execution_policy', error);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
      setSubagentBatchExecutionPolicy(previousPolicy);
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const subagentModelValue = subagentDefaultModel.kind === 'inherit' ? 'inherit' : subagentDefaultModel.model_id;

  const subagentModelOptions: ComboboxOption[] = [
    { value: 'inherit', label: tTools('config.subagentModelInherit') },
    { value: 'fast', label: tModels('sessionTitle.model.fast') },
    { value: 'primary', label: tModels('sessionTitle.model.primary') },
    ...configuredModels.filter(model => model.enabled && model.id).map(buildModelOption),
  ];

  const handleSubagentDefaultModelChange = async (value: string | number) => {
    const selection: SubagentModelSelection = value === 'inherit'
      ? { kind: 'inherit' }
      : { kind: 'fixed', model_id: String(value) };
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.agent_model_defaults.subagents.default', selection);
      setSubagentDefaultModel(selection);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save default subagent model', error);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleSwarmMaxConcurrencyChange = async (input: number) => {
    if (!Number.isFinite(input)) return;
    const value = Math.min(SWARM_MAX_CONCURRENCY_LIMIT, Math.max(1, Math.round(input)));
    const previous = swarmMaxConcurrency;
    setSwarmMaxConcurrency(value);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.swarm_max_concurrency', value);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save swarm_max_concurrency', error);
      setSwarmMaxConcurrency(previous);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleSubagentMaxConcurrencyChange = async (input: number) => {
    if (!Number.isFinite(input)) return;
    const value = Math.min(SUBAGENT_MAX_CONCURRENCY_LIMIT, Math.max(1, Math.round(input)));
    const previous = subagentMaxConcurrency;
    setSubagentMaxConcurrency(value);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.subagent_max_concurrency', value);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save subagent_max_concurrency', error);
      setSubagentMaxConcurrency(previous);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleToolTimeoutChange = async (value: string) => {
    const configKey = 'ai.tool_execution_timeout_secs';
    const trimmedValue = value.trim();
    if (trimmedValue !== '') {
      const numValue = parseInt(trimmedValue, 10);
      if (Number.isNaN(numValue) || numValue < 0) return;
    }
    const previous = executionTimeout;
    setExecutionTimeout(trimmedValue);
    setToolExecConfigLoading(true);
    const numValue = trimmedValue === '' ? null : parseInt(trimmedValue, 10);
    try {
      await configManager.setConfig(configKey, numValue);
    } catch (error) {
      log.error('Failed to save tool timeout config', { error });
      setExecutionTimeout(previous);
      notificationService.error(tTools('messages.saveFailed'));
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleUserQuestionTimeoutChange = async (value: string) => {
    const trimmed = value.trim();
    if (trimmed !== '' && (!/^\d+$/.test(trimmed) || Number(trimmed) > 3600)) return;
    if (toolExecConfigLoading || Number(trimmed) === Number(userQuestionTimeout)) return;
    const previous = userQuestionTimeout;
    setUserQuestionTimeout(trimmed);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.user_question_timeout_secs', trimmed === '' ? null : Number(trimmed));
    } catch (error) {
      log.error('Failed to save user question timeout config', { error });
      setUserQuestionTimeout(previous);
      notificationService.error(tTools('messages.saveFailed'));
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) { setIsLoading(true); setLoadError(false); }
    try {
      const [
        loadedSubagentDefaultModel,
        loadedModels,
        deferredToolLoadingEnabled,
        loadedSubagentMaxConcurrency,
        loadedSwarmMaxConcurrency,
        execTimeout,
        loadedSubagentBatchExecutionPolicy,
        loadedUserQuestionTimeout,
      ] = await Promise.all([
        configManager.getConfig<SubagentModelSelection>('ai.agent_model_defaults.subagents.default'),
        configManager.getConfig<AIModelConfig[]>('ai.models'),
        configManager.getConfig<boolean>('ai.enable_deferred_tool_loading'),
        configManager.getConfig<number | null>('ai.subagent_max_concurrency'),
        configManager.getConfig<number | null>('ai.swarm_max_concurrency'),
        configManager.getConfig<number | null>('ai.tool_execution_timeout_secs'),
        configManager.getConfig<SubagentBatchExecutionPolicy>('ai.subagent_batch_execution_policy'),
        configManager.getOptionalConfig<number | null>('ai.user_question_timeout_secs'),
      ]);
      setSubagentDefaultModel(loadedSubagentDefaultModel ?? { kind: 'fixed', model_id: 'fast' });
      setConfiguredModels(loadedModels ?? []);
      setEnableDeferredToolLoading(deferredToolLoadingEnabled ?? true);
      setSubagentMaxConcurrency(loadedSubagentMaxConcurrency != null
        ? loadedSubagentMaxConcurrency
        : DEFAULT_SUBAGENT_MAX_CONCURRENCY);
      setSwarmMaxConcurrency(loadedSwarmMaxConcurrency != null
        ? loadedSwarmMaxConcurrency
        : DEFAULT_SWARM_MAX_CONCURRENCY);
      setExecutionTimeout(execTimeout != null ? String(execTimeout) : '');
      setUserQuestionTimeout(loadedUserQuestionTimeout === undefined || loadedUserQuestionTimeout === 180
        ? '180'
        : loadedUserQuestionTimeout === null ? '0' : String(loadedUserQuestionTimeout));
      setSubagentBatchExecutionPolicy(normalizeSubagentBatchExecutionPolicy(loadedSubagentBatchExecutionPolicy));

      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, []);
  useEffect(() => {

    void loadPageData();
  }, [loadPageData]);

  if (!subagentModelOptions.some(option => option.value === subagentModelValue)) {
    subagentModelOptions.push({
      value: subagentModelValue,
      label: tModels('sessionTitle.models.unavailable', { id: subagentModelValue }),
      disabled: true,
    });
  }
  return (
    <SettingsPage pageId="ai.execution" className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view="execution">
      {loadError ? (
        <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void loadPageData()} />
      ) : isLoading ? (
        <ConfigLoadingState label={t('loading.text')} />
      ) : (
        <>

          <ConfigPageSection
            title={t('deferredToolLoading.sectionTitle')}
            description={t('deferredToolLoading.sectionDescription')}
          >
            <ConfigPageRow
              label={t('common.enable')}
              description={!enableDeferredToolLoading ? t('deferredToolLoading.warning') : undefined}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Switch
                  checked={enableDeferredToolLoading}
                  onChange={(event) => handleDeferredToolLoadingChange(event.target.checked)}
                  disabled={deferredToolLoadingConfigSaving}
                />
              </div>
            </ConfigPageRow>
          </ConfigPageSection>

          {/* ── Tool execution behavior ────────────────────────────── */}
          <ConfigPageSection
            title={t('toolExecution.sectionTitle')}
            description={t('toolExecution.sectionDescription')}
          >
            <ConfigPageRow
              label={tTools('config.executionTimeout')}
              description={tTools('config.executionTimeoutDesc')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <NumberInput
                  value={executionTimeout === '' ? 0 : parseInt(executionTimeout, 10)}
                  onValueChange={(val) => handleToolTimeoutChange(val === 0 ? '' : String(val))}
                  min={0}
                  max={3600}
                  step={5}
                  unit={tTools('config.seconds')}
                  size="sm"
                  variant="compact"
                  disabled={toolExecConfigLoading}
                />
              </div>
            </ConfigPageRow>
            <ConfigPageRow
              label={tTools('config.userQuestionTimeout')}
              description={tTools('config.userQuestionTimeoutDesc')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <NumberInput
                  value={userQuestionTimeout === '' ? 0 : parseInt(userQuestionTimeout, 10)}
                  onValueChange={(val) => void handleUserQuestionTimeoutChange(val === 0 ? '0' : String(val))}
                  min={0}
                  max={3600}
                  step={5}
                  unit={tTools('config.seconds')}
                  size="sm"
                  variant="compact"
                  disabled={toolExecConfigLoading}
                />
              </div>
            </ConfigPageRow>
          </ConfigPageSection>

          <ConfigPageSection
            title={tTools('section.subagents.title')}
            description={tTools('section.subagents.description')}
          >
            <ConfigPageRow
              className="openbitfun-runtime-settings__subagent-model-row"
              label={
                <span className="openbitfun-runtime-settings__subagent-model-label">
                  {tTools('config.subagentDefaultModel')}
                  <Tooltip content={tTools('config.subagentModelSettings')}>
                    <IconButton
                      type="button"
                      size="sm"
                      className="openbitfun-runtime-settings__subagent-model-settings"
                      aria-label={tTools('config.subagentModelSettings')}
                      icon={<Icon name="settings" size="sm" />}
                      onClick={() => useSceneStore.getState().openScene('agents')}
                    />
                  </Tooltip>
                </span>
              }
              description={tTools('config.subagentDefaultModelDesc')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Combobox
                  value={subagentModelValue}
                  options={subagentModelOptions}
                  size="sm"
                  disabled={toolExecConfigLoading}
                  onValueChange={(value) => void handleSubagentDefaultModelChange(value)}
                />
              </div>
            </ConfigPageRow>
            <ConfigPageRow
              label={tTools('config.subagentBatchPolicy.label')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Select
                  value={subagentBatchExecutionPolicy}
                  options={subagentBatchExecutionPolicyOptions.map(option => ({
                    disabled: option.disabled,
                    label: option.description
                      ? `${option.label} — ${formatStandaloneUiText(option.description)}`
                      : option.label,
                    value: option.value,
                  }))}
                  size="sm"
                  disabled={toolExecConfigLoading}
                  onValueChange={handleSubagentBatchExecutionPolicyChange}
                />
              </div>
            </ConfigPageRow>
            <ConfigPageRow
              label={tTools('config.subagentMaxConcurrency')}
              description={tTools('config.subagentMaxConcurrencyDesc')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <NumberInput
                  value={subagentMaxConcurrency}
                  onValueChange={(val) => void handleSubagentMaxConcurrencyChange(val)}
                  min={1}
                  max={SUBAGENT_MAX_CONCURRENCY_LIMIT}
                  step={1}
                  size="sm"
                  variant="compact"
                  disabled={toolExecConfigLoading}
                />
              </div>
            </ConfigPageRow>
            <ConfigPageRow
              label={tTools('config.swarmMaxConcurrency')}
              description={tTools('config.swarmMaxConcurrencyDesc')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <NumberInput
                  value={swarmMaxConcurrency}
                  onValueChange={(val) => void handleSwarmMaxConcurrencyChange(val)}
                  min={1}
                  max={SWARM_MAX_CONCURRENCY_LIMIT}
                  step={1}
                  size="sm"
                  variant="compact"
                  disabled={toolExecConfigLoading}
                />
              </div>
            </ConfigPageRow>
          </ConfigPageSection>

          <ToolJsonRepairSection />
          <ReviewCapacitySection />

        </>
      )}
    </SettingsPage>
  );
};

export default ExecutionSettingsPage;
