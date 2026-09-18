import { STARTUP_OVERLAY_HIDDEN_EVENT } from '@/app/startup/startupSignals';
import { isStartupOverlayPresent } from '@/app/startup/startupOverlay';

export const SESSION_METADATA_DEFERRED_SIGNAL = STARTUP_OVERLAY_HIDDEN_EVENT;
export const SESSION_METADATA_DEFERRED_FALLBACK_MS = 10000;
export const SESSION_METADATA_DEFERRED_FRAME_COUNT = 1;

export type InitialSessionMetadataLoadMode =
  | 'skip'
  | 'immediate'
  | 'after-startup-signal'
  | 'after-startup-paint';

export function getInitialSessionMetadataLoadMode({
  hasWorkspace,
  isActiveWorkspace,
  isVisible,
  startupOverlayHandedOff,
}: {
  hasWorkspace: boolean;
  isActiveWorkspace: boolean;
  isVisible: boolean;
  startupOverlayHandedOff: boolean;
}): InitialSessionMetadataLoadMode {
  if (!hasWorkspace || !isVisible) {
    return 'skip';
  }

  if (isActiveWorkspace) {
    return 'immediate';
  }

  return startupOverlayHandedOff ? 'after-startup-paint' : 'after-startup-signal';
}

export function getDeferredSessionMetadataDelayMs(workspaceKey?: string | null): number {
  const normalized = workspaceKey?.trim();
  if (!normalized) {
    return 0;
  }

  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }

  return (hash % 4) * 40;
}

export function hasStartupOverlayHandedOff(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return !isStartupOverlayPresent();
}
