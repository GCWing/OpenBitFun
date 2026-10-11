import { refreshDeviceDirectory, isDeviceControllable, deviceClientVersion } from '@/infrastructure/account/deviceDirectory';
/** Account login and authenticated device connections. */

import { OverflowText, Alert, Avatar, Button, Icon, IconButton, Input, ScrollArea, StatusPill } from '@openbitfun/ui';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  confirmDanger,
} from '@/infrastructure/confirm-dialog';
import { LogIn, LogOut, Pencil, Check, X } from 'lucide-react';
import { DeviceSystemGlyph } from '../NavPanel/components/DeviceSystemGlyph';
import { reportedHostKind } from '../NavPanel/deviceInterconnectionOverview';
import { remoteConnectAPI, deviceDisplayName, deviceMetadataLabel } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import type {
  AccountDeviceInfo,
  OnlineDeviceInfo,
} from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { accountIdentityService, useAccountIdentity } from '@/infrastructure/account-identity';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { usePeerDeviceMode } from '@/infrastructure/peer-device/peerDeviceContextState';
import {
  isAccountAuthFailure,
  isRelayUnreachable,
} from '@/infrastructure/account/accountErrorUtils';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { canCheckForAppUpdates } from '@/infrastructure/update/tauriEnv';
import { useUpdateInstallStore } from '@/infrastructure/update/updateInstallStore';
import {
  classifyRelayFailure,
  relayFailureAction,
  type RelayFailureAction,
  type RelayFailureKind,
} from '../../../../../shared/relay-transport/RelayFailure';
import { ensureAccountSession } from './ensureAccountSession';
import './AccountPanel.scss';

const log = createLogger('AccountPanel');

/** Banner sentence for each classified relay/account failure. HTTP status and
 * exception text never reach the surface; the raw detail stays in the log. */
const RELAY_FAILURE_MESSAGE_KEY: Record<RelayFailureKind, string> = {
  network: 'accountLogin.relayFailureNetwork',
  'relay-unavailable': 'accountLogin.relayFailureUnavailable',
  'relay-version-retired': 'accountLogin.relayFailureVersionRetired',
  'client-outdated': 'accountLogin.relayFailureClientOutdated',
  auth: 'accountLogin.sessionExpired',
  unknown: 'accountLogin.relayFailureUnknown',
};

/** A failure reduced to the banner sentence and the next step the user can take. */
interface PanelFailure {
  message: string;
  action: RelayFailureAction | null;
}

/**
 * Relay device-alias capability. `unknown` means the relay has not answered yet
 * and must never be rendered as an unsupported relay: doing so flashed the
 * unsupported notice on every panel entry until the capability read resolved.
 */
type DeviceAliasCapability = 'unknown' | 'supported' | 'unsupported';

/** Reduce an account/relay failure to user-facing copy via the shared classifier. */
function describeAccountFailure(error: unknown, t: (key: string) => string): PanelFailure {
  const kind = classifyRelayFailure(error);
  return { message: t(RELAY_FAILURE_MESSAGE_KEY[kind]), action: relayFailureAction(kind) };
}

const DEVICE_POLL_FALLBACK_MS = 30_000;
const DEVICE_CONNECT_MAX_ATTEMPTS = 5;
const DEVICE_CONNECT_RECOVERY_INTERVAL_MS = 30_000;
const DEVICE_LIST_FAILURE_THRESHOLD = 3;

