import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { Combobox, Icon, IconButton, Spinner, Tooltip } from '@openbitfun/ui';
import { notificationService } from '@/shared/notification-system';
import { configManager } from '../services/ConfigManager';
import type {
  AIModelConfig,
  DefaultModels,
} from '../types';
import { ConfigEmptyState, ConfigPageRow } from './common';
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

export const DefaultModelConfig: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useTranslation('settings/default-model');
  const { buildModelOption } = useModelSelectPresentation();
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
  
  
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [defaultModels, setDefaultModels] = useState<DefaultModels>({
    primary: null,
    fast: null,
    image_understanding: null,
    speech_recognition: null,
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      const [allModels, defaultModelsConfig] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<any>('ai.default_models') || {},
      ]);

      setModels(allModels);

      setDefaultModels({
        primary: defaultModelsConfig?.primary || null,
        fast: defaultModelsConfig?.fast || null,
        image_understanding: defaultModelsConfig?.image_understanding || null,
        speech_recognition: defaultModelsConfig?.speech_recognition || null,
      });
    } catch (error) {
      log.error('Failed to load data', error);
      notificationService.error(t('messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadData();

    const unsubscribeModels = configManager.watch('ai.models', () => {
      void loadData();
    });
    const unsubscribeDefaultModels = configManager.watch('ai.default_models', () => {
      void loadData();
    });

    return () => {
      unsubscribeModels();
      unsubscribeDefaultModels();
    };
  }, [loadData]);

  
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
    const modelIdStr = modelId ? String(modelId) : null;
    try {
      const currentConfig = await configManager.getConfig<any>('ai.default_models') || {};

      
      await configManager.setConfig('ai.default_models', {
        ...currentConfig,
        [slot]: modelIdStr,
      });

      setDefaultModels(prev => ({
        ...prev,
        [slot]: modelIdStr,
      }));

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

  if (loading) {
    return (
      <div className="default-model-config__loading" data-openbitfun-component="default-model-config" data-openbitfun-part="loading" data-openbitfun-state="loading">
        <Spinner size="sm" />
        <p>{t('loading')}</p>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <ConfigEmptyState
        data-openbitfun-component="default-model-config"
        data-openbitfun-part="empty"
        data-openbitfun-state="empty"
        icon={<Layers aria-hidden="true" />}
        description={t('empty.noModels')}
      />
    );
  }

  return (
    <div className={`default-model-config${compact ? ' default-model-config--compact' : ''}`} data-openbitfun-component="default-model-config" data-openbitfun-part="root">
      <ConfigPageRow
        label={renderSlotLabel(t('core.primary.label'), t('core.primary.description'))}
        required
        multiline={compact}
        align="center"
      >
        <Combobox
          aria-required="true"
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="primaryModel"
          value={defaultModels.primary || ''}
          onValueChange={(value) => handleDefaultModelChange('primary', normalizeSelectValue(value))}
          placeholder={t('core.primary.placeholder')}
          options={enabledModels.map(buildModelOption)}
          disabled={enabledModels.length === 0}
          size="sm"
        />
      </ConfigPageRow>

      <ConfigPageRow
        label={renderSlotLabel(t('core.fast.label'), t('core.fast.description'))}
        multiline={compact}
        align="center"
      >
        <Combobox
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="lightweightModel"
          value={defaultModels.fast || ''}
          onValueChange={(value) => handleDefaultModelChange('fast', normalizeSelectValue(value))}
          placeholder={t('core.fast.placeholder')}
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
          data-openbitfun-component="default-model-config"
          data-openbitfun-part="embeddingModel"
          value={defaultModels.image_understanding || ''}
          onValueChange={(value) => handleDefaultModelChange('image_understanding', normalizeSelectValue(value))}
          placeholder={t('optional.selectModel')}
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
          value={defaultModels.speech_recognition || ''}
          onValueChange={(value) => handleDefaultModelChange('speech_recognition', normalizeSelectValue(value))}
          placeholder={t('optional.notSet')}
          options={[
            { label: t('optional.notSet'), value: '' },
            ...speechRecognitionModels.map(buildModelOption),
          ]}
          className="default-model-config__model-select"
          disabled={speechRecognitionModels.length === 0}
          size="sm"
        />
      </ConfigPageRow>
    </div>
  );
};

export default DefaultModelConfig;
