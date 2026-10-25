import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { modelSelectionsConfigPath, effectiveModelSelections, readModelSelections } from '@/infrastructure/config/services/modelSelections';
import { readableModelPools, supportsModelPools, type ModelPoolDefinition, type ModelPoolDocument } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { useConfigSeed } from '@/infrastructure/config/hooks/useConfigSeed';
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
  AgentModelTargetSelection, AgentModelSelections
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
type ToolPresentationMode = 'native' | 'ptc';

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

  const seed = useConfigSeed([modelSelectionsConfigPath(), 'ai.models', 'ai.enable_deferred_tool_loading', 'ai.subagent_max_concurrency', 'ai.swarm_max_concurrency', 'ai.tool_execution_timeout_secs', 'ai.subagent_batch_execution_policy', 'ai.user_question_timeout_secs', 'ai.tool_presentation_mode']);
  let seededSelections: AgentModelSelections | undefined;
  if (seed.loaded) {
    try { seededSelections = effectiveModelSelections(seed.get(modelSelectionsConfigPath(), undefined)); }
    catch { /* The strict read below surfaces malformed or missing settings. */ }
  }
  const hasSeededPageData = seed.loaded && Boolean(seededSelections);
  const [subagentDefaultModel, setSubagentDefaultModel] = useState<AgentModelTargetSelection>(() => seededSelections?.subagents.default ?? { kind: 'inherit' });
  const [modelPools, setModelPools] = useState<ModelPoolDefinition[]>(() => {
    const document = seed.get<ModelPoolDocument | null>('ai.model_pools', null);
    return document ? readableModelPools(document) : [];
  });

  const [configuredModels, setConfiguredModels] = useState<AIModelConfig[]>(seed.get<AIModelConfig[] | null>('ai.models', null) ?? []);

  const [isLoading, setIsLoading] = useState(!hasSeededPageData);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(hasSeededPageData);

  const [enableDeferredToolLoading, setEnableDeferredToolLoading] = useState(seed.get('ai.enable_deferred_tool_loading', true) ?? true);

  const [subagentMaxConcurrency, setSubagentMaxConcurrency] = useState(seed.get<number | null>('ai.subagent_max_concurrency', null) ?? DEFAULT_SUBAGENT_MAX_CONCURRENCY);

  const [swarmMaxConcurrency, setSwarmMaxConcurrency] = useState(seed.get<number | null>('ai.swarm_max_concurrency', null) ?? DEFAULT_SWARM_MAX_CONCURRENCY);

  const [executionTimeout, setExecutionTimeout] = useState(String(seed.get<number | null>('ai.tool_execution_timeout_secs', null) ?? ''));

  const [userQuestionTimeout, setUserQuestionTimeout] = useState(String(seed.get<number | null>('ai.user_question_timeout_secs', 180) ?? 0));

  const [subagentBatchExecutionPolicy, setSubagentBatchExecutionPolicy] =
    useState<SubagentBatchExecutionPolicy>(() => normalizeSubagentBatchExecutionPolicy(seed.get('ai.subagent_batch_execution_policy', DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY)));

  const [toolExecConfigLoading, setToolExecConfigLoading] = useState(false);

  const [deferredToolLoadingConfigSaving, setDeferredToolLoadingConfigSaving] = useState(false);

  const [toolPresentationMode, setToolPresentationMode] = useState<ToolPresentationMode>(
    seed.get<ToolPresentationMode | null>('ai.tool_presentation_mode', 'native') === 'ptc' ? 'ptc' : 'native',
  );

  const [toolPresentationModeSaving, setToolPresentationModeSaving] = useState(false);

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

  const handleToolPresentationModeChange = async (value: string | number | (string | number)[]) => {
    const nextMode: ToolPresentationMode = String(Array.isArray(value) ? value[0] : value) === 'ptc'
      ? 'ptc'
      : 'native';
    if (nextMode === toolPresentationMode) return;
    const previousMode = toolPresentationMode;
    setToolPresentationMode(nextMode);
    setToolPresentationModeSaving(true);
    try {
      await configManager.setConfig('ai.tool_presentation_mode', nextMode);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save tool presentation mode', error);
      setToolPresentationMode(previousMode);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setToolPresentationModeSaving(false);
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

  const subagentModelValue = JSON.stringify(subagentDefaultModel);

  const subagentModelOptions: ComboboxOption[] = [
    { value: JSON.stringify({ kind: 'inherit' }), label: tTools('config.subagentModelInherit') },
    { value: JSON.stringify({ kind: 'model', model_ref: 'fast' }), label: tModels('sessionTitle.model.fast') },
    { value: JSON.stringify({ kind: 'model', model_ref: 'primary' }), label: tModels('sessionTitle.model.primary') },
    ...filterSelectableTextChatModels(configuredModels).filter(model => model.id).map(model => ({ ...buildModelOption(model), value: JSON.stringify({ kind: 'model', model_ref: model.id }) })),
    ...(supportsModelPools() ? modelPools.map(pool => ({ value: JSON.stringify({ kind: 'pool', pool_id: pool.id }), label: pool.name, description: tModels('pools.title') })) : []),
  ];

  const handleSubagentDefaultModelChange = async (value: string | number) => {
    const scope = getActiveSurfaceScope();
    const selection = JSON.parse(String(value)) as AgentModelTargetSelection;
    setToolExecConfigLoading(true);
    try {
      if (modelSelectionsConfigPath() === 'ai.agent_model_selections') {
        await configManager.setConfig('ai.agent_model_selections.subagents.default', selection);
      } else {
        if (selection.kind === 'pool') throw new Error('This host does not support model_pool_selection_v1');
        await configManager.setConfig('ai.agent_model_defaults.subagents.default', selection.kind === 'inherit' ? selection : { kind: 'fixed', model_id: selection.model_ref });
      }
      if (!scope.isCurrent()) return;
      setSubagentDefaultModel(selection);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to save default subagent model', error);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (scope.isCurrent()) setToolExecConfigLoading(false);
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
        loadedToolPresentationMode,
        poolDocument,
      ] = await Promise.all([
        readModelSelections(),
        configManager.getConfig<AIModelConfig[]>('ai.models'),
        configManager.getConfig<boolean>('ai.enable_deferred_tool_loading'),
        configManager.getConfig<number | null>('ai.subagent_max_concurrency'),
        configManager.getConfig<number | null>('ai.swarm_max_concurrency'),
        configManager.getConfig<number | null>('ai.tool_execution_timeout_secs'),
        configManager.getConfig<SubagentBatchExecutionPolicy>('ai.subagent_batch_execution_policy'),
        configManager.getOptionalConfig<number | null>('ai.user_question_timeout_secs'),
        configManager.getOptionalConfig<string>('ai.tool_presentation_mode'),
        supportsModelPools() ? configManager.getOptionalConfig<ModelPoolDocument>('ai.model_pools') : Promise.resolve(undefined),
      ]);
      setSubagentDefaultModel(loadedSubagentDefaultModel.subagents.default);
      setModelPools(poolDocument ? readableModelPools(poolDocument) : []);
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
      setToolPresentationMode(loadedToolPresentationMode === 'ptc' ? 'ptc' : 'native');

      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, []);
  useEffect(() => {

    if (!hasSeededPageData) {
      void loadPageData();
      return;
    }
    if (!supportsModelPools()) return;
    const scope = getActiveSurfaceScope();
    let active = true;
    void configManager.getOptionalConfig<ModelPoolDocument>('ai.model_pools').then(document => {
      if (active && scope.isCurrent()) setModelPools(document ? readableModelPools(document) : []);
    }).catch(error => {
      if (active && scope.isCurrent()) { log.error('Failed to load model pools', { error }); setLoadError(true); }
    });
    return () => { active = false; };
  }, [loadPageData, hasSeededPageData]);

  if (!subagentModelOptions.some(option => option.value === subagentModelValue)) {
    subagentModelOptions.push({
      value: subagentModelValue,
      label: tModels('sessionTitle.models.unavailable', { id: subagentDefaultModel.kind === 'pool' ? subagentDefaultModel.pool_id : subagentDefaultModel.kind === 'model' ? subagentDefaultModel.model_ref : tTools('config.subagentModelInherit') }),
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

          <ConfigPageSection
            title={t('toolPresentation.sectionTitle')}
            description={t('toolPresentation.sectionDescription')}
          >
            <ConfigPageRow
              label={t('toolPresentation.mode')}
              description={t('toolPresentation.description')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Select
                  size="sm"
                  value={toolPresentationMode}
                  options={[
                    { value: 'native', label: t('toolPresentation.native') },
                    { value: 'ptc', label: t('toolPresentation.ptc'), tooltip: t('toolPresentation.ptcTooltip') },
                  ]}
                  disabled={toolPresentationModeSaving}
                  onValueChange={handleToolPresentationModeChange}
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
