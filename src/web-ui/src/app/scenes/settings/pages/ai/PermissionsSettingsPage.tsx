import { useConfigSeed } from '@/infrastructure/config/hooks/useConfigSeed';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState
} from '@/infrastructure/config/components/common';
import { GlobalPermissionRulesDialog } from '@/infrastructure/config/components/GlobalPermissionRulesDialog';
import { useModelSelectPresentation, type ModelSelectOption } from '@/infrastructure/config/components/ModelSelectPresentation';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import {
  DEFAULT_TOOL_PERMISSION_CONFIG,
  normalizeToolPermissionConfig,
  permissionConfigService,
} from '@/infrastructure/config/services/PermissionConfigService';
import type {
  AIModelConfig,
  DefaultModelsConfig,
  PermissionRule,
  ToolPermissionConfig
} from '@/infrastructure/config/types';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Save, Trash2 } from 'lucide-react';
import {
  Button,
  Combobox,
  IconButton,
  Input,
  NumberInput,
  Select,
  Switch
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const log = createLogger('PermissionsSettingsPage');

type ToolPermissionMode = 'ask' | 'auto' | 'full_access';
const DEFAULT_APPROVAL_MODEL_ID = 'fast';
const DEFAULT_DECISION_MODEL_NAME = 'jev-latest';

const SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH = 'app.flow_chat.show_permission_mode_control';

function resolveToolPermissionMode(config: ToolPermissionConfig): ToolPermissionMode {
  if (config.policy.preset === 'full_access') return 'full_access';
  if (config.approval?.strategy === 'model' || config.approval?.strategy === 'immediate_allow') return 'auto';
  return config.interaction.auto_approve_ask ? 'auto' : 'ask';
}

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  return String(Array.isArray(value) ? (value[0] ?? '') : value);
}

const PermissionsSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/runtime');
  const { buildModelOption } = useModelSelectPresentation();

  const seed = useConfigSeed(['tool_permissions', 'ai.models', 'ai.default_models', 'ai.decision_model', SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH]);
  const [isLoading, setIsLoading] = useState(!seed.loaded);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(seed.loaded);

  const toolPermissionSaveInFlightRef = useRef(false);

  const [toolPermissionConfig, setToolPermissionConfig] = useState<ToolPermissionConfig>(() => normalizeToolPermissionConfig(seed.get('tool_permissions', DEFAULT_TOOL_PERMISSION_CONFIG)));

  const [configuredModels, setConfiguredModels] = useState<AIModelConfig[]>(() => seed.get<AIModelConfig[] | null>('ai.models', null) ?? []);
  const [defaultModels, setDefaultModels] = useState<DefaultModelsConfig>(() => seed.get<DefaultModelsConfig | null>('ai.default_models', null) ?? {});
  const [approvalModelId, setApprovalModelId] = useState(() => {
    const approval = normalizeToolPermissionConfig(seed.get('tool_permissions', DEFAULT_TOOL_PERMISSION_CONFIG)).approval;
    return approval?.model_kind === 'chat' ? approval.chat_model_id.trim() || DEFAULT_APPROVAL_MODEL_ID : DEFAULT_APPROVAL_MODEL_ID;
  });
  const [decisionModelName, setDecisionModelName] = useState(() => {
    const value = seed.get<{ model_name?: string } | null>('ai.decision_model', null);
    return value?.model_name?.trim() || DEFAULT_DECISION_MODEL_NAME;
  });
  const [decisionModelEndpoint, setDecisionModelEndpoint] = useState(() => {
    const value = seed.get<{ endpoint?: string } | null>('ai.decision_model', null);
    return value?.endpoint?.trim() || 'https://api.typesafe.ai/v1/systemone';
  });
  const [decisionModelApiKey, setDecisionModelApiKey] = useState('');
  const [decisionModelApiKeyConfigured, setDecisionModelApiKeyConfigured] = useState(false);
  const [decisionModelCredentialSaving, setDecisionModelCredentialSaving] = useState(false);

  const [permissionConfigSaving, setPermissionConfigSaving] = useState(false);

  const [showPermissionModeControl, setShowPermissionModeControl] = useState(seed.get<boolean | null>(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH, true) !== false);

  const [permissionModeControlVisibilitySaving, setPermissionModeControlVisibilitySaving] = useState(false);

  const [isGlobalPermissionRulesDialogOpen, setIsGlobalPermissionRulesDialogOpen] = useState(false);

  const selectableApprovalModels = useMemo(
    () => configuredModels.filter(model => model.enabled && typeof model.id === 'string' && model.id.trim().length > 0),
    [configuredModels],
  );
  const approvalModelOptions = useMemo<ModelSelectOption[]>(() => {
    const modelById = new Map(selectableApprovalModels.map(model => [model.id, model]));
    const primaryModel = defaultModels.primary ? modelById.get(defaultModels.primary) : undefined;
    const fastModel = (defaultModels.fast ? modelById.get(defaultModels.fast) : undefined) ?? primaryModel;
    const roleOption = (role: 'primary' | 'fast', model: AIModelConfig | undefined): ModelSelectOption => {
      const modelOption = model ? buildModelOption(model) : undefined;
      return {
        label: t(`permissionPolicy.approvalModel${role === 'fast' ? 'Fast' : 'Primary'}`),
        value: role,
        description: modelOption
          ? [modelOption.label, modelOption.description].filter(Boolean).join(' · ')
          : t('permissionPolicy.approvalModelNotConfigured'),
        disabled: !model,
      };
    };
    const options = [roleOption('fast', fastModel), roleOption('primary', primaryModel), ...selectableApprovalModels.map(buildModelOption)];
    if (approvalModelId && !options.some(option => option.value === approvalModelId)) {
      options.unshift({
        label: t('permissionPolicy.approvalModelUnavailable', { id: approvalModelId }),
        value: approvalModelId,
        disabled: true,
      });
    }
    return options;
  }, [approvalModelId, buildModelOption, defaultModels, selectableApprovalModels, t]);

  const saveToolPermissionConfig = async (
    nextConfig: ToolPermissionConfig,
    previousConfig: ToolPermissionConfig,
  ): Promise<boolean> => {
    if (toolPermissionSaveInFlightRef.current) return false;
    toolPermissionSaveInFlightRef.current = true;
    setToolPermissionConfig(nextConfig);
    setPermissionConfigSaving(true);
    try {
      await permissionConfigService.saveConfig(nextConfig);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
      return true;
    } catch (error) {
      log.error('Failed to save tool permission config', error);
      setToolPermissionConfig(previousConfig);
      notificationService.error(t('messages.saveFailed'));
      return false;
    } finally {
      toolPermissionSaveInFlightRef.current = false;
      setPermissionConfigSaving(false);
    }
  };

  const handlePermissionModeChange = async (value: string | number | (string | number)[]) => {
    const nextModeValue = String(Array.isArray(value) ? value[0] : value);
    const nextMode: ToolPermissionMode = nextModeValue === 'full_access'
      ? 'full_access'
      : nextModeValue === 'auto'
        ? 'auto'
        : 'ask';
    const previousConfig = toolPermissionConfig;
    const currentMode = resolveToolPermissionMode(previousConfig);
    if (nextMode === currentMode) return;

    if (nextMode === 'full_access') {
      const confirmed = await confirmDanger(
        t('permissionPolicy.fullAccessWarningTitle'),
        t('permissionPolicy.fullAccessWarningMessage'),
        {
          confirmText: t('permissionPolicy.fullAccessConfirm'),
          cancelText: t('permissionPolicy.cancel'),
        },
      );
      if (!confirmed) return;
    }

    await saveToolPermissionConfig(
      {
        policy: {
          ...previousConfig.policy,
          preset: nextMode === 'full_access' ? 'full_access' : 'ask',
        },
        interaction: {
          ...previousConfig.interaction,
          auto_approve_ask: nextMode === 'auto',
        },
        approval: {
          ...(previousConfig.approval ?? {
            strategy: 'interactive' as const,
            model_kind: 'chat' as const,
            chat_model_id: '',
            timeout_ms: 30_000,
            on_ask: 'user' as const,
            on_error: 'ask' as const,
          }),
          strategy: nextMode === 'auto' ? 'model' : 'interactive',
          model_kind: previousConfig.approval?.model_kind ?? 'chat',
          chat_model_id: nextMode === 'auto'
            ? (previousConfig.approval?.chat_model_id?.trim() || DEFAULT_APPROVAL_MODEL_ID)
            : (previousConfig.approval?.chat_model_id ?? ''),
        },
      },
      previousConfig,
    );
  };

  const handleSaveGlobalPermissionRules = async (rules: PermissionRule[]): Promise<boolean> => {
    const previousConfig = toolPermissionConfig;
    return saveToolPermissionConfig(
      { ...previousConfig, policy: { ...previousConfig.policy, rules } },
      previousConfig,
    );
  };

  const handlePermissionModeControlVisibilityChange = async (visible: boolean) => {
    const previousVisibility = showPermissionModeControl;
    setShowPermissionModeControl(visible);
    setPermissionModeControlVisibilitySaving(true);
    try {
      await configManager.setConfig(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH, visible);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save permission mode control visibility', error);
      setShowPermissionModeControl(previousVisibility);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setPermissionModeControlVisibilitySaving(false);
    }
  };

  const handleApprovalModelChange = (value: string | number | (string | number)[]) => {
    const nextModelId = normalizeSelectValue(value);
    const previousModelId = approvalModelId;
    setApprovalModelId(nextModelId);
    const previousConfig = toolPermissionConfig;
    const approval = previousConfig.approval ?? {
      strategy: 'model' as const,
      model_kind: 'chat' as const,
      chat_model_id: '',
      timeout_ms: 30_000,
      on_ask: 'user' as const,
      on_error: 'ask' as const,
    };
    void saveToolPermissionConfig({
      ...previousConfig,
      approval: {
        ...approval,
        strategy: 'model',
        model_kind: 'chat',
        chat_model_id: nextModelId,
      },
    }, previousConfig).then(saved => {
      if (!saved) setApprovalModelId(previousModelId);
    });
  };

  const handleDecisionModelEndpointBlur = async () => {
    const endpoint = decisionModelEndpoint.trim();
    if (!endpoint) return;
    try {
      await configManager.setConfig('ai.decision_model.endpoint', endpoint);
      setDecisionModelEndpoint(endpoint);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save decision-model endpoint', error);
      notificationService.error(t('messages.saveFailed'));
    }
  };

  const handleDecisionModelNameBlur = async () => {
    const modelName = decisionModelName.trim();
    if (!modelName) return;
    try {
      await configManager.setConfig('ai.decision_model.model_name', modelName);
      setDecisionModelName(modelName);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save decision-model name', error);
      notificationService.error(t('messages.saveFailed'));
    }
  };

  const handleDecisionModelApiKeySave = async () => {
    if (!decisionModelApiKey.trim()) return;
    setDecisionModelCredentialSaving(true);
    try {
      const status = await configAPI.saveDecisionModelCredential(decisionModelApiKey);
      setDecisionModelApiKey('');
      setDecisionModelApiKeyConfigured(status.configured);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save decision-model API key', error);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setDecisionModelCredentialSaving(false);
    }
  };

  const handleDecisionModelApiKeyClear = async () => {
    setDecisionModelCredentialSaving(true);
    try {
      const status = await configAPI.clearDecisionModelCredential();
      setDecisionModelApiKeyConfigured(status.configured);
      setDecisionModelApiKey('');
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to clear decision-model API key', error);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setDecisionModelCredentialSaving(false);
    }
  };

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) { setIsLoading(true); setLoadError(false); }
    try {
      const [permissionConfig, models, loadedDefaultModels, decisionModel, decisionCredentialStatus, permissionModeVisible] = await Promise.all([
        permissionConfigService.getConfig({ requireLoaded: true }),
        configManager.getOptionalConfig<AIModelConfig[]>('ai.models'),
        configManager.getOptionalConfig<DefaultModelsConfig>('ai.default_models'),
        configManager.getOptionalConfig<{ endpoint?: string; model_name?: string }>('ai.decision_model'),
        configAPI.getDecisionModelCredentialStatus(),
        configManager.getOptionalConfig<boolean>(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH),
      ]);
      setToolPermissionConfig(normalizeToolPermissionConfig(permissionConfig));
      const loadedApproval = normalizeToolPermissionConfig(permissionConfig).approval;
      setApprovalModelId(loadedApproval?.model_kind === 'chat'
        ? loadedApproval.chat_model_id.trim() || DEFAULT_APPROVAL_MODEL_ID
        : DEFAULT_APPROVAL_MODEL_ID);
      setConfiguredModels(models ?? []);
      setDefaultModels(loadedDefaultModels ?? {});
      setDecisionModelName(decisionModel?.model_name?.trim() || DEFAULT_DECISION_MODEL_NAME);
      setDecisionModelEndpoint(decisionModel?.endpoint?.trim() || 'https://api.typesafe.ai/v1/systemone');
      setDecisionModelApiKeyConfigured(decisionCredentialStatus.configured);
      setShowPermissionModeControl(permissionModeVisible !== false);
      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, []);
  useEffect(() => {

    if (!seed.loaded) void loadPageData();
  }, [loadPageData, seed.loaded]);

  return (
    <SettingsPage pageId="ai.permissions" className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view="permissions">
      {loadError ? (
        <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void loadPageData()} />
      ) : isLoading ? (
        <ConfigLoadingState label={t('loading.text')} />
      ) : <>
        <ConfigPageSection
          title={t('permissionPolicy.sectionTitle')}
          description={t('permissionPolicy.sectionDescription')}
        >
          <ConfigPageRow
            label={t('permissionPolicy.mode')}
            description={`${resolveToolPermissionMode(toolPermissionConfig) === 'full_access'
              ? t('permissionPolicy.fullAccessDescription')
              : resolveToolPermissionMode(toolPermissionConfig) === 'auto'
                ? t('permissionPolicy.autoApproveDescription')
                : t('permissionPolicy.askDescription')} ${t('permissionPolicy.modeDescription')}`}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Select
                size="sm"
                value={resolveToolPermissionMode(toolPermissionConfig)}
                options={[
                  { value: 'ask', label: t('permissionPolicy.ask') },
                  { value: 'auto', label: t('permissionPolicy.autoApprove') },
                  { value: 'full_access', label: t('permissionPolicy.fullAccess') },
                ]}
                disabled={permissionConfigSaving}
                onValueChange={handlePermissionModeChange}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.showInChatInput')}
            description={t('permissionPolicy.showInChatInputDescription')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control">
              <Switch
                checked={showPermissionModeControl}
                disabled={permissionModeControlVisibilitySaving}
                onChange={event => void handlePermissionModeControlVisibilityChange(event.target.checked)}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.globalRules')}
            description={t('permissionPolicy.globalRulesDescription')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={permissionConfigSaving}
                onClick={() => setIsGlobalPermissionRulesDialogOpen(true)}
              >
                {t('permissionPolicy.manageGlobalRules')}
              </Button>
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('permissionPolicy.automaticApprovalSectionTitle')}
          description={t('permissionPolicy.automaticApprovalSectionDescription')}
        >
          <ConfigPageRow
            label={t('permissionPolicy.approvalModelKind')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Select
                size="sm"
                value={toolPermissionConfig.approval?.model_kind ?? 'chat'}
                options={[
                  { value: 'chat', label: t('permissionPolicy.chatModel') },
                  { value: 'decision', label: t('permissionPolicy.decisionModel') },
                ]}
                disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
                onValueChange={(value) => {
                  const kind = String(Array.isArray(value) ? value[0] : value) === 'decision' ? 'decision' : 'chat';
                  const approval = toolPermissionConfig.approval ?? {
                    strategy: 'model' as const,
                    model_kind: 'chat' as const,
                    chat_model_id: approvalModelId.trim() || DEFAULT_APPROVAL_MODEL_ID,
                    timeout_ms: 30_000,
                    on_ask: 'user' as const,
                    on_error: 'ask' as const,
                  };
                  void saveToolPermissionConfig({
                    ...toolPermissionConfig,
                    approval: {
                      ...approval,
                      strategy: 'model',
                      model_kind: kind,
                    },
                  }, toolPermissionConfig);
                }}
              />
            </div>
          </ConfigPageRow>
          {toolPermissionConfig.approval?.model_kind !== 'decision' ? (
            <ConfigPageRow
              label={t('permissionPolicy.approvalModel')}
              align="center"
            >
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Combobox
                  size="sm"
                  value={approvalModelId}
                  placeholder={t('permissionPolicy.approvalModelPlaceholder')}
                  options={approvalModelOptions}
                  disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto' || approvalModelOptions.length === 0}
                  onValueChange={handleApprovalModelChange}
                />
              </div>
            </ConfigPageRow>
          ) : (
            <>
              <ConfigPageRow
                label={t('permissionPolicy.decisionModelName')}
                align="center"
              >
                <div className="openbitfun-runtime-settings__row-control">
                  <Input
                    size="sm"
                    value={decisionModelName}
                    disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
                    onChange={event => setDecisionModelName(event.target.value)}
                    onBlur={() => void handleDecisionModelNameBlur()}
                  />
                </div>
              </ConfigPageRow>
              <ConfigPageRow
                label={t('permissionPolicy.decisionModelEndpoint')}
                description={t('permissionPolicy.decisionModelEndpointDescription')}
                align="center"
              >
                <div className="openbitfun-runtime-settings__row-control">
                  <Input
                    size="sm"
                    value={decisionModelEndpoint}
                    disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
                    onChange={event => setDecisionModelEndpoint(event.target.value)}
                    onBlur={() => void handleDecisionModelEndpointBlur()}
                  />
                </div>
              </ConfigPageRow>
              <ConfigPageRow
                label={t('permissionPolicy.decisionModelApiKey')}
                description={t('permissionPolicy.decisionModelApiKeyDescription')}
                align="center"
                className="openbitfun-runtime-settings__decision-model-credential-row"
              >
                <div className="openbitfun-runtime-settings__row-control openbitfun-runtime-settings__decision-model-credential">
                  <div className="openbitfun-runtime-settings__decision-model-credential-input">
                    <Input
                      size="sm"
                      type="password"
                      value={decisionModelApiKey}
                      placeholder={decisionModelApiKeyConfigured
                        ? t('permissionPolicy.decisionModelApiKeyConfigured')
                        : t('permissionPolicy.decisionModelApiKeyPlaceholder')}
                      disabled={permissionConfigSaving || decisionModelCredentialSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
                      onChange={event => setDecisionModelApiKey(event.target.value)}
                    />
                  </div>
                  <IconButton
                    type="button"
                    size="sm"
                    variant="outline"
                    icon={<Save size={15} />}
                    aria-label={t('permissionPolicy.saveDecisionModelApiKey')}
                    title={t('permissionPolicy.saveDecisionModelApiKey')}
                    disabled={decisionModelCredentialSaving || !decisionModelApiKey.trim()}
                    onClick={() => void handleDecisionModelApiKeySave()}
                  />
                  {decisionModelApiKeyConfigured && (
                    <IconButton
                      type="button"
                      size="sm"
                      variant="quiet"
                      tone="danger"
                      icon={<Trash2 size={15} />}
                      aria-label={t('permissionPolicy.clearDecisionModelApiKey')}
                      title={t('permissionPolicy.clearDecisionModelApiKey')}
                      disabled={decisionModelCredentialSaving}
                      onClick={() => void handleDecisionModelApiKeyClear()}
                    />
                  )}
                </div>
              </ConfigPageRow>
            </>
          )}
          <ConfigPageRow
            label={t('permissionPolicy.approvalTimeout')}
            description={t('permissionPolicy.approvalTimeoutDescription')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <NumberInput
                size="sm"
                variant="compact"
                value={Math.round((toolPermissionConfig.approval?.timeout_ms ?? 30_000) / 1000)}
                min={1}
                max={300}
                step={1}
                unit={t('permissionPolicy.seconds')}
                disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
                onValueChange={(value) => {
                  const approval = toolPermissionConfig.approval;
                  if (!approval) return;
                  void saveToolPermissionConfig({ ...toolPermissionConfig, approval: { ...approval, timeout_ms: value * 1000 } }, toolPermissionConfig);
                }}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.onAsk')}
            description={t('permissionPolicy.onAskDescription')}
            align="center"
          >
            <Select
              size="sm"
              value={toolPermissionConfig.approval?.on_ask ?? 'user'}
              options={[
                { value: 'user', label: t('permissionPolicy.askUser') },
                { value: 'reject', label: t('permissionPolicy.reject') },
              ]}
              disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
              onValueChange={(value) => {
                const approval = toolPermissionConfig.approval;
                if (!approval) return;
                const onAsk = String(Array.isArray(value) ? value[0] : value) === 'reject' ? 'reject' : 'user';
                void saveToolPermissionConfig({ ...toolPermissionConfig, approval: { ...approval, on_ask: onAsk } }, toolPermissionConfig);
              }}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.onError')}
            description={t('permissionPolicy.onErrorDescription')}
            align="center"
          >
            <Select
              size="sm"
              value={toolPermissionConfig.approval?.on_error ?? 'ask'}
              options={[
                { value: 'ask', label: t('permissionPolicy.askUser') },
                { value: 'reject', label: t('permissionPolicy.reject') },
              ]}
              disabled={permissionConfigSaving || resolveToolPermissionMode(toolPermissionConfig) !== 'auto'}
              onValueChange={(value) => {
                const approval = toolPermissionConfig.approval;
                if (!approval) return;
                const onError = String(Array.isArray(value) ? value[0] : value) === 'reject' ? 'reject' : 'ask';
                void saveToolPermissionConfig({ ...toolPermissionConfig, approval: { ...approval, on_error: onError } }, toolPermissionConfig);
              }}
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <GlobalPermissionRulesDialog
          isOpen={isGlobalPermissionRulesDialogOpen}
          rules={toolPermissionConfig.policy.rules}
          isSaving={permissionConfigSaving}
          onSave={handleSaveGlobalPermissionRules}
          onClose={() => setIsGlobalPermissionRulesDialogOpen(false)}
        />

      </>}
    </SettingsPage>
  );
};

export default PermissionsSettingsPage;
