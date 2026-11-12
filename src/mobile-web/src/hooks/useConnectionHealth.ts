import { useEffect, useRef } from 'react';
import { isAccountIdentityChangedError } from '../services/RelayHttpClient';
import {
  isRemoteControlTargetChangedError,
  RemoteSessionManager,
} from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';
import { deriveConnectionState } from '../services/connectionState';

const PING_INTERVAL = 15000;
const PING_TIMEOUT = 10000;
const OWNERSHIP_RETRY_DELAY = 250;

function pingWithTimeout(mgr: RemoteSessionManager, ms: number): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    mgr.ping(),
    new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('ping timeout')), ms);
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Derive one connection state for every surface from the facts that explain
 * it: the browser's network, the account Relay connection, the Relay's device
 * directory, and pings to the controlled desktop. Pings run immediately after
 * a reconnect, resume, network return or the desktop coming back online.
 *
 * When the Relay reconnects or the desktop comes back online, the misses
 * counted while that path was down no longer describe it: they are capped at
 * one, so the recovery ping decides instead of a stale "unreachable".
 */
export function useConnectionHealth(sessionMgr: RemoteSessionManager | null) {
  const setConnectionHealth = useMobileStore((s) => s.setConnectionHealth);
  const setConnectionState = useMobileStore((s) => s.setConnectionState);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let cancelled = false;
    let loopGeneration = 0;
    let missedPings = 0;
    let answered = false;

    if (!sessionMgr) {
      setConnectionHealth('unpaired');
      return;
    }

    let lastRelayStatus = sessionMgr.relayStatus;
    let lastHostOnline = sessionMgr.controlTargetPresence()?.online ?? null;
    const forgiveMissedPings = () => { missedPings = Math.min(missedPings, 1); };

    const evaluate = () => {
      if (cancelled) return;
      const { health, issue } = deriveConnectionState({
        browserOnline: browserOnline(),
        relayStatus: sessionMgr.relayStatus,
        presence: sessionMgr.controlTargetPresence(),
        missedPings,
        answered,
      });
      setConnectionState(health, issue);
    };

    const schedule = (generation: number, delay: number) => {
      if (cancelled || generation !== loopGeneration) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void loop(generation);
      }, delay);
    };

    const loop = async (generation: number) => {
      if (cancelled || generation !== loopGeneration) return;
      try {
        await pingWithTimeout(sessionMgr, PING_TIMEOUT);
        if (cancelled || generation !== loopGeneration) return;
        missedPings = 0;
        answered = true;
        evaluate();
        schedule(generation, PING_INTERVAL);
      } catch (error: unknown) {
        if (cancelled || generation !== loopGeneration) return;
        if (
          isRemoteControlTargetChangedError(error)
          || isAccountIdentityChangedError(error)
        ) {
          setConnectionHealth('checking');
          schedule(generation, OWNERSHIP_RETRY_DELAY);
          return;
        }
        // A single miss keeps the last answered state; the second one reports.
        missedPings += 1;
        evaluate();
        schedule(generation, PING_INTERVAL);
      }
    };

    /** Ping now without hiding the current state behind "checking". */
    const pingNow = () => {
      if (cancelled) return;
      loopGeneration += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      void loop(loopGeneration);
    };

    const restart = () => {
      missedPings = 0;
      answered = false;
      lastHostOnline = sessionMgr.controlTargetPresence()?.online ?? null;
      loopGeneration += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      setConnectionHealth('checking');
      void loop(loopGeneration);
    };

    const onRelayStatus = () => {
      const status = sessionMgr.relayStatus;
      if (status === 'connected' && lastRelayStatus !== 'connected') forgiveMissedPings();
      lastRelayStatus = status;
      evaluate();
    };
    const onPresence = () => {
      const online = sessionMgr.controlTargetPresence()?.online ?? null;
      if (online === true && lastHostOnline === false) forgiveMissedPings();
      lastHostOnline = online;
      evaluate();
    };
    const onOffline = () => evaluate();
    const unlisten = sessionMgr.onControlTargetChange(restart);
    const stopRecovery = sessionMgr.onRecoverySignal(pingNow);
    const stopRelayStatus = sessionMgr.onRelayStatus(onRelayStatus);
    const stopPresence = sessionMgr.onControlTargetPresenceChange(onPresence);
    if (typeof window !== 'undefined') window.addEventListener('offline', onOffline);
    restart();

    return () => {
      cancelled = true;
      loopGeneration += 1;
      unlisten();
      stopRecovery();
      stopRelayStatus();
      stopPresence();
      if (typeof window !== 'undefined') window.removeEventListener('offline', onOffline);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionMgr, setConnectionHealth, setConnectionState]);
}
