import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

let requestSequence = 0;

/** Local correlation only; also works in HTTP Web hosts without crypto.randomUUID. */
export function createAcpStartupRequestId(): string {
  return `acp-startup-${Date.now()}-${++requestSequence}`;
}

/** Presentation-only lifecycle; host commands and persisted sessions keep their existing contracts. */
export interface AcpSessionStartupDetail {
  phase: 'start' | 'finish';
  action: 'create' | 'restore';
  requestId: string;
  clientId: string;
  scope: SurfaceScope;
  workspaceId?: string;
  succeeded?: boolean;
  cancelled?: boolean;
  error?: string;
  retry?: () => Promise<string | void>;
}

export function emitAcpSessionStartup(detail: AcpSessionStartupDetail): void {
  window.dispatchEvent(new CustomEvent<AcpSessionStartupDetail>('openbitfun:acp-session-creation', { detail }));
}
