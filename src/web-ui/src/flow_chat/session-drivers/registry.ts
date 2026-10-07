/**
 * Static driver registry. All drivers are registered at module load — no
 * dynamic registration, no ordering hazard, and resolution stays synchronous
 * so hot paths can use it.
 */

import type { SessionConfig } from '../services/flow-chat-manager/types';
import {
  resolveSessionDriverId,
  resolveSessionDriverIdForCreation,
  type DriverResolvableSession,
  type SessionDriverId,
} from './resolve';
import type { SessionDriver, SessionDriverNavigationStatusSource, SessionDriverOwnershipSource } from './types';
import { localSessionDriver } from './local/LocalSessionDriver';
import { dispatchSessionDriver } from './dispatch/DispatchSessionDriver';

const drivers: Record<SessionDriverId, SessionDriver> = {
  local: localSessionDriver,
  dispatch: dispatchSessionDriver,
};

const navigationStatusSources = Array.from(new Set(Object.values(drivers)
  .map(driver => driver.navigationStatusSource)
  .filter((source): source is SessionDriverNavigationStatusSource => Boolean(source))));

const ownershipSources = Array.from(new Set(Object.values(drivers)
  .map(driver => driver.ownershipSource)
  .filter((source): source is SessionDriverOwnershipSource => Boolean(source))));

export function sessionDriverById(id: SessionDriverId): SessionDriver {
  return drivers[id];
}

/** Stable, deduplicated driver sources observed by shared session navigation. */
export function sessionDriverNavigationStatusSources(): readonly SessionDriverNavigationStatusSource[] {
  return navigationStatusSources;
}

export function sessionDriverOwnershipSources(): readonly SessionDriverOwnershipSource[] {
  return ownershipSources;
}

export function driverForSession(
  sessionId: string,
  session: DriverResolvableSession | undefined,
): SessionDriver {
  return drivers[resolveSessionDriverId(sessionId, session)];
}

export function driverForCreation(
  config: Pick<SessionConfig, 'dispatchTargetRequest'>,
): SessionDriver {
  return drivers[resolveSessionDriverIdForCreation(config)];
}
