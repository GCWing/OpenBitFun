import { HARNESS_IDS, canonicalHarnessId } from '@/shared/agents/identity';
import { Select, type SelectOption } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  chatInputModePreferenceService,
  withChatInputDefaultModeStrategy,
  withFixedChatInputDefaultMode,
  type ChatInputDefaultModeStrategy,
  type ChatInputModePreference,
} from '@/flow_chat/services/ChatInputModePreferenceService';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('DefaultHarnessSection');

function selectValue(value: string | number | (string | number)[]): string {
  return String(Array.isArray(value) ? value[0] ?? '' : value);
}

export function DefaultHarnessSection(): React.ReactElement {
  const { t } = useTranslation('settings/runtime');
  const { t: tFlowChat } = useTranslation('flow-chat');
  const [preference, setPreference] = useState<ChatInputModePreference | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const loadPreference = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const nextPreference = await chatInputModePreferenceService.getPreference();
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setPreference(nextPreference);
      }
    } catch (error) {
      log.error('Failed to load default Harness preference', error);
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoadFailed(true);
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadPreference();
    const unsubscribe = chatInputModePreferenceService.subscribe(
      nextPreference => {
        if (!mountedRef.current) return;
        loadGenerationRef.current += 1;
        setPreference(nextPreference);
        setLoadFailed(false);
        setLoading(false);
      },
      error => {
        if (!mountedRef.current) return;
        loadGenerationRef.current += 1;
        log.error('Failed to refresh default Harness preference', error);
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      unsubscribe();
    };
  }, [loadPreference]);

  const labelForMode = useCallback((modeId: string | null | undefined): string => {
    const profile = canonicalHarnessId(modeId);
    return profile
      ? tFlowChat(`chatInput.harness.profiles.${profile}.name`)
      : modeId?.trim() || tFlowChat('chatInput.harness.profiles.Standard.name');
  }, [tFlowChat]);

  const fixedModeOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = HARNESS_IDS.map(id => ({ value: id, label: labelForMode(id) }));
    const configuredModeId = preference?.fixedModeId;
    if (configuredModeId && !options.some(option => option.value === configuredModeId)) {
      options.push({
        value: configuredModeId,
        label: t('defaultHarness.compatibilityMode', { id: configuredModeId }),
      });
    }
    return options;
  }, [labelForMode, preference?.fixedModeId, t]);

  const savePreference = async (
    optimistic: ChatInputModePreference,
    persist: () => Promise<ChatInputModePreference>,
  ) => {
    if (!preference || saving) return;
    const previous = preference;
    setPreference(optimistic);
    setSaving(true);
    try {
      setPreference(await persist());
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save default Harness preference', error);
      setPreference(previous);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleStrategyChange = (value: string | number | (string | number)[]) => {
    if (!preference) return;
    const strategy: ChatInputDefaultModeStrategy =
      selectValue(value) === 'fixed' ? 'fixed' : 'follow_last';
    if (strategy === preference.strategy) return;
    void savePreference(
      withChatInputDefaultModeStrategy(preference, strategy),
      () => chatInputModePreferenceService.setStrategy(strategy),
    );
  };

  const handleFixedModeChange = (value: string | number | (string | number)[]) => {
    if (!preference) return;
    const modeId = selectValue(value);
    if (modeId === preference.fixedModeId) return;
    void savePreference(
      withFixedChatInputDefaultMode(preference, modeId),
      () => chatInputModePreferenceService.setFixedMode(modeId),
    );
  };

  let content: React.ReactNode;
  if (loading) {
    content = <ConfigLoadingState label={t('loading.text')} />;
  } else if (loadFailed || !preference) {
    content = (
      <ConfigRetryState
        message={t('defaultHarness.loadFailed')}
        retryLabel={t('loading.retry')}
        onRetry={() => void loadPreference()}
      />
    );
  } else {
    const followLastDescription = preference.lastModeId
      ? t('defaultHarness.followLastDescription', {
        name: labelForMode(preference.lastModeId),
      })
      : t('defaultHarness.followLastEmptyDescription', {
        name: labelForMode('Standard'),
      });
    content = (
      <>
        <ConfigPageRow
          label={t('defaultHarness.strategy')}
          description={preference.strategy === 'follow_last'
            ? followLastDescription
            : t('defaultHarness.fixedDescription')}
          align="center"
        >
          <div
            className="openbitfun-runtime-settings__row-control"
            data-testid="default-harness-strategy"
          >
            <Select
              size="sm"
              value={preference.strategy}
              options={[
                { value: 'follow_last', label: t('defaultHarness.followLast') },
                { value: 'fixed', label: t('defaultHarness.fixed') },
              ]}
              disabled={saving}
              onValueChange={handleStrategyChange}
            />
          </div>
        </ConfigPageRow>

        {preference.strategy === 'fixed' ? (
          <ConfigPageRow
            label={t('defaultHarness.fixedMode')}
            align="center"
          >
            <div
              className="openbitfun-runtime-settings__row-control"
              data-testid="default-harness-fixed-mode"
            >
              <Select
                size="sm"
                value={preference.fixedModeId ?? 'Standard'}
                options={fixedModeOptions}
                disabled={saving}
                onValueChange={handleFixedModeChange}
              />
            </div>
          </ConfigPageRow>
        ) : null}
      </>
    );
  }

  return (
    <ConfigPageSection
      title={t('defaultHarness.title')}
      description={t('defaultHarness.description')}
    >
      {content}
    </ConfigPageSection>
  );
}

export default DefaultHarnessSection;
