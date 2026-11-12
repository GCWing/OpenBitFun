import type { ConnectionHealth, ConnectionIssue } from './store';

/** One lost ping is noise on a mobile network; two in a row is an outage. */
export const MISSED_PINGS_BEFORE_UNREACHABLE = 2;

export interface ConnectionFacts {
  browserOnline: boolean;
  relayStatus: 'connecting' | 'connected' | 'disconnected' | 'closed';
  /** Directory listing of the controlled desktop, null when it is not listed. */
  presence: { online: boolean; lastSeenAt: number | null } | null;
  /** Consecutive pings to the desktop that failed. */
  missedPings: number;
  /** The desktop has answered a ping since the target was selected. */
  answered: boolean;
}

/**
 * The connection state every surface shows. The most specific explanation
 * wins: no network, then a desktop the Relay lists as offline (only while it
 * also misses pings, since a stale listing must not hide a reachable host),
 * then a Relay reconnect, then a desktop that is listed but does not answer.
 *
 * `navigator.onLine` can be wrong (captive portals, VPNs, some WebViews), so
 * "no network" also needs evidence before it hides a desktop that answers:
 * a missed ping, a Relay that is not connected, or no answer yet.
 */
export function deriveConnectionState(facts: ConnectionFacts): { health: ConnectionHealth; issue: ConnectionIssue | null } {
  let issue: ConnectionIssue | null = null;
  const pingsWork = facts.answered && facts.missedPings === 0 && facts.relayStatus === 'connected';
  if (!facts.browserOnline && !pingsWork) {
    issue = { kind: 'offline' };
  } else if (facts.presence?.online === false && facts.missedPings > 0) {
    issue = { kind: 'host-offline', lastSeenAt: facts.presence.lastSeenAt };
  } else if (facts.missedPings >= MISSED_PINGS_BEFORE_UNREACHABLE) {
    issue = facts.relayStatus === 'connected' ? { kind: 'unreachable' } : { kind: 'relay' };
  }
  if (issue) return { health: 'unreachable', issue };
  return { health: facts.answered ? 'connected' : 'checking', issue: null };
}
