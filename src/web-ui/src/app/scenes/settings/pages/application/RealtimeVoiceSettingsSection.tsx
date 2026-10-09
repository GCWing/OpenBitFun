import { speechAPI, type SpeechRealtimeConfig } from '@/infrastructure/api';
import { ConfigLoadingState, ConfigMessage, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Input, Switch } from '@openbitfun/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('RealtimeVoiceSettingsSection');

export default function RealtimeVoiceSettingsSection() {
  const { t } = useTranslation('settings/voice-input');
  const speechRuntimeSupported = isTauriRuntime();
  const [voiceCallDraft, setVoiceCallDraft] = useState<SpeechRealtimeConfig | null>(null);
  const voiceCallConfigRef = useRef<SpeechRealtimeConfig | null>(null);
  const persistedVoiceCallConfigRef = useRef<SpeechRealtimeConfig | null>(null);
  const [voiceCallLoading, setVoiceCallLoading] = useState(speechRuntimeSupported);
  const [voiceCallLoadFailed, setVoiceCallLoadFailed] = useState(false);
  const [voiceCallSaveError, setVoiceCallSaveError] = useState<string | null>(null);
  const voiceCallRequestIdRef = useRef(0);
  const voiceCallSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const voiceCallSaveRevisionRef = useRef(0);
  const loadVoiceCallConfig = useCallback(async () => {
    if (!speechRuntimeSupported) {
      setVoiceCallLoading(false);
      return;
    }
    const requestId = ++voiceCallRequestIdRef.current;
    setVoiceCallLoading(true);
    setVoiceCallLoadFailed(false);
    try {
      const config = await speechAPI.getRealtimeConfig();
      if (requestId !== voiceCallRequestIdRef.current) return;
      setVoiceCallDraft(config);
      voiceCallConfigRef.current = config;
      persistedVoiceCallConfigRef.current = config;
      setVoiceCallSaveError(null);
    } catch (error) {
      if (requestId !== voiceCallRequestIdRef.current) return;
      log.error('Failed to load controller realtime voice call settings', { error });
      setVoiceCallDraft(null);
      voiceCallConfigRef.current = null;
      persistedVoiceCallConfigRef.current = null;
      setVoiceCallLoadFailed(true);
    } finally {
      if (requestId === voiceCallRequestIdRef.current) {
        setVoiceCallLoading(false);
      }
    }
  }, [speechRuntimeSupported]);

  useEffect(() => {
    void loadVoiceCallConfig();
    return () => {
      voiceCallRequestIdRef.current += 1;
    };
  }, [loadVoiceCallConfig]);

  const updateVoiceCall = useCallback((patch: Partial<SpeechRealtimeConfig>) => {
    if (!voiceCallConfigRef.current) return;
    const next = { ...voiceCallConfigRef.current, ...patch };
    const valid = next.voice.trim() && (!next.enabled || next.apiKey.trim());
    // Enabling requires credentials, but they remain editable while disabled.
    if (patch.enabled === true && !valid) {
      setVoiceCallSaveError(t('voiceCall.messages.required'));
      return;
    }
    const revision = ++voiceCallSaveRevisionRef.current;
    voiceCallConfigRef.current = next;
    setVoiceCallDraft(next);
    if (!valid) {
      setVoiceCallSaveError(t('voiceCall.messages.required'));
      return;
    }
    setVoiceCallSaveError(null);
    // Serialize writes and only reconcile the latest edit with the response.
    // The queue also finishes if the user leaves the settings page.
    const operation = voiceCallSaveQueueRef.current.then(async () => {
      try {
        const saved = await speechAPI.saveRealtimeConfig({
          enabled: next.enabled,
          apiKey: next.apiKey.trim(),
          voice: next.voice.trim(),
          speed: next.speed,
          loudness: next.loudness,
          microphoneDeviceId: next.microphoneDeviceId,
        });
        persistedVoiceCallConfigRef.current = saved;
        if (revision === voiceCallSaveRevisionRef.current) {
          voiceCallConfigRef.current = saved;
          setVoiceCallDraft(saved);
          setVoiceCallSaveError(null);
        }
        window.dispatchEvent(new CustomEvent('openbitfun:realtime-voice-config-changed', {
          detail: saved,
        }));
      } catch (error) {
        log.error('Failed to save realtime voice call settings', { error });
        if (revision === voiceCallSaveRevisionRef.current) {
          voiceCallConfigRef.current = persistedVoiceCallConfigRef.current;
          setVoiceCallDraft(persistedVoiceCallConfigRef.current);
          setVoiceCallSaveError(t('voiceCall.messages.saveFailed'));
          notificationService.error(t('voiceCall.messages.saveFailed'));
        }
      }
    });
    voiceCallSaveQueueRef.current = operation.then(() => undefined, () => undefined);
  }, [t]);

  const sectionAnchor = useSettingsSectionAnchor('voice-call', !voiceCallLoading);
  return (
    <ConfigPageSection id={sectionAnchor}
      title={t('voiceCall.title')}
      description={t('voiceCall.description')}
    >
      {!speechRuntimeSupported ? <ConfigMessage message={{ type: 'info', text: t('voiceCall.messages.unsupported') }} /> : voiceCallLoading ? (
        <ConfigLoadingState label={t('voiceCall.loading')} />
      ) : voiceCallLoadFailed || !voiceCallDraft ? (
        <ConfigRetryState
          message={t('voiceCall.messages.loadFailed')}
          retryLabel={t('messages.retry')}
          onRetry={() => void loadVoiceCallConfig()}
          loading={voiceCallLoading}
        />
      ) : (
        <>
          <ConfigPageRow
            label={t('voiceCall.enabled.label')}
            description={t('voiceCall.enabled.description')}
            align="center"
          >
            <Switch
              checked={voiceCallDraft.enabled}
              onChange={(event) => updateVoiceCall({ enabled: event.target.checked })}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('voiceCall.apiKey.label')}
            description={t('voiceCall.apiKey.description')}
            align="center"
          >
            <Input
              type="password"
              size="sm"
              autoComplete="off"
              value={voiceCallDraft.apiKey}
              placeholder={t('voiceCall.apiKey.placeholder')}
              onChange={(event) => updateVoiceCall({ apiKey: event.target.value })}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('voiceCall.voice.label')}
            description={t('voiceCall.voice.description')}
            align="center"
          >
            <Input
              size="sm"
              value={voiceCallDraft.voice}
              onChange={(event) => updateVoiceCall({ voice: event.target.value })}
            />
          </ConfigPageRow>
          <ConfigMessage
            message={voiceCallSaveError ? { type: 'error', text: voiceCallSaveError } : null}
          />
        </>
      )}
    </ConfigPageSection>
  );
}
