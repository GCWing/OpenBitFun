import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { notificationService } from '@/shared/notification-system';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { configManager } from '../services/ConfigManager';
import type {
  AIModelConfig,
  DefaultModelsConfig,
} from '../types';
import { ConfigPageRow } from './common';
import { createLogger } from '@/shared/utils/logger';
import { useModelSelectPresentation } from './ModelSelectPresentation';
import {
  filterSelectableTextChatModels,
  isSelectableModelForCapability,
} from '../services/modelCategory';
import './DefaultModelConfig.scss';

const log = createLogger('DefaultModelConfig');

const normalizeSelectValue = (value: string | number | (string | number)[]): string | number =>
  Array.isArray(value) ? (value[0] ?? '') : value;

type DefaultModelSlot = 'primary' | 'fast' | 'image_understanding' | 'speech_recognition';

interface DefaultModelConfigProps {
  compact?: boolean;
  models: AIModelConfig[];
  defaultModels: DefaultModelsConfig;
  loading: boolean;
  disabled: boolean;
  onDefaultModelsChange: (defaults: DefaultModelsConfig) => void;
}

export const DefaultModelConfig: React.FC<DefaultModelConfigProps> = ({
  compact = false,
  models,
  defaultModels,
  loading,
  disabled,
  onDefaultModelsChange,
}) => {
  const { t } = useTranslation('settings/default-model');
  const { buildModelOption } = useModelSelectPresentation();
  const controlsDisabled = loading || disabled || models.length === 0;
  const pendingPlaceholder = loading ? (
    <span data-openbitfun-component="default-model-config" data-openbitfun-part="loading" data-openbitfun-state="loading">
      {t('loading')}
    </span>
  ) : disabled ? t('messages.loadFailed') : models.length === 0 ? (
    <span data-openbitfun-component="default-model-config" data-openbitfun-part="empty" data-openbitfun-state="empty">
      {t('empty.noModels')}
    </span>
  ) : undefined;
  const renderSlotLabel = (label: string, description: string) => (
    <span className="default-model-config__slot-label-content">
      <span>{label}</span>
      <Tooltip content={description} placement="top" trigger="hover-focus" openOnClick>
        <IconButton
          size="xs"
          variant="annotation"
          aria-label={description}
          icon={<Icon name="info" size="xs" />}
        />
      </Tooltip>
    </span>
  );
  
  const getModelName = useCallback((modelId: string | null | undefined): string | undefined => {
    if (!modelId) return undefined;
    const model = models.find(m => m.id === modelId);
    return model?.model_name;
  }, [models]);

  
  const slotLabel = useCallback((slot: DefaultModelSlot): string => {
    switch (slot) {
      case 'primary':
        return t('core.primary.label');
      case 'fast':
        return t('core.fast.label');
      case 'image_understanding':
        return t('optional.capabilities.image_understanding.label');
      case 'speech_recognition':
        return t('optional.capabilities.speech_recognition.label');
      default: {
        const exhaustive: never = slot;
        return exhaustive;
      }
    }
  }, [t]);

  const handleDefaultModelChange = async (slot: DefaultModelSlot, modelId: string | number) => {
    if (controlsDisabled) return;
    const scope = getActiveSurfaceScope();
    const modelIdStr = modelId ? String(modelId) : null;
    try {
      const updatedDefaults = await configManager.updateConfig<DefaultModelsConfig>(
        'ai.default_models',
        current => ({ ...current, [slot]: modelIdStr }),
      );
      if (!scope.isCurrent()) return;
      onDefaultModelsChange(updatedDefaults);

      const modelName = getModelName(modelIdStr);
      let successMessage: string;
      if (modelIdStr) {
        successMessage = t('messages.modelUpdated', {
          slot: slotLabel(slot),
          name: modelName || modelIdStr,
        });
      } else if (slot === 'fast') {
        successMessage = t('messages.fastModelCleared');
      } else {
        successMessage = t('messages.modelCleared', { slot: slotLabel(slot) });
      }
      notificationService.success(
        successMessage,
        { duration: 2000 }
      );
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to update default model', { slot, modelId: modelIdStr, error });
      notificationService.error(t('messages.updateFailed'));
    }
  };

  
  // Keep the primary/fast slots aligned with the ChatInput selector: enabled
  // non-chat models must never become a text-generation default by accident.
  const enabledModels = filterSelectableTextChatModels(models);
  const imageUnderstandingModels = models.filter(model => (
    isSelectableModelForCapability(model, 'image_understanding')
  ));
  const speechRecognitionModels = models.filter(model => (
    isSelectableModelForCapability(model, 'speech_recognition')
  ));

  return (
    <div className={`default-model-config${compact ? ' default-model-config--compact' : ''}`} data-openbitfun-component="default-model-config" data-openbitfun-part="root" aria-busy={loading}>
      <ConfigPageRow
        label={renderSlotLabel(t('core.primary.label'), t('core.primary.description'))}
        required
        multiline={compact}
        align="center"
      >
        <Combobox
          aria-required="true"
          aria-label={t('core.primary.label')}
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="primaryModel"
          value={defaultModels.primary || ''}
          onValueChange={(value) => handleDefaultModelChange('primary', normalizeSelectValue(value))}
          placeholder={pendingPlaceholder ?? t('core.primary.placeholder')}
          options={enabledModels.map(buildModelOption)}
          disabled={controlsDisabled || enabledModels.length === 0}
          size="sm"
        />
      </ConfigPageRow>

      <ConfigPageRow
        label={renderSlotLabel(t('core.fast.label'), t('core.fast.description'))}
        multiline={compact}
        align="center"
      >
        <Combobox
          aria-label={t('core.fast.label')}
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="lightweightModel"
          value={defaultModels.fast || ''}
          onValueChange={(value) => handleDefaultModelChange('fast', normalizeSelectValue(value))}
          placeholder={pendingPlaceholder ?? t('core.fast.placeholder')}
          disabled={controlsDisabled}
          options={[
            { label: t('core.fast.notSet'), value: '' },
            ...enabledModels.map(buildModelOption),
          ]}
          size="sm"
        />
      </ConfigPageRow>

      <ConfigPageRow
        label={renderSlotLabel(
          t('optional.capabilities.image_understanding.label'),
          t('optional.capabilities.image_understanding.description'),
        )}
        multiline={compact}
        align="center"
      >
        <Combobox
          aria-label={t('optional.capabilities.image_understanding.label')}
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="embeddingModel"
          value={defaultModels.image_understanding || ''}
          onValueChange={(value) => handleDefaultModelChange('image_understanding', normalizeSelectValue(value))}
          placeholder={pendingPlaceholder ?? t('optional.selectModel')}
          disabled={controlsDisabled}
          options={[
            { label: t('optional.notSet'), value: '' },
            ...imageUnderstandingModels.map(buildModelOption),
          ]}
          size="sm"
        />
      </ConfigPageRow>

      <ConfigPageRow
        label={renderSlotLabel(
          t('optional.capabilities.speech_recognition.label'),
          t('optional.capabilities.speech_recognition.description'),
        )}
        multiline={compact}
        align="center"
      >
        <Combobox
          aria-label={t('optional.capabilities.speech_recognition.label')}
          value={defaultModels.speech_recognition || ''}
          onValueChange={(value) => handleDefaultModelChange('speech_recognition', normalizeSelectValue(value))}
          placeholder={pendingPlaceholder ?? t('optional.notSet')}
          options={[
            { label: t('optional.notSet'), value: '' },
            ...speechRecognitionModels.map(buildModelOption),
          ]}
          className="default-model-config__model-select"
          disabled={controlsDisabled || speechRecognitionModels.length === 0}
          size="sm"
        />
      </ConfigPageRow>
    </div>
  );
};

export default DefaultModelConfig;
