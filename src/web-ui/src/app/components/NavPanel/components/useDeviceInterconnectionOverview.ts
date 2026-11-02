import { useDeviceDirectory, resolveDeviceName, resolveDeviceNameFrom } from '@/infrastructure/account/deviceDirectory';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccountLoginState } from '@/infrastructure/account/useAccountLoginState';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import {
  remoteConnectAPI,
  type DeviceInfo,
} from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { remoteConnectStatusSource, useRemoteConnectStatus } from '@/infrastructure/remote-connect/remoteConnectStatus';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { useDispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import {
  connectionServiceFromRelayUrl,
  projectDeviceInterconnectionOverview,
  type DeviceOverviewConnectionService,
  type DeviceOverviewDispatchJob,
} from '../deviceInterconnectionOverview';

const TOPOLOGY_POLL_MS = 15_000;

export function useDeviceInterconnectionOverview(fallbackLocalDeviceName: string, fallbackMobileDeviceName?: string) {
  const account = useAccountLoginState();
  const directory = useDeviceDirectory();
  const peerContext = usePeerDeviceModeOptional();
  const dispatchJobs = useDispatchJobStore(state => state.jobs);

  const [localDevice, setLocalDevice] = useState<DeviceInfo | null>(null);
  const { status: remoteStatus, state: remoteStatusState } = useRemoteConnectStatus();
  const [accountService, setAccountService] = useState<DeviceOverviewConnectionService | null>(null);
  const refreshGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => refreshGenerationRef.current === generation;

    const devicePromise = remoteConnectAPI.getDeviceInfo()
      .then(device => {
        if (isCurrent()) setLocalDevice(device);
      })
      .catch(() => undefined);

    const statusPromise = remoteConnectStatusSource.refresh().catch(() => undefined);

    const relayPromise = account.loggedIn
      ? remoteConnectAPI.accountGetCredentialHint().then(hint => {
          if (isCurrent()) {
            setAccountService(connectionServiceFromRelayUrl(hint?.relay_url));
          }
        })
      : Promise.resolve().then(() => {
          if (isCurrent()) setAccountService(null);
        });

    await Promise.all([devicePromise, statusPromise, relayPromise]);
  }, [account.loggedIn]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, TOPOLOGY_POLL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      refreshGenerationRef.current += 1;
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const unlistenLogin = api.listen('account://login-state', () => {
      remoteConnectStatusSource.invalidate();
      void refresh();
    });
    const unlistenPresence = api.listen('account://device-presence', () => {
      void refresh();
    });
    return () => {
      unlistenLogin();
      unlistenPresence();
    };
  }, [refresh]);

  const projectedDispatchJobs = useMemo<DeviceOverviewDispatchJob[]>(() => (
    Object.values(dispatchJobs).map(job => {
      if (job.target.kind === 'local') {
        return {
          id: job.jobId,
          state: job.state,
          target: { kind: 'local' as const },
        };
      }
      if (job.target.kind === 'ssh') {
        return {
          id: job.jobId,
          state: job.state,
          target: {
            kind: 'ssh' as const,
            id: job.target.connectionId,
            name: job.target.displayName,
          },
        };
      }
      return {
        id: job.jobId,
        state: job.state,
        target: {
          kind: 'device' as const,
          id: job.target.deviceId,
          name: resolveDeviceNameFrom(directory.devices, job.target.deviceId, job.target.displayName),
        },
      };
    })
  ), [dispatchJobs, directory]);

  const peer = useMemo(() => (
    peerContext?.peerMode.active
      ? {
          deviceId: peerContext.peerMode.deviceId,
          deviceName: peerContext.peerMode.deviceName,
        }
      : null
  ), [peerContext?.peerMode]);

  // A system and a kind are facts a device reports to the Relay, so the account
  // directory row is where they are stated for every device. That holds for this
  // machine too: the device info call answers with identity only, and the row is
  // the same one the device list draws. Never the browser's own platform, which
  // identifies the window rather than the machine.
  const localEntry = directory.localId
    ? directory.devices.find(device => device.device_id === directory.localId)
    : undefined;
  const localDeviceOs = localEntry?.device_os ?? null;
  const localDeviceKind = localEntry?.device_kind ?? null;
  const peerEntry = peer
    ? directory.devices.find(device => device.device_id === peer.deviceId)
    : undefined;

  const localDeviceName = account.deviceName ?? (localDevice ? resolveDeviceName(localDevice.device_id, localDevice.device_name) : fallbackLocalDeviceName);
  const overview = useMemo(() => projectDeviceInterconnectionOverview({
    localDeviceName,
    fallbackMobileDeviceName,
    localDeviceOs,
    localDeviceKind,
    peer,
    peerDeviceOs: peerEntry?.device_os ?? null,
    peerDeviceKind: peerEntry?.device_kind ?? null,
    remoteStatus,
    remoteStatusState,
    dispatchJobs: projectedDispatchJobs,
    accountService,
  }), [
    accountService,
    localDeviceName,
    fallbackMobileDeviceName,
    localDeviceOs,
    localDeviceKind,
    peer,
    peerEntry,
    projectedDispatchJobs,
    remoteStatus,
    remoteStatusState,
  ]);

  return {
    overview,
    refresh,
    remoteStatus,
    accountService,
  };
}
