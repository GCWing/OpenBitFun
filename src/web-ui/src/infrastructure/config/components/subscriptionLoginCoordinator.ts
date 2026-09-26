import type { SubscriptionProvider } from '../types';
import type { SubscriptionLoginMethod } from '@/infrastructure/api/service-api/AIApi';

export function subscriptionLoginMethodsForSurface(
  provider: SubscriptionProvider,
  methods: readonly SubscriptionLoginMethod[] | undefined,
  localBrowserCallbackReachable: boolean,
): SubscriptionLoginMethod[] {
  return (methods ?? []).filter((method) => (
    provider !== 'codex' || method !== 'browser' || localBrowserCallbackReachable
  ));
}

/**
 * Keeps the settings UI to one sign-in action while selecting the Codex flow
 * that can actually return to the host running authorization.
 */
export function preferredSubscriptionLoginMethod(
  provider: SubscriptionProvider,
  localBrowserCallbackReachable: boolean,
): 'device' | undefined {
  return provider === 'codex' && !localBrowserCallbackReachable ? 'device' : undefined;
}

/** Antigravity currently exposes only a callback bound on the execution host. */
export function subscriptionLoginRequiresLocalDevice(provider: SubscriptionProvider): boolean {
  return provider === 'antigravity';
}

export interface SubscriptionLoginOperation {
  id: number;
  sessionId: string;
  provider: SubscriptionProvider;
  cancelled: boolean;
  startSettled: boolean;
}

export interface SubscriptionStartSettlement {
  shouldContinue: boolean;
  cleanupError?: unknown;
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // The ID only correlates local commands; this compatibility path is not a
    // security token. Older Linux WebKit builds may lack randomUUID/Web Crypto.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Owns the single active subscription authorization operation.
 *
 * Keeping operation identity outside React state prevents a stale async
 * `finally` block from clearing a newer login session.
 */
export class SubscriptionLoginCoordinator {
  private nextId = 0;
  private active: SubscriptionLoginOperation | null = null;

  constructor(
    private readonly createSessionId: () => string = createUuid,
  ) {}

  begin(provider: SubscriptionProvider): SubscriptionLoginOperation | null {
    if (this.active) return null;
    const operation: SubscriptionLoginOperation = {
      id: ++this.nextId,
      sessionId: this.createSessionId(),
      provider,
      cancelled: false,
      startSettled: false,
    };
    this.active = operation;
    return operation;
  }

  current(): SubscriptionLoginOperation | null {
    return this.active;
  }

  isCurrent(operation: SubscriptionLoginOperation): boolean {
    return this.active === operation && !operation.cancelled;
  }

  owns(operation: SubscriptionLoginOperation): boolean {
    return this.active === operation;
  }

  markStartSettled(operation: SubscriptionLoginOperation): boolean {
    if (this.active !== operation) return false;
    operation.startSettled = true;
    return !operation.cancelled;
  }

  requestCancel(provider: SubscriptionProvider): SubscriptionLoginOperation | null {
    if (!this.active || this.active.provider !== provider) return null;
    const operation = this.active;
    operation.cancelled = true;
    return operation;
  }

  complete(operation: SubscriptionLoginOperation): boolean {
    if (this.active !== operation) return false;
    this.active = null;
    return true;
  }
}

/**
 * Resolves the start/cancel race. A cancellation requested while the backend
 * start command is still running keeps the coordinator slot reserved; once
 * start returns, this helper cancels the now-created backend session before
 * the operation may be completed.
 */
export async function settleSubscriptionLoginStart(
  coordinator: SubscriptionLoginCoordinator,
  operation: SubscriptionLoginOperation,
  cancelBackend: () => Promise<void>,
): Promise<SubscriptionStartSettlement> {
  if (!coordinator.owns(operation)) {
    return { shouldContinue: false };
  }
  if (coordinator.markStartSettled(operation)) {
    return { shouldContinue: true };
  }
  try {
    await cancelBackend();
    return { shouldContinue: false };
  } catch (cleanupError) {
    return { shouldContinue: false, cleanupError };
  }
}
