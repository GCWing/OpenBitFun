import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState
} from '@/infrastructure/config/components/common';
import { GlobalPermissionRulesDialog } from '@/infrastructure/config/components/GlobalPermissionRulesDialog';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import {
  DEFAULT_TOOL_PERMISSION_CONFIG,
  normalizeToolPermissionConfig,
  permissionConfigService,
} from '@/infrastructure/config/services/PermissionConfigService';
import type {
  PermissionRule,
  ToolPermissionConfig
} from '@/infrastructure/config/types';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  Button,
  Select,
  Switch
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const log = createLogger('PermissionsSettingsPage');

type ToolPermissionMode = 'ask' | 'auto' | 'full_access';

const SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH = 'app.flow_chat.show_permission_mode_control';

function resolveToolPermissionMode(config: ToolPermissionConfig): ToolPermissionMode {
  if (config.policy.preset === 'full_access') return 'full_access';
  return config.interaction.auto_approve_ask ? 'auto' : 'ask';
}

const PermissionsSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/runtime');

  const [isLoading, setIsLoading] = useState(true);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(false);

  const toolPermissionSaveInFlightRef = useRef(false);

  const [toolPermissionConfig, setToolPermissionConfig] = useState<ToolPermissionConfig>(DEFAULT_TOOL_PERMISSION_CONFIG);

  const [permissionConfigSaving, setPermissionConfigSaving] = useState(false);

  const [showPermissionModeControl, setShowPermissionModeControl] = useState(true);

  const [permissionModeControlVisibilitySaving, setPermissionModeControlVisibilitySaving] = useState(false);

  const [isGlobalPermissionRulesDialogOpen, setIsGlobalPermissionRulesDialogOpen] = useState(false);

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

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) { setIsLoading(true); setLoadError(false); }
    try {
      const [permissionConfig, permissionModeVisible] = await Promise.all([
        permissionConfigService.getConfig(),
        configManager.getOptionalConfig<boolean>(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH),
      ]);
      setToolPermissionConfig(normalizeToolPermissionConfig(permissionConfig));
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

    void loadPageData();
  }, [loadPageData]);

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
