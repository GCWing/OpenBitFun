import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import { ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { useModelSelectPresentation, type ModelSelectOption } from '@/infrastructure/config/components/ModelSelectPresentation';
import { aiExperienceConfigService, type AIExperienceSettings } from '@/infrastructure/config/services/AIExperienceConfigService';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { AIModelConfig, TaskModelSelection, TaskModelsConfig } from '@/infrastructure/config/types';
import { notificationService, useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Combobox, Switch } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const log = createLogger('SessionTitleSection');

const DEFAULT_TASK_MODELS: TaskModelsConfig = {
  session_title: { kind: 'fixed', model_id: 'fast' },
  git_commit: { kind: 'fixed', model_id: 'fast' },
};

function normalizeTaskModels(config?: Partial<TaskModelsConfig> | null): TaskModelsConfig {
  return {
    session_title: config?.session_title ?? DEFAULT_TASK_MODELS.session_title,
    git_commit: config?.git_commit ?? DEFAULT_TASK_MODELS.git_commit,
  };
}

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  return String(Array.isArray(value) ? (value[0] ?? '') : value);
}

export const SessionTitleSection: React.FC = () => {
  const { t } = useTranslation('settings/models');
  const { success: notifySuccess, error: notifyError } = useNotification();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [settings, setSettings] = useState<AIExperienceSettings | null>(null);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [taskModels, setTaskModels] = useState<TaskModelsConfig>(DEFAULT_TASK_MODELS);
  const { buildModelOption } = useModelSelectPresentation();

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const [loadedSettings, allModels, taskModelsData] = await Promise.all([
        aiExperienceConfigService.getSettingsAsync(),
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<Partial<TaskModelsConfig>>('ai.task_models'),
      ]);
      setSettings(loadedSettings);
      setModels(allModels ?? []);
      setTaskModels(normalizeTaskModels(taskModelsData));
    } catch (error) {
      log.error('Failed to load session title config', error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const unwatchModels = configManager.watch('ai.models', () => void loadData());
    const unwatchTaskModels = configManager.watch('ai.task_models', () => void loadData());
    const unwatchSettings = aiExperienceConfigService.addChangeListener((next) => {
      setSettings(next);
    });
    return () => {
      unwatchModels();
      unwatchTaskModels();
      unwatchSettings();
    };
  }, [loadData]);

  const enabledModels = models.filter((model) => model.enabled);
  const selectionValue = (selection: TaskModelSelection): string => (
    selection.kind === 'inherit' ? 'inherit' : selection.model_id
  );
  const sessionTitleModelId = selectionValue(taskModels.session_title);
  const modelOptions = useMemo<ModelSelectOption[]>(() => {
    const options: ModelSelectOption[] = [
      { label: t('sessionTitle.model.inherit'), value: 'inherit' },
      { label: t('sessionTitle.model.fast'), value: 'fast' },
      { label: t('sessionTitle.model.primary'), value: 'primary' },
      ...enabledModels
        .filter((model): model is AIModelConfig & { id: string } => (
          typeof model.id === 'string' && model.id.trim().length > 0
        ))
        .map(buildModelOption),
    ];
    if (sessionTitleModelId
      && !['inherit', 'fast', 'primary'].includes(sessionTitleModelId)
      && !options.some(option => option.value === sessionTitleModelId)) {
      options.push({
        label: t('sessionTitle.models.unavailable', { id: sessionTitleModelId }),
        value: sessionTitleModelId,
        disabled: true,
      });
    }
    return options;
  }, [buildModelOption, enabledModels, sessionTitleModelId, t]);

  const updateEnabled = async (checked: boolean) => {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, enable_session_title_generation: checked };
    setSettings(next);
    try {
      await aiExperienceConfigService.saveSettings({ enable_session_title_generation: checked });
      notifySuccess(t('sessionTitle.messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save session title enable setting', error);
      notifyError(t('sessionTitle.messages.saveFailed'));
      setSettings(previous);
    }
  };

  const getModelName = useCallback((modelId: string | null | undefined): string | undefined => {
    if (!modelId) return undefined;
    return models.find((model) => model.id === modelId)?.name;
  }, [models]);

  const handleModelChange = async (modelId: string) => {
    try {
      const current = await configManager.getConfig<Partial<TaskModelsConfig>>('ai.task_models');
      const selection: TaskModelSelection = modelId === 'inherit'
        ? { kind: 'inherit' }
        : { kind: 'fixed', model_id: modelId };
      const updated = { ...normalizeTaskModels(current), session_title: selection };
      await configManager.setConfig('ai.task_models', updated);
      setTaskModels(updated);

      let modelDesc = '';
      if (modelId === 'inherit') {
        modelDesc = t('sessionTitle.model.inherit');
      } else if (modelId === 'primary') {
        modelDesc = t('sessionTitle.model.primary');
      } else if (modelId === 'fast') {
        modelDesc = t('sessionTitle.model.fast');
      } else {
        modelDesc = getModelName(modelId) || modelId || '';
      }

      notificationService.success(
        t('sessionTitle.models.updateSuccess', {
          agentName: t('sessionTitle.title'),
          modelName: modelDesc,
        }),
        { duration: 2000 },
      );
    } catch (error) {
      log.error('Failed to update session title model', { modelId, error });
      notificationService.error(t('sessionTitle.messages.updateFailed'), { duration: 3000 });
    }
  };

  if (loadError) {
    return (
      <ConfigPageSection
        className="openbitfun-runtime-settings"
        data-openbitfun-component="session-title-config"
        data-openbitfun-part="root"
        title={t('sessionTitle.title')}
        description={t('sessionTitle.subtitle')}
      >
        <ConfigRetryState
          message={t('sessionTitle.loadFailedLocked')}
          retryLabel={t('sessionTitle.retry')}
          onRetry={() => void loadData()}
        />
      </ConfigPageSection>
    );
  }

  return (
    <>
      <ConfigPageSection
        className="openbitfun-runtime-settings"
        data-openbitfun-component="session-title-config"
        data-openbitfun-part="root"
        title={t('sessionTitle.title')}
        description={t('sessionTitle.subtitle')}
      >
        <ConfigPageRow
          label={t('sessionTitle.enable')}
          align="center"
        >
          <div
            className="openbitfun-runtime-settings__appearance-host"
            data-openbitfun-component="session-title-config"
            data-openbitfun-part="enableControl"
          >
            <Switch
              checked={settings?.enable_session_title_generation ?? false}
              onChange={(e) => void updateEnabled(e.target.checked)}
              disabled={isLoading || !settings}
              aria-label={t('sessionTitle.title')}
            />
          </div>
        </ConfigPageRow>
        {settings?.enable_session_title_generation ? (
          <ConfigPageRow
            label={t('sessionTitle.model.label')}
            description={enabledModels.length === 0 ? t('sessionTitle.models.empty') : undefined}
            align="center"
          >
            <div
              className="openbitfun-runtime-settings__appearance-host"
              data-openbitfun-component="session-title-config"
              data-openbitfun-part="modelControl"
            >
              <Combobox
                size="sm"
                options={modelOptions}
                value={sessionTitleModelId}
                onValueChange={(value) => void handleModelChange(normalizeSelectValue(value))}
                disabled={isLoading}
                data-testid="settings-session-title-model-select"
              />
            </div>
          </ConfigPageRow>
        ) : null}
      </ConfigPageSection>
    </>
  );
};

export default SessionTitleSection;
