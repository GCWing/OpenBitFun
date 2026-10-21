import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Select } from '@openbitfun/ui';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { LocalContextTruncation } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('LocalContextTruncationSection');
const configPath = 'ai.local_context_truncation';

export default function LocalContextTruncationSection() {
  const { t } = useI18n('settings/models');
  const notification = useNotification();
  const peerDevice = usePeerDeviceModeOptional();
  const supported = !peerDevice?.peerMode.active
    || peerDevice.currentPeerCapabilities?.localContextTruncationV1 === true;
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [policy, setPolicy] = useState<LocalContextTruncation>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoadFailed(false);
    try {
      const configured = await configManager.getOptionalConfig<LocalContextTruncation>(configPath);
      if (!scope.isCurrent() || request !== requestId.current) return;
      setPolicy(configured ?? 'explicit_only');
    } catch (error) {
      if (!scope.isCurrent() || request !== requestId.current) return;
      log.error('Failed to load local context truncation setting', error);
      setLoadFailed(true);
    } finally {
      if (scope.isCurrent() && request === requestId.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setSaving(false);
    setLoadFailed(false);
    if (!supported) {
      setPolicy(undefined);
      setLoading(false);
      return;
    }
    if (configManager.hasCachedConfig(configPath)) {
      setPolicy(configManager.getCachedConfig<LocalContextTruncation>(configPath) ?? 'explicit_only');
      setLoading(false);
    } else {
      setPolicy(undefined);
      setLoading(true);
      void load();
    }
    return configManager.watch(configPath, () => { void load(); });
  }, [load, scope, supported]);

  const save = async (value: string) => {
    if (!supported || saving || policy === undefined || value === policy) return;
    if (value !== 'explicit_only' && value !== 'on_context_overflow' && value !== 'always') return;
    setSaving(true);
    try {
      await configManager.setConfig(configPath, value);
      if (!scope.isCurrent()) return;
      setPolicy(value);
      notification.success(t('localContextTruncation.saveSuccess'));
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to save local context truncation setting', error);
      notification.error(t('messages.saveFailed'));
    } finally {
      if (scope.isCurrent()) setSaving(false);
    }
  };

  return (
    <ConfigPageSection title={t('localContextTruncation.title')} description={t('localContextTruncation.description')}>
      {!supported ? <p>{t('localContextTruncation.unsupported')}</p> : loading ? <ConfigLoadingState label={t('messages.loading')} /> : loadFailed ? (
        <ConfigRetryState message={t('messages.loadFailedLocked')} retryLabel={t('messages.retry')} onRetry={() => void load()} />
      ) : (
        <ConfigPageRow label={t('localContextTruncation.label')} description={t('localContextTruncation.hint')} align="center">
          <Select
            size="sm"
            aria-label={t('localContextTruncation.label')}
            value={policy ?? 'explicit_only'}
            onValueChange={value => void save(String(value))}
            disabled={saving || policy === undefined}
            options={[
              { value: 'explicit_only', label: t('localContextTruncation.explicitOnly') },
              { value: 'on_context_overflow', label: t('localContextTruncation.onContextOverflow') },
              { value: 'always', label: t('localContextTruncation.always') },
            ]}
          />
        </ConfigPageRow>
      )}
    </ConfigPageSection>
  );
}