async function connectDevicesWithRetry(
  isCurrent: () => boolean,
): Promise<OnlineDeviceInfo[]> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DEVICE_CONNECT_MAX_ATTEMPTS; attempt += 1) {
    if (!isCurrent()) {
      throw new Error('account context changed');
    }
    try {
      return await remoteConnectAPI.accountConnectDevices();
    } catch (error) {
      lastError = error;
      if (isAccountAuthFailure(error)
        || !isRelayUnreachable(error)
        || attempt === DEVICE_CONNECT_MAX_ATTEMPTS) {
        throw error;
      }
      const delayMs = 500 * (2 ** (attempt - 1));
      log.warn(
        `Device connection attempt ${attempt}/${DEVICE_CONNECT_MAX_ATTEMPTS} failed; retrying`,
        error,
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

interface AccountPanelProps {
  /** Close the whole Remote Connect dialog (used when entering peer mode). */
  onCloseDialog: () => void;
}

/**
 * Merge one presence entry into a known device. Absent keys mean "this relay
 * cannot report the field", so they must never erase metadata that came from
 * the authoritative directory snapshot.
 */
function mergePresenceDevice(device: AccountDeviceInfo, presence: OnlineDeviceInfo): AccountDeviceInfo {
  return {
    ...device,
    ...(presence.device_alias !== undefined ? { device_alias: presence.device_alias } : {}),
    ...(presence.device_model !== undefined ? { device_model: presence.device_model } : {}),
    ...(presence.device_os !== undefined ? { device_os: presence.device_os } : {}),
    ...(presence.device_os_version !== undefined ? { device_os_version: presence.device_os_version } : {}),
    ...(presence.device_client_version !== undefined ? { device_client_version: presence.device_client_version } : {}),
    ...(presence.client_version !== undefined ? { client_version: presence.client_version } : {}),
    ...(presence.device_client_protocol !== undefined ? { device_client_protocol: presence.device_client_protocol } : {}),
    ...(presence.client_protocol !== undefined ? { client_protocol: presence.client_protocol } : {}),
    ...(presence.compatible !== undefined ? { compatible: presence.compatible } : {}),
    device_name: presence.device_name || device.device_name,
    online: true,
  };
}

type View = 'login' | 'devices';

interface FailureBannerProps {
  failure: PanelFailure;
  t: (key: string) => string;
  busy: boolean;
  /** Present only where the banner can be dismissed. */
  onClose?: () => void;
  onAction: (action: RelayFailureAction) => void;
}

/**
 * The button a failure banner offers, if any. An update check only exists where
 * updates can be installed; elsewhere the banner stays a statement instead of
 * offering an action that cannot run.
 */
const failureBannerAction = (failure: PanelFailure): RelayFailureAction | null => (
  failure.action === 'retry' || (failure.action === 'check-updates' && canCheckForAppUpdates())
    ? failure.action
    : null
);

/**
 * Red banner plus the single next step for a classified failure. A failure whose
 * action is the existing sign-in flow renders no extra button.
 */
const FailureBanner: React.FC<FailureBannerProps> = ({ failure, t, busy, onClose, onAction }) => {
  const actionable = failureBannerAction(failure);
  return (
    <div className="account-panel__error-banner" data-openbitfun-component="remote-account-panel" data-openbitfun-part="error">
      <Alert
        tone="error"
        message={failure.message}
        {...(onClose ? { closable: true, onClose } : {})}
      />
      {actionable && (
        <Button
          variant="outline"
          size="sm"
          className="account-panel__error-action"
          onClick={() => onAction(actionable)}
          disabled={busy}
        >
          {actionable === 'check-updates' ? t('update.checkForUpdates') : t('accountLogin.retryConnect')}
        </Button>
      )}
    </div>
  );
};

export const AccountPanel: React.FC<AccountPanelProps> = ({
  onCloseDialog,
}) => {
  const { t, formatRelativeTime } = useI18n('common');
  const { success } = useNotification();
  const { peerMode, switchToDevice, switchToLocal } = usePeerDeviceMode();
  const identity = useAccountIdentity();
  const githubId = (identity.me?.user.accountId ?? identity.me?.user.githubId);
  const username = identity.me?.email ?? identity.me?.user.login ?? '';
  const [error, setError] = useState<PanelFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>('login');

  const [devices, setDevices] = useState<AccountDeviceInfo[]>([]);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [savingAliasId, setSavingAliasId] = useState<string | null>(null);
  const [aliasCapability, setAliasCapability] = useState<DeviceAliasCapability>('unknown');
  const aliasSupported = aliasCapability === 'supported';
  const refreshDirtyRef = useRef(false);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  // Device discovery updates presentation, not the account lifecycle. Keep
  // refresh callbacks stable so adopting an ID cannot restart initialization.
  const deviceInfoRequestRef = useRef(0);
  const localDeviceIdRef = useRef(localDeviceId);
  localDeviceIdRef.current = localDeviceId;
  /** True after either device presence or a list_devices response is available. */
  const [devicesReady, setDevicesReady] = useState(false);
  const [relayFailure, setRelayFailure] = useState<PanelFailure | null>(null);
  /** Update result the banner has to report itself; the update surface is shell-owned. */
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  /** Account epoch whose presence events may update the device list. */
  const [activeAccountEpoch, setActiveAccountEpoch] = useState<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Reject late responses after unmount or an account login/logout transition. */
  const mountedRef = useRef(false);
  const accountEpochRef = useRef(0);
  const refreshRequestRef = useRef(0);
  /** Allow at most one list_devices request per account epoch. */
  const refreshInFlightRef = useRef<{ epoch: number; requestId: number } | null>(null);
  /** A working device-routing WS is independent evidence that Relay is reachable. */
  const deviceRoutingReadyRef = useRef(false);
  const deviceListFailureCountRef = useRef(0);
  /** Coalesce manual and background recovery so they never replace each other's WS. */
  const deviceReconnectInFlightRef = useRef<number | null>(null);
  /**
   * Latest refresh for callers that must not depend on its identity: the
   * successor refresh scheduled below, the polling interval, and the presence
   * listener. Assigned right after `refreshDevices` is created.
   */
  const refreshDevicesRef = useRef<(() => Promise<void>) | null>(null);
  const invalidateAccountRequests = useCallback(() => {
    accountEpochRef.current += 1;
    refreshRequestRef.current += 1;
    refreshInFlightRef.current = null;
    deviceRoutingReadyRef.current = false;
    deviceListFailureCountRef.current = 0;
    setActiveAccountEpoch(null);
    return accountEpochRef.current;
  }, []);

  const isAccountEpochCurrent = useCallback((epoch: number) => (
    mountedRef.current && accountEpochRef.current === epoch
  ), []);

  const refreshLocalDeviceId = useCallback((epoch: number) => {
    const requestId = ++deviceInfoRequestRef.current;
    void remoteConnectAPI.getDeviceInfo().then(info => {
      if (isAccountEpochCurrent(epoch) && deviceInfoRequestRef.current === requestId) {
        setLocalDeviceId(info.device_id);
      }
    }).catch(error => { log.warn('getDeviceInfo failed', error); });
  }, [isAccountEpochCurrent]);

  const sortedDevices = useMemo(() => [...devices].sort((left, right) => {
    const leftLocal = left.device_id === localDeviceId;
    const rightLocal = right.device_id === localDeviceId;
    if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
    if (left.online !== right.online) return left.online ? -1 : 1;
    return deviceDisplayName(left).localeCompare(deviceDisplayName(right));
  }), [devices, localDeviceId]);

  const resetState = useCallback(() => {
    setActiveAccountEpoch(null);
    setDevices([]);
    setAliasCapability('unknown');
    refreshDirtyRef.current = false;
    setEditingDeviceId(null);
    setAliasDraft('');
    setSavingAliasId(null);
    setLocalDeviceId(null);
    setDevicesReady(false);
    setRelayFailure(null);
    setUpdateNotice(null);
    refreshInFlightRef.current = null;
    deviceRoutingReadyRef.current = false;
    deviceListFailureCountRef.current = 0;
    if (refreshTimer.current) { clearInterval(refreshTimer.current); refreshTimer.current = null; }
  }, []);

  const handleSessionExpired = useCallback(async (_error: unknown, expectedEpoch: number) => {
    if (!isAccountEpochCurrent(expectedEpoch)) return;
    const nextEpoch = invalidateAccountRequests();
    // Authenticated backend commands invalidate only the generation/token that
    // produced their 401. Do not issue a second unconditional logout here: a
    // late frontend response must never clear a newer login.
    resetState();
    setView(githubId !== undefined ? 'devices' : 'login');
    if (githubId !== undefined) {
      setActiveAccountEpoch(nextEpoch);
      // Session expiry keeps its dedicated wording and flow; it is never
      // re-routed through the generic relay banners.
      setRelayFailure({ message: t('accountLogin.sessionExpired'), action: 'sign-in' });
      void accountIdentityService.refresh().catch(() => undefined);
    } else {
      setError({ message: t('accountLogin.sessionExpired'), action: 'sign-in' });
    }
  }, [githubId, invalidateAccountRequests, isAccountEpochCurrent, resetState, t]);

  /** Log the raw transport detail and expose only the classified banner copy. */
  const reportAccountFailure = useCallback((context: string, error: unknown): PanelFailure => {
    log.warn(context, error);
    return describeAccountFailure(error, t);
  }, [t]);

  const markRelayUnreachable = useCallback((error: unknown) => {
    setDevicesReady(false);
    setRelayFailure(describeAccountFailure(error, t));
  }, [t]);

  const refreshDevices = useCallback(async () => {
    const epoch = accountEpochRef.current;
    if (refreshInFlightRef.current?.epoch === epoch) {
      refreshDirtyRef.current = true;
      log.debug('Device list refresh already in flight; scheduling successor');
      return;
    }
    const requestId = ++refreshRequestRef.current;
    refreshInFlightRef.current = { epoch, requestId };
    const isCurrent = () => (
      isAccountEpochCurrent(epoch) && refreshRequestRef.current === requestId
    );
    try {
      void remoteConnectAPI.accountRelayCapabilities().then(capabilities => {
        if (isCurrent()) {
          setAliasCapability(capabilities.includes('device_alias_v1') ? 'supported' : 'unsupported');
        }
      }).catch(error => {
        // A failed capability read is not evidence that the relay lacks the
        // capability, so it keeps the previous answer. Relay reachability has its
        // own banner; reporting this one here only flashed it on every poll.
        if (isCurrent()) log.debug('relay capabilities unavailable', error);
      });
      let list = await remoteConnectAPI.accountListDevices();
      if (!isCurrent()) return;
      const currentLocalDeviceId = localDeviceIdRef.current;
      const localOffline = list.some(d => d.device_id === currentLocalDeviceId && !d.online);
      if (localOffline && currentLocalDeviceId) {
        await new Promise(r => setTimeout(r, 1500));
        if (!isCurrent()) return;
        list = await remoteConnectAPI.accountListDevices();
        if (!isCurrent()) return;
      }
      // The directory snapshot owns online state, but the relay can report this
      // machine offline for a moment after its own routing socket reconnects.
      // While our routing is up this device is online by definition, so pin it
      // instead of flashing a "last seen" line on every refresh.
      setDevices(deviceRoutingReadyRef.current && currentLocalDeviceId
        ? list.map(device => (
            device.device_id === currentLocalDeviceId ? { ...device, online: true } : device
          ))
        : list);
      setDevicesReady(true);
      setRelayFailure(null);
      deviceListFailureCountRef.current = 0;
    } catch (e) {
      if (!isCurrent()) return;
      log.warn('refreshDevices failed', e);
      if (isAccountAuthFailure(e)) {
        await handleSessionExpired(e, epoch);
      } else {
        deviceListFailureCountRef.current += 1;
        // list_devices is an HTTP snapshot while account device routing uses
        // WebSocket. Keep the last/presence-derived list when WS is healthy;
        // one failed snapshot must not be reported as a total Relay outage.
        if (!deviceRoutingReadyRef.current
          && deviceListFailureCountRef.current >= DEVICE_LIST_FAILURE_THRESHOLD) {
          markRelayUnreachable(e);
        }
      }
    } finally {
      if (refreshInFlightRef.current?.epoch === epoch
        && refreshInFlightRef.current.requestId === requestId) {
        refreshInFlightRef.current = null;
        if (refreshDirtyRef.current && isAccountEpochCurrent(epoch)) {
          refreshDirtyRef.current = false;
          void refreshDevicesRef.current?.();
        }
      }
    }
  }, [handleSessionExpired, isAccountEpochCurrent, markRelayUnreachable]);

  /**
   * Presence lists the account's *online* devices, and the desktop emits an
   * empty list when its routing socket drops. That empty list is an unknown
   * state, not proof that every device went offline, so presence only upgrades a
   * device to online and merges the metadata it carries. Offline state and
   * `last_seen_at` stay owned by the directory snapshot, which is re-fetched
   * after every presence signal and on the polling interval.
   */
  const applyPresenceOnline = useCallback((onlineDevices: OnlineDeviceInfo[]) => {
    if (onlineDevices.length === 0) return;
    setDevices(prev => {
      const byId = new Map(prev.map(d => [d.device_id, d]));
      for (const d of onlineDevices) {
        const existing = byId.get(d.device_id);
        byId.set(d.device_id, existing
          ? mergePresenceDevice(existing, d)
          : {
              device_id: d.device_id,
              device_name: d.device_name,
              // An older relay omits these keys entirely, so they stay absent
              // rather than clearing metadata that came from the directory.
              ...(d.device_alias !== undefined ? { device_alias: d.device_alias } : {}),
              ...(d.device_model !== undefined ? { device_model: d.device_model } : {}),
              ...(d.device_os !== undefined ? { device_os: d.device_os } : {}),
              ...(d.device_os_version !== undefined ? { device_os_version: d.device_os_version } : {}),
              ...(d.device_client_version !== undefined ? { device_client_version: d.device_client_version } : {}),
              ...(d.client_version !== undefined ? { client_version: d.client_version } : {}),
              ...(d.device_client_protocol !== undefined ? { device_client_protocol: d.device_client_protocol } : {}),
              ...(d.client_protocol !== undefined ? { client_protocol: d.client_protocol } : {}),
              ...(d.compatible !== undefined ? { compatible: d.compatible } : {}),
              online: true,
              last_seen_at: Math.floor(Date.now() / 1000),
            });
      }
      return Array.from(byId.values());
    });
  }, []);

  /** Latest refreshDevices for the successor refresh, the polling interval and
   * the presence listener (avoids stale closures). */
  refreshDevicesRef.current = refreshDevices;

  const startDevicePolling = useCallback(() => {
    if (refreshTimer.current) {
      clearInterval(refreshTimer.current);
    }
    refreshTimer.current = setInterval(
      () => { void refreshDevicesRef.current?.(); },
      DEVICE_POLL_FALLBACK_MS,
    );
  }, []);

  const attemptDeviceReconnect = useCallback(async (showLoading: boolean) => {
    const epoch = accountEpochRef.current;
    if (deviceReconnectInFlightRef.current === epoch) {
      log.debug('Device routing recovery already in flight; coalescing duplicate request');
      return;
    }
    deviceReconnectInFlightRef.current = epoch;
    if (showLoading) {
      setLoading(true);
      setRelayFailure(null);
    }
    try {
      if (githubId === undefined) return;
      if (!await ensureAccountSession(remoteConnectAPI, () => isAccountEpochCurrent(epoch), githubId)) return;
      const onlineDevices = await connectDevicesWithRetry(
        () => isAccountEpochCurrent(epoch),
      );
      if (!isAccountEpochCurrent(epoch)) return;
      deviceRoutingReadyRef.current = true;
      deviceListFailureCountRef.current = 0;
      applyPresenceOnline(onlineDevices);
      setDevicesReady(true);
      setRelayFailure(null);
      refreshLocalDeviceId(epoch);
      if (!isAccountEpochCurrent(epoch)) return;
      await refreshDevices();
      if (!isAccountEpochCurrent(epoch)) return;
      startDevicePolling();
    } catch (err) {
      log.warn(
        showLoading ? 'manual device reconnect failed' : 'background device reconnect failed',
        err,
      );
      if (!isAccountEpochCurrent(epoch)) return;
      if (isAccountAuthFailure(err)) {
        await handleSessionExpired(err, epoch);
        return;
      }
      markRelayUnreachable(err);
    } finally {
      if (deviceReconnectInFlightRef.current === epoch) deviceReconnectInFlightRef.current = null;
      if (showLoading && isAccountEpochCurrent(epoch)) setLoading(false);
    }
  }, [
    githubId,
    applyPresenceOnline,
    handleSessionExpired,
    isAccountEpochCurrent,
    markRelayUnreachable,
    refreshDevices,
    refreshLocalDeviceId,
    startDevicePolling,
  ]);

  const handleRetryConnect = useCallback(() => {
    void attemptDeviceReconnect(true);
  }, [attemptDeviceReconnect]);

  /**
   * The banner's "check updates" step. Discovery and the update surface stay in
   * the shared update store, so the shell opens its single details dialog; the
   * panel only reports a check that found nothing or failed.
   */
  const handleCheckForUpdates = useCallback(async () => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    setUpdateNotice(null);
    try {
      await useUpdateInstallStore.getState().checkForUpdates('manual');
      const update = useUpdateInstallStore.getState();
      if (update.checkStatus === 'available' && update.availableUpdate) update.openDetails();
      else if (update.checkStatus === 'latest') setUpdateNotice(t('update.noUpdate'));
      else setUpdateNotice(t('update.checkFailed'));
    } catch (e: unknown) {
      log.warn('check_for_updates failed', e);
      setUpdateNotice(t('update.checkFailed'));
    } finally {
      setCheckingUpdates(false);
    }
  }, [checkingUpdates, t]);

  // Initial dial failures have no RelayClient instance to run its built-in
  // reconnect loop. Keep recovering in the background while this account view
  // is active; once a socket succeeds, RelayClient owns subsequent reconnects.
  useEffect(() => {
    if (activeAccountEpoch === null || !relayFailure) return undefined;
    const timer = setInterval(
      () => { void attemptDeviceReconnect(false); },
      DEVICE_CONNECT_RECOVERY_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [activeAccountEpoch, attemptDeviceReconnect, relayFailure]);

  /** Connect presence + load the device list for an active account session. */
  const initializeDevices = useCallback(async () => {
    const epoch = accountEpochRef.current;
    try {
      const onlineDevices = await connectDevicesWithRetry(
        () => isAccountEpochCurrent(epoch),
      );
      if (!isAccountEpochCurrent(epoch)) return;
      deviceRoutingReadyRef.current = true;
      deviceListFailureCountRef.current = 0;
      applyPresenceOnline(onlineDevices);
      setDevicesReady(true);
      setRelayFailure(null);
      // Re-read after AuthOk may have adopted the account-bound device_id.
      refreshLocalDeviceId(epoch);
    } catch (err) {
      if (!isAccountEpochCurrent(epoch)) return;
      log.warn('accountConnectDevices failed', err);
      if (isAccountAuthFailure(err)) {
        await handleSessionExpired(err, epoch);
        return;
      }
      markRelayUnreachable(err);
      return;
    }
    if (!isAccountEpochCurrent(epoch)) return;
    void refreshDevices();
    startDevicePolling();
  }, [
    applyPresenceOnline,
    handleSessionExpired,
    isAccountEpochCurrent,
    markRelayUnreachable,
    refreshDevices,
    refreshLocalDeviceId,
    startDevicePolling,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      accountEpochRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!identity.resolved || identity.status === 'authorizing') return;
    const epoch = invalidateAccountRequests();
    resetState();
    setLoading(false);
    setError(null);
    if (githubId === undefined) {
      setView('login');
      return;
    }
    // Identity is shared with both markets. A missing Relay session is a
    // connection setup step, never a second GitHub login prompt.
    setView('devices');
    setActiveAccountEpoch(epoch);
    refreshLocalDeviceId(epoch);
    ensureAccountSession(remoteConnectAPI, () => isAccountEpochCurrent(epoch), githubId).then(async (ready) => {
      if (ready && isAccountEpochCurrent(epoch)) await initializeDevices();
    }).catch((e) => {
      if (!isAccountEpochCurrent(epoch)) return;
      log.warn('account connection initialization failed', e);
      markRelayUnreachable(e);
    });

    return () => {
      invalidateAccountRequests();
      if (refreshTimer.current) { clearInterval(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [
    identity.resolved,
    identity.status,
    githubId,
    initializeDevices,
    invalidateAccountRequests,
    isAccountEpochCurrent,
    markRelayUnreachable,
    refreshLocalDeviceId,
    resetState,
  ]);

  // Subscribe only while a specific account epoch is active. The callback
  // captures that epoch; invalidation flips the ref synchronously, so an old
  // listener cannot update the next account before React runs its cleanup.
  useEffect(() => {
    if (activeAccountEpoch === null) return undefined;
    const subscribedEpoch = activeAccountEpoch;
    const unlistenPresence = api.listen<{ devices: OnlineDeviceInfo[] }>(
      'account://device-presence',
      (payload) => {
        if (isAccountEpochCurrent(subscribedEpoch) && payload?.devices) {
          deviceRoutingReadyRef.current = payload.devices.length > 0;
          if (deviceRoutingReadyRef.current) {
            deviceListFailureCountRef.current = 0;
            setDevicesReady(true);
            setRelayFailure(null);
          } else {
            // Start a fresh debounce window after routing loss; HTTP failures
            // observed while WS was healthy must not count against it.
            deviceListFailureCountRef.current = 0;
          }
          applyPresenceOnline(payload.devices);
          void refreshDevicesRef.current?.();
        }
      },
    );
    return unlistenPresence;
  }, [activeAccountEpoch, applyPresenceOnline, isAccountEpochCurrent]);

  const handleLogin = useCallback(async () => {
    if (identity.status === 'authorizing') {
      try { await accountIdentityService.reopenSignIn(); }
      catch (e: unknown) { if (mountedRef.current) setError(reportAccountFailure('reopenSignIn failed', e)); }
      return;
    }
    setLoading(true); setError(null);
    try {
      const me = await accountIdentityService.signIn();
      if (mountedRef.current) success(t('accountLogin.loginSuccess', { user_id: me.email ?? me.user.login }));
    } catch (e: unknown) {
      if (mountedRef.current) setError(reportAccountFailure('signIn failed', e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [identity.status, reportAccountFailure, success, t]);

  const handleLogout = useCallback(async () => {
    const epoch = invalidateAccountRequests();
    setLoading(true);
    try {
      await accountIdentityService.logout();
      if (!isAccountEpochCurrent(epoch)) return;
      resetState();
      setView('login');
    } catch (e: unknown) {
      if (!isAccountEpochCurrent(epoch)) return;
      // Logout failed before the backend changed the account; resume presence
      // delivery for the still-current frontend epoch.
      setActiveAccountEpoch(epoch);
      setError(reportAccountFailure('logout failed', e));
    } finally {
      if (isAccountEpochCurrent(epoch)) setLoading(false);
    }
  }, [invalidateAccountRequests, isAccountEpochCurrent, reportAccountFailure, resetState]);

  const handleDeleteDevice = useCallback(async (deviceId: string, deviceName: string) => {
    const isLocal = localDeviceId === deviceId;
    const confirmation = isLocal
      ? t('accountLogin.confirmRemoveCurrentDevice', { name: deviceName })
      : t('accountLogin.confirmRemoveDevice', { name: deviceName });
    const confirmed = await confirmDanger(
      isLocal
        ? t('accountLogin.removeCurrentDevice')
        : t('accountLogin.removeDevice'),
      confirmation,
      {
        confirmText: isLocal
          ? t('accountLogin.removeCurrentDevice')
          : t('accountLogin.removeDevice'),
        cancelText: t('accountLogin.cancel'),
      },
    );
    if (!confirmed) return;
    setLoading(true);
    setError(null);
    const epoch = isLocal ? invalidateAccountRequests() : accountEpochRef.current;
    try {
      await remoteConnectAPI.accountDeleteDevice(deviceId);
      if (!isAccountEpochCurrent(epoch)) return;
      if (isLocal) {
        success(t('accountLogin.currentDeviceRemoved'));
        resetState();
        setView('login');
      } else {
        success(t('accountLogin.deviceRemoved', { name: deviceName }));
        void refreshDevices();
      }
    } catch (e: unknown) {
      if (!isAccountEpochCurrent(epoch)) return;
      if (isAccountAuthFailure(e)) {
        await handleSessionExpired(e, epoch);
      } else {
        if (isLocal) setActiveAccountEpoch(epoch);
        setError(reportAccountFailure('device removal failed', e));
      }
    } finally {
      if (isAccountEpochCurrent(epoch)) setLoading(false);
    }
  }, [
    handleSessionExpired,
    invalidateAccountRequests,
    isAccountEpochCurrent,
    localDeviceId,
    refreshDevices,
    reportAccountFailure,
    resetState,
    success,
    t,
  ]);

  const handleUpdateAlias = useCallback(async (device: AccountDeviceInfo) => {
    const epoch = accountEpochRef.current;
    if (!aliasSupported) { setError({ message: t('accountLogin.deviceAliasUnsupported'), action: null }); return; }
    const alias = aliasDraft.trim() || null;
    // Renaming one device must not cover the directory with the panel-wide
    // blocking overlay; the editor row shows its own progress instead.
    setSavingAliasId(device.device_id);
    setError(null);
    try {
      await remoteConnectAPI.accountUpdateDevice(device.device_id, alias);
      if (!isAccountEpochCurrent(epoch)) return;
      setEditingDeviceId(null);
      void refreshDeviceDirectory();
      await refreshDevices();
      if (isAccountEpochCurrent(epoch)) success(t('accountLogin.deviceAliasUpdated'));
    } catch (e: unknown) {
      if (!isAccountEpochCurrent(epoch)) return;
      const raw = e instanceof Error ? e.message : String(e);
      log.warn('device alias update failed', e);
      setError(/unsupported|not found|unknown command|404|405/i.test(raw)
        ? { message: t('accountLogin.deviceAliasUnsupported'), action: null }
        : describeAccountFailure(e, t));
    } finally {
      if (isAccountEpochCurrent(epoch)) setSavingAliasId(null);
    }
  }, [aliasDraft, aliasSupported, refreshDevices, isAccountEpochCurrent, success, t]);

  const handleStartAliasEdit = useCallback((device: AccountDeviceInfo) => {
    setEditingDeviceId(device.device_id);
    setAliasDraft(device.device_alias ?? '');
  }, []);
  const selectDevice = useCallback(async (device: AccountDeviceInfo) => {
    if (!device.online) return;
    // Picking this machine is a normal surface switch back, not a no-op: the
    // window may currently be rendering a peer.
    const isLocalDevice = Boolean(localDeviceId) && device.device_id === localDeviceId;
    // A confirmed-incompatible peer is never a control target. Renaming stays a
    // plain directory operation and is handled by its own row action.
    if (!isLocalDevice && !isDeviceControllable(device)) return;
    setLoading(true);
    setError(null);
    try {
      let outcome: 'activated' | 'superseded';
      if (isLocalDevice) {
        outcome = await switchToLocal();
        if (outcome === 'activated') {
          success(t('accountLogin.deviceSwitcher.switchedLocal'));
        }
      } else {
        outcome = await switchToDevice(device.device_id, deviceDisplayName(device));
        if (outcome === 'activated') {
          success(t('accountLogin.enteredPeerMode', { name: deviceDisplayName(device) }));
        }
      }
      if (outcome === 'activated') {
        onCloseDialog();
      }
    } catch (e: unknown) {
      setError(reportAccountFailure('switch device failed', e));
    } finally {
      setLoading(false);
    }
  }, [
    localDeviceId,
    onCloseDialog,
    reportAccountFailure,
    success,
    switchToDevice,
    switchToLocal,
    t,
  ]);

  /** Run the next step a banner offers; sign-in keeps its existing flow. */
  const runFailureAction = useCallback((action: RelayFailureAction) => {
    if (action === 'check-updates') { void handleCheckForUpdates(); return; }
    if (action === 'retry') {
      if (view === 'login') { void handleLogin(); } else { void handleRetryConnect(); }
    }
  }, [handleCheckForUpdates, handleLogin, handleRetryConnect, view]);

  const renderSectionHeading = (id: string, title: string, action?: React.ReactNode) => (
    <div className="account-panel__section-heading">
      <h3 id={id} className="account-panel__section-title">{title}</h3>
      {action}
    </div>
  );

  return (
    <>
      <div data-openbitfun-component="remote-account-panel" data-openbitfun-part="root" data-openbitfun-view={view} className="account-panel">
        {error && (
          <FailureBanner
            failure={error}
            t={t}
            busy={loading}
            onClose={() => setError(null)}
            onAction={runFailureAction}
          />
        )}

        {updateNotice && (
          <div className="account-panel__error-banner" data-openbitfun-component="remote-account-panel" data-openbitfun-part="error">
            <Alert tone="info" message={updateNotice} closable onClose={() => setUpdateNotice(null)} />
          </div>
        )}

        {loading && view === 'devices' && (
          <div className="account-panel__loading-overlay" data-openbitfun-component="remote-account-panel" data-openbitfun-part="loading">
            <Icon name="refresh" size="lg" className="spinning" />
            <span>{t('accountLogin.processing')}</span>
          </div>
        )}

        {view === 'login' && (
          <ScrollArea className="account-panel__scroll" data-openbitfun-component="remote-account-panel" data-openbitfun-part="scroll">
            <section className="account-panel__section" aria-labelledby="account-panel-account-title">
              {renderSectionHeading('account-panel-account-title', t('accountLogin.accountSectionTitle'))}
              <div className="account-panel__card account-panel__login-card" data-openbitfun-component="remote-account-panel" data-openbitfun-part="form">
                <span className="account-panel__login-icon" aria-hidden="true"><Icon name="user" size="md" /></span>
                <span className="account-panel__login-copy">
                  <span className="account-panel__value-prop">{t('accountLogin.loginValueProp')}</span>
                  <span className="account-panel__security-note">{t('accountLogin.securityNote')}</span>
                </span>
                <div className="account-panel__actions" data-openbitfun-component="remote-account-panel" data-openbitfun-part="actions">
                  <Button variant="primary" size="sm" leadingIcon={<LogIn size={14} />} onClick={handleLogin} loading={loading && identity.status !== 'authorizing'}>
                    {identity.status === 'authorizing' ? t('accountLogin.reopen') : loading ? t('accountLogin.processing') : t('accountLogin.login')}
                  </Button>
                </div>
              </div>
            </section>
          </ScrollArea>
        )}

        {view === 'devices' && (
          <ScrollArea className="account-panel__scroll" data-openbitfun-component="remote-account-panel" data-openbitfun-part="scroll">
            <section className="account-panel__section" aria-labelledby="account-panel-account-title">
              {renderSectionHeading('account-panel-account-title', t('accountLogin.accountSectionTitle'))}
              <div className="account-panel__card account-panel__identity-line">
                <Avatar key={username} size="md" src={identity.me?.user.avatarUrl} alt={username} aria-label={username}>
                  {username.trim().charAt(0).toUpperCase() || <Icon name="user" />}
                </Avatar>
                <span className="account-panel__identity-copy">
                  <OverflowText className="account-panel__identity-name" title={username}>{username.trim()}</OverflowText>
                  <span className="account-panel__identity-label">{t('accountLogin.signedInAccount')}</span>
                </span>
                <Button variant="outline" size="sm" leadingIcon={<LogOut size={14} />} onClick={handleLogout} disabled={loading}>
                  {t('accountLogin.logout')}
                </Button>
              </div>
            </section>
            <section className="account-panel__section" aria-labelledby="account-panel-devices-title">
              {renderSectionHeading('account-panel-devices-title', t('accountLogin.linkedDevices'), (
                relayFailure && failureBannerAction(relayFailure) ? null : (
                  <Button variant="text" size="xs" leadingIcon={<Icon name="refresh" size="sm" />}
                    onClick={relayFailure ? handleRetryConnect : refreshDevices} disabled={loading}>
                    {t(relayFailure ? 'accountLogin.retryConnect' : 'accountLogin.refreshDevices')}
                  </Button>
                )
              ))}
              {aliasCapability === 'unsupported' && <Alert tone="info" message={t('accountLogin.deviceAliasUnsupported')} />}
              {relayFailure && (
                <FailureBanner failure={relayFailure} t={t} busy={loading} onAction={runFailureAction} />
              )}
              {!relayFailure && <div className="account-panel__card account-panel__devices-card">
                <div className="account-panel__device-list" data-openbitfun-component="remote-account-panel" data-openbitfun-part="deviceList">
                  {devicesReady && devices.length === 0 && (
                    <div className="account-panel__empty">{t('accountLogin.noDevices')}</div>
                  )}
                  {!devicesReady && (
                    <div className="account-panel__empty account-panel__empty--loading" role="status">
                      <Icon name="refresh" size="sm" className="spinning" />
                      {t('accountLogin.loadingDevices')}
                    </div>
                  )}
                  {sortedDevices.map((d) => {
                  const isLocal = localDeviceId === d.device_id;
                  // This machine is selectable while the window renders a peer,
                  // so the dialog can bring the UI back without disconnecting.
                  // A confirmed-incompatible peer stays listed but is never a
                  // control target; this machine is never gated by its own flag.
                  const deviceControllable = isLocal || isDeviceControllable(d);
                  const isSelectable = (isLocal ? peerMode.active : d.online) && deviceControllable;
                  const incompatible = isLocal ? false : !isDeviceControllable(d);
                  const incompatibleVersion = deviceClientVersion(d);
                  const incompatibleNotice = incompatibleVersion
                    ? t('accountLogin.deviceClientIncompatibleWithVersion', { version: incompatibleVersion })
                    : t('accountLogin.deviceClientIncompatible');
                  const removeLabel = isLocal
                    ? t('accountLogin.removeCurrentDevice')
                    : t('accountLogin.removeDevice');
                  const displayName = deviceDisplayName(d);
                  const metadata = deviceMetadataLabel(d);
                  const reportedKind = (d.device_kind ?? '').trim().toLowerCase();
                  // A controller reports `mobile` or `watch` and has no host
                  // system to draw; when the kind is missing, the system the
                  // device reported is the only fact this row has, so it decides
                  // the mark. `hostKind` separates a CLI host, which has no
                  // system silhouette to draw either.
                  const systemFacts = {
                    kind: reportedKind === 'mobile' || reportedKind === 'watch' ? 'mobile' as const : 'desktop' as const,
                    name: displayName,
                    os: d.device_os,
                    hostKind: reportedHostKind(d.device_kind),
                  };
                  const DeviceEntry = isSelectable && editingDeviceId !== d.device_id ? 'button' : 'div';
                  return (
                  <div data-openbitfun-component="remote-account-panel" data-openbitfun-part="deviceCard" key={d.device_id}
                    data-openbitfun-state={[
                      !d.online && 'offline',
                      isLocal && 'current',
                    ].filter(Boolean).join(' ') || undefined}
                    className={`account-panel__device-card ${isSelectable ? 'selectable' : ''} ${d.online ? '' : 'offline'} ${isLocal ? 'current' : ''}`}>
                    <DeviceEntry
                      className="account-panel__device-select"
                      {...(isSelectable && editingDeviceId !== d.device_id ? {
                        type: 'button' as const,
                        onClick: () => void selectDevice(d),
                        disabled: loading,
                        'aria-label': t('accountLogin.openDevice', { name: displayName }),
                      } : {})}
                    >
                      <span className="account-panel__device-glyph" aria-hidden="true">
                        <DeviceSystemGlyph device={systemFacts} size={18} />
                      </span>
                      <span className="account-panel__device-info">
                        {/* Renaming replaces the name in place: showing the old
                            name next to an editor reads as two device names. */}
                        {editingDeviceId === d.device_id ? (
                          <span className="account-panel__device-alias-editor">
                            <Input
                              className="account-panel__device-alias-input"
                              value={aliasDraft}
                              onChange={e => setAliasDraft(e.target.value)}
                              onKeyDown={event => {
                                if (event.key === 'Enter') { event.preventDefault(); void handleUpdateAlias(d); }
                                if (event.key === 'Escape') { event.preventDefault(); setEditingDeviceId(null); }
                              }}
                              placeholder={t('accountLogin.deviceAliasPlaceholder')}
                              aria-label={t('accountLogin.deviceAlias')}
                              autoFocus
                              disabled={savingAliasId === d.device_id}
                            />
                            <IconButton
                              aria-label={t('accountLogin.saveDeviceAlias')}
                              icon={<Check size={14} />}
                              loading={savingAliasId === d.device_id}
                              onClick={() => void handleUpdateAlias(d)}
                              size="sm"
                              variant="primary"
                            />
                            <IconButton
                              aria-label={t('accountLogin.cancel')}
                              disabled={savingAliasId === d.device_id}
                              icon={<X size={14} />}
                              onClick={() => setEditingDeviceId(null)}
                              size="sm"
                              variant="quiet"
                            />
                          </span>
                        ) : (
                          <span className="account-panel__device-name">
                            <OverflowText title={displayName}>{displayName}</OverflowText>
                            {isLocal && <StatusPill tone="neutral" className="account-panel__device-badge">{t('accountLogin.thisDevice')}</StatusPill>}
                          </span>
                        )}
                        <span className="account-panel__device-meta">
                          <span className="account-panel__device-status" data-openbitfun-state={d.online ? 'online' : 'offline'}>{d.online
                            ? t('accountLogin.online')
                            : d.last_seen_at
                              ? t('accountLogin.lastSeen', { time: formatRelativeTime(d.last_seen_at * 1000) })
                              : t('accountLogin.offline')}</span>
                          {metadata && <span className="account-panel__device-meta-detail">{` · ${metadata}`}</span>}
                        </span>
                        {incompatible && (
                          <span
                            className="account-panel__device-incompatible"
                            title={incompatibleNotice}
                          >
                            {incompatibleNotice}
                          </span>
                        )}
                      </span>
                    </DeviceEntry>
                    {/* The open editor owns the row's actions; keeping rename and
                        delete beside it rendered two competing icon clusters. */}
                    {editingDeviceId !== d.device_id && (
                      <span className="account-panel__device-actions">
                        <IconButton
                          aria-label={t('accountLogin.editDeviceAlias')}
                          disabled={loading || editingDeviceId !== null || !aliasSupported || savingAliasId !== null}
                          icon={<Pencil size={14} />}
                          onClick={(e) => { e.stopPropagation(); handleStartAliasEdit(d); }}
                          size="sm"
                          title={t('accountLogin.editDeviceAlias')}
                          variant="quiet"
                        />
                        <IconButton
                          aria-label={`${removeLabel}: ${displayName}`}
                          disabled={loading || savingAliasId !== null}
                          icon={<Icon name="delete" size="sm" />}
                          onClick={(e) => { e.stopPropagation(); handleDeleteDevice(d.device_id, displayName); }}
                          size="sm"
                          title={removeLabel}
                          variant="quiet"
                        />
                      </span>
                    )}
                    <span className="account-panel__device-chevron" aria-hidden="true">
                      {isSelectable && editingDeviceId !== d.device_id && <Icon name="chevron-right" size="sm" />}
                    </span>
                  </div>
                  );
                })}
                </div>
              </div>}
            </section>
          </ScrollArea>
        )}
      </div>
    </>
  );
};

export default AccountPanel;
