import { InvalidationSync } from '../../../shared/relay-transport/InvalidationSync';
import type { RelayFailureAction } from '../../../shared/relay-transport/RelayFailure';
import { DeviceSystemMark } from '../components/DeviceSystemMark';
import { deviceFailurePresentation } from '../services/deviceFailureCopy';
import {
  ChevronLeft as LucideChevronLeft,
  Monitor as LucideMonitor,
  Pencil as LucidePencil,
  RefreshCw as LucideRefreshCw,
  UserRoundSearch as LucideUserRoundSearch,
} from 'lucide-react';
/**
 * Devices Page — list same-account devices and pick the control target.
 *
 * The mobile stays a limited companion surface: switching only retargets
 * RelayHttpClient.targetDeviceId (device RPC data plane) and resets the
 * per-device UI state. Workspace/Session/Chat then talk to the new peer
 * through the same limited command set.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  MobileBadge,
  MobileBanner,
  MobileButton,
  MobileCard,
  MobileIconButton,
  MobileListRow,
  MobilePageHeader,
  MobileStatus,
  MobileTextField,
} from '@openbitfun/ui/mobile';
import {
  RelayHttpClient,
  deviceDisplayName,
  isAccountIdentityChangedError,
  type RelayDeviceInfo,
} from '../services/RelayHttpClient';
import { useI18n } from '../i18n';
import { useMobileStore } from '../services/store';
import { selectAccountDevice, isDeviceControllable } from '../services/accountDeviceSelection';

type DeviceInfo = RelayDeviceInfo;


interface Props {
  client: RelayHttpClient;
  onBack: () => void;
  onDeviceSelected?: () => void;
  accountLanding?: boolean;
  autoSelect?: boolean;
  onSignOut?: () => void;
  preferredDeviceId?: string;
}

const BackIcon = () => (
  <LucideChevronLeft width="20" height="20" stroke="currentColor" aria-hidden="true" />
);

const RefreshIcon = () => (
  <LucideRefreshCw width="16" height="16" stroke="currentColor" aria-hidden="true" />
);

const NoIdentityIcon = () => (
  <LucideUserRoundSearch width="40" height="40" stroke="currentColor" aria-hidden="true" />
);

const DevicesPage: React.FC<Props> = ({ client, onBack, onDeviceSelected = onBack, accountLanding = false, autoSelect = true, onSignOut, preferredDeviceId }) => {
  const { t, formatRelativeTime } = useI18n();
  const { connectionHealth, setControlTarget, resetForDeviceSwitch } = useMobileStore();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [identityReady, setIdentityReady] = useState(client.hasAccountIdentity);
  const [identityChecking, setIdentityChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; action: RelayFailureAction | null } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  // `unknown` means the relay has not answered yet and must never be rendered as
  // an unsupported relay: doing so flashed the notice on every page entry.
  const [aliasCapability, setAliasCapability] = useState<'unknown' | 'supported' | 'unsupported'>('unknown');
  const aliasSupported = aliasCapability === 'supported';
  const mountedRef = useRef(true);
  const identityRequestRef = useRef(0);
  const devicesRequestRef = useRef(0);
  const switchRequestRef = useRef(0);
  const automaticSelectionAttemptedRef = useRef(false);
  const sortedDevices = useMemo(() => {
    const listedDevices = devices.filter((device) => (
      device.device_id !== client.controllerDeviceId
    )).sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      const leftCurrent = left.device_id === client.targetDeviceId;
      const rightCurrent = right.device_id === client.targetDeviceId;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return deviceDisplayName(left).localeCompare(deviceDisplayName(right));
    });
    return listedDevices;
  }, [client, client.controllerDeviceId, client.targetDeviceId, connectionHealth, devices]);

  const describeFailure = useCallback((value: unknown, fallbackKey: string) => {
    const { key, action } = deviceFailurePresentation(
      value,
      fallbackKey,
      accountLanding ? 'pairing.accountSessionExpired' : 'devices.authorizationExpired',
    );
    // The raw transport detail (status, exception text) stays in the log only.
    console.warn('[DevicesPage] device request failed', value);
    return { message: t(key), action };
  }, [accountLanding, t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      identityRequestRef.current += 1;
      devicesRequestRef.current += 1;
      switchRequestRef.current += 1;
    };
  }, []);

  const readDevices = useCallback(async () => {
    if (!client.hasAccountIdentity) return;
    const requestId = ++devicesRequestRef.current;
    const isCurrent = () => (
      mountedRef.current
      && devicesRequestRef.current === requestId
    );
    try {
      const epoch = client.accountEpoch;
      void client.supportsDeviceAlias()
        .then(supported => {
          if (isCurrent() && client.accountEpoch === epoch) {
            setAliasCapability(supported ? 'supported' : 'unsupported');
          }
        })
        .catch(error => {
          // A failed capability read is not evidence that the relay lacks the
          // capability, so it keeps the previous answer. Relay reachability is
          // reported by the directory request itself.
          if (isCurrent()) console.warn('[DevicesPage] relay alias capability unavailable', error);
        });
      const list = await client.listDevices();
      if (!isCurrent()) return;
      setDevices(list);
      setDirectoryLoaded(true);
      setError(null);
      setIdentityReady(true);
    } catch (e: unknown) {
      if (!isCurrent()) return;
      // RelayHttpClient fences every response against its committed identity.
      // A concurrent account refresh therefore makes this request stale rather
      // than user-visible, while a successful 401 refresh + retry remains valid.
      if (isAccountIdentityChangedError(e)) return;
      const message = String((e as { message?: string })?.message || e);
      if (message.includes('Sign in with GitHub')) {
        setIdentityReady(false);
        setDevices([]);
      } else {
        setError(describeFailure(e, 'devices.loadFailed'));
      }
    }
  }, [client, describeFailure]);

  const directorySyncRef = useRef<InvalidationSync | null>(null);
  const refreshDevices = useCallback(() => directorySyncRef.current?.invalidate() ?? Promise.resolve(), []);
  useEffect(() => {
    let cancelled = false;
    const directorySync = new InvalidationSync(readDevices);
    directorySyncRef.current = directorySync;
    const refresh = () => { if (document.visibilityState === 'visible') void refreshDevices(); };
    const stopPresence = client.onDeviceDirectoryChanged(refresh);
    document.addEventListener('visibilitychange', refresh);
    setLoading(true);
    void refreshDevices().finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      directorySync.stop();
      if (directorySyncRef.current === directorySync) directorySyncRef.current = null;
      stopPresence();
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, readDevices, refreshDevices]);

  const handleManualRefresh = useCallback(async () => {
    if (loading || switchingId) return;

    setLoading(true);
    await refreshDevices();
    if (mountedRef.current) setLoading(false);
  }, [loading, refreshDevices, switchingId]);

  const updateAlias = useCallback(async (device: DeviceInfo) => {
    const epoch = client.accountEpoch;
    try {
      await client.updateDeviceAlias(device.device_id, aliasDraft.trim() || null);
      if (!mountedRef.current || client.accountEpoch !== epoch) return;
      setEditingId(null);
      await refreshDevices();
    } catch (e) {
      if (!mountedRef.current || client.accountEpoch !== epoch || isAccountIdentityChangedError(e)) return;
      setError(String(e).includes('unsupported')
        ? { message: t('devices.aliasUnsupported'), action: null }
        : describeFailure(e, 'devices.loadFailed'));
    }
  }, [aliasDraft, client, describeFailure, refreshDevices, t]);
  const selectDevice = useCallback(async (d: DeviceInfo, probe = true) => {
    // A confirmed-incompatible device is shown but never a control target.
    if (!d.online || !isDeviceControllable(d) || switchingId) return;
    if (client.targetDeviceId === d.device_id) return;
    const requestId = ++switchRequestRef.current;
    const accountEpoch = client.accountEpoch;
    let expectedTargetEpoch = client.controlTargetEpoch;
    const isCurrent = () => (
      mountedRef.current
      && switchRequestRef.current === requestId
      && client.accountEpoch === accountEpoch
      && client.controlTargetEpoch === expectedTargetEpoch
    );
    setSwitchingId(d.device_id);
    setError(null);
    try {
      // Keep the existing probe for explicit device switches. Initial account
      // selection historically needed only the directory's online flag; do not
      // impose a new peer-mode command requirement on older desktops.
      if (probe) {
        const ping = await client.sendDeviceRpc<{ resp?: string; ok?: boolean; error?: string }>(d.device_id, {
          cmd: 'host_invoke',
          command: 'peer_mode_ping',
          args: {},
        }, { retryable: true });
        if (!isCurrent()) return;
        if (ping.resp === 'host_invoke_result' && ping.ok === false) {
          throw new Error(ping.error || t('devices.switchFailed'));
        }
      }
      client.setTargetDeviceId(d.device_id);
      expectedTargetEpoch = client.controlTargetEpoch;
      resetForDeviceSwitch();
      setControlTarget({
        deviceId: d.device_id,
        deviceName: client.resolveDeviceName(d.device_id, deviceDisplayName(d)),
      });
      onDeviceSelected();
    } catch (e: unknown) {
      if (!isCurrent()) return;
      if (isAccountIdentityChangedError(e)) return;
      const message = String((e as { message?: string })?.message || e);
      if (message.includes('Sign in with GitHub')) {
        setIdentityReady(false);
        setDevices([]);
      } else {
        setError(describeFailure(e, 'devices.switchFailed'));
      }
    } finally {
      if (mountedRef.current && switchRequestRef.current === requestId) {
        setSwitchingId(null);
      }
    }
  }, [client, describeFailure, onDeviceSelected, resetForDeviceSwitch, setControlTarget, switchingId, t]);

  // Keep the online/scanned-device shortcut after account UI entry, without
  // making discovery failures undo authentication or retry in a render loop.
  useEffect(() => {
    if (!accountLanding || !autoSelect || !identityReady || identityChecking || loading
      || switchingId || automaticSelectionAttemptedRef.current) return;
    const target = selectAccountDevice(devices, client.controllerDeviceId, preferredDeviceId);
    if (!target) return;
    automaticSelectionAttemptedRef.current = true;
    void selectDevice(target, false);
  }, [accountLanding, autoSelect, client, devices, identityChecking, identityReady, loading, preferredDeviceId, selectDevice, switchingId]);

  const renderDeviceList = () => (
      <div className="devices-page__list">
        {sortedDevices.map((d) => {
          const isCurrent = client.targetDeviceId === d.device_id;
          const isSwitching = switchingId === d.device_id;
          const controllable = isDeviceControllable(d);
          const clickable = d.online && controllable && !isCurrent && !switchingId;
          return (
            <div key={d.device_id}>
            {/* Renaming replaces the row in place: keeping the row and an editor
                under it shows the same device name twice. */}
            {editingId === d.device_id ? (
              <div className="devices-page__alias-editor">
                <MobileTextField
                  autoFocus
                  appearance="surface"
                  value={aliasDraft}
                  onChange={e => setAliasDraft(e.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); void updateAlias(d); }
                    if (event.key === 'Escape') { event.preventDefault(); setEditingId(null); }
                  }}
                  placeholder={t('devices.aliasPlaceholder')}
                  aria-label={t('devices.alias')}
                />
                <div className="devices-page__alias-actions">
                  <MobileButton size="sm" appearance="primary" onClick={() => void updateAlias(d)}>{t('devices.saveAlias')}</MobileButton>
                  <MobileButton size="sm" onClick={() => setEditingId(null)}>{t('common.cancel')}</MobileButton>
                </div>
              </div>
            ) : (
              <div className="devices-page__device-line">
              <MobileListRow
                appearance="surface"
                className={[
                  'devices-page__device',
                  d.online ? 'is-online' : 'is-offline',
                  isCurrent ? 'is-current' : '',
                  isSwitching ? 'is-switching' : '',
                ].filter(Boolean).join(' ')}
                disabled={!clickable}
                onClick={() => clickable && selectDevice(d)}
                leading={(
                  <span className="devices-page__device-icon">
                    <DeviceSystemMark deviceKind={d.device_kind} os={d.device_os} size={20} />
                  </span>
                )}
                label={(
                  <span className="devices-page__device-name-row">
                    <span className="devices-page__device-name">
                      {deviceDisplayName(d) || t('devices.unknownDevice')}
                    </span>
                    {d.device_model || d.device_os ? <small>{[d.device_model, d.device_os, d.device_os_version].filter(Boolean).join(' · ')}</small> : null}
                    {isCurrent && (
                      <MobileBadge className="devices-page__badge devices-page__badge--current" tone="success">
                        {t('devices.current')}
                      </MobileBadge>
                    )}
                    {!controllable && (
                      <MobileBadge className="devices-page__badge" tone="warning">
                        {t('devices.clientIncompatible')}
                      </MobileBadge>
                    )}

                  </span>
                )}
                supportingText={(
                  <span className="devices-page__device-meta">
                    <span className={`devices-page__status-dot ${d.online ? 'is-online' : 'is-offline'}`} />
                    {d.online
                      ? t('devices.online')
                      : d.last_seen_at
                        ? t('devices.lastSeen', { time: formatRelativeTime(d.last_seen_at * 1000) })
                        : t('devices.offline')}
                  </span>
                )}

                selected={isCurrent}
              />
              {/* Renaming is an action on the row, so it sits on the row's own line
                  instead of a block under it: one line per device at every width. */}
              <MobileIconButton
                appearance="plain"
                className="devices-page__device-edit"
                disabled={!aliasSupported}
                icon={<LucidePencil width="18" height="18" stroke="currentColor" aria-hidden="true" />}
                aria-label={t('devices.editAlias')}
                title={t('devices.editAlias')}
                onClick={() => { setEditingId(d.device_id); setAliasDraft(d.device_alias ?? ''); }}
              />
              </div>
            )}
            </div>
          );
        })}
      </div>
  );

  const renderBody = () => {
    if (identityChecking) {
      return (
        <>
          {sortedDevices.length > 0 && renderDeviceList()}
          <MobileStatus className="devices-page__loading" loading title={t('devices.loading')} />
        </>
      );
    }

    if (!identityReady) {
      return (
        <>
          {sortedDevices.length > 0 && renderDeviceList()}
          <MobileCard appearance="elevated" className="devices-page__empty-card">
            <MobileStatus
              action={<MobileButton className="devices-page__retry-btn" onClick={handleManualRefresh}>{t('devices.retry')}</MobileButton>}
              description={t('devices.authorizationExpired')}
              icon={<NoIdentityIcon />}
            />
          </MobileCard>
        </>
      );
    }

    if (loading && !directoryLoaded && sortedDevices.length === 0) {
      return (
        <MobileStatus className="devices-page__loading" loading title={t('devices.loading')} />
      );
    }

    if (sortedDevices.length === 0) {
      // A failed directory request is not evidence that the account is empty.
      if (error) return null;
      return <section className="devices-page__onboarding" aria-labelledby="devices-empty-title">
        <div className="devices-page__onboarding-icon"><LucideMonitor size={28} aria-hidden="true" /></div>
        <h2 id="devices-empty-title">{t('devices.emptyTitle')}</h2>
        <p className="devices-page__onboarding-intro">{t('devices.emptyDescription')}</p>
        <ol className="devices-page__steps">
          <li><span aria-hidden="true">1</span><div><strong>{t('devices.emptyStepOne')}</strong><p>{t('devices.emptyStepOneDetail')}</p></div></li>
          <li><span aria-hidden="true">2</span><div><strong>{t('devices.emptyStepTwo')}</strong><p>{t('devices.emptyStepTwoDetail')}</p></div></li>
        </ol>
        <MobileButton appearance="secondary" block leading={<RefreshIcon />} loading={loading} onClick={handleManualRefresh}>{t('devices.refresh')}</MobileButton>
        <p className="devices-page__onboarding-note">{t('devices.emptyAutoRefresh')}</p>
      </section>;
    }

    return renderDeviceList();
  };

  return (
    <div className={`devices-page${identityReady && directoryLoaded && sortedDevices.length === 0 && !error ? ' devices-page--empty' : ''}`}>
      <MobilePageHeader
        className={`devices-page__header${accountLanding ? ' devices-page__header--account' : ''}`}
        leading={accountLanding ? undefined : <MobileIconButton
          appearance="floating"
          className="devices-page__back-btn"
          icon={<BackIcon />}
          onClick={onBack}
          aria-label={t('common.back')}
        />}
        title={t('devices.title')}
        actions={<>
          {(accountLanding || onSignOut) && <MobileButton appearance="plain" size="sm" onClick={accountLanding ? onBack : onSignOut}>{t('devices.signOut')}</MobileButton>}
          {(sortedDevices.length > 0 || error || !identityReady) && <MobileIconButton
          appearance="plain"
          className="devices-page__refresh-btn"
          icon={<RefreshIcon />}
          loading={loading || identityChecking}
          onClick={handleManualRefresh}
          disabled={!!switchingId}
          aria-label={t('devices.refresh')}
          title={t('devices.refresh')}
        />}</>}
      />

      {accountLanding && sortedDevices.length > 0 && <p className="devices-page__description">{t('devices.accountReady')}</p>}
      {error && (
        <MobileBanner
          className="devices-page__error"
          tone="danger"
          action={(error.action === 'retry' || error.action === 'check-updates') ? (
            // Mobile web cannot self-update: for an outdated build or a retired
            // relay the sentence carries the instruction and this re-reads the
            // directory instead of pretending the app was updated.
            <MobileButton
              className="devices-page__error-action"
              appearance="plain"
              size="sm"
              loading={loading || !!switchingId}
              onClick={handleManualRefresh}
            >
              {t(error.action === 'check-updates' ? 'devices.refresh' : 'devices.retry')}
            </MobileButton>
          ) : undefined}
        >
          {error.message}
        </MobileBanner>
      )}

      {aliasCapability === 'unsupported' && <MobileBanner>{t('devices.aliasUnsupported')}</MobileBanner>}
      <div className="devices-page__body">
        {renderBody()}
      </div>
    </div>
  );
};

export default DevicesPage;
