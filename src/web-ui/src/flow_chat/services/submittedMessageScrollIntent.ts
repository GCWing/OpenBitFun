import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

export interface SubmittedMessageScrollIntent {
  readonly scope: SurfaceScope;
  readonly sessionId: string;
  readonly turnId: string;
  messageId: string | null;
  viewportId?: number;
}

// Separate from the 300ms arrival animation. A history projection may take
// longer to reveal the submitted Turn. Only explicit local submission writes
// here; replay, hydration, and other controllers never manufacture intent.
const pending = new Map<string, SubmittedMessageScrollIntent>();
const listeners = new Set<() => void>();
const cleanups = new WeakMap<SubmittedMessageScrollIntent, () => void>();
const keyFor = (scope: SurfaceScope, sessionId: string) => scope.key('submit-scroll', scope.epoch, sessionId);

export function registerSubmittedMessageScrollIntent(
  scope: SurfaceScope, sessionId: string, turnId: string, messageId: string | null,
): SubmittedMessageScrollIntent | undefined {
  if (!scope.isCurrent()) return undefined;
  const key = keyFor(scope, sessionId);
  const intent: SubmittedMessageScrollIntent = { scope, sessionId, turnId, messageId };
  const previous = pending.get(key);
  if (previous) finishSubmittedMessageScrollIntent(previous);
  pending.set(key, intent);
  scope.signal.addEventListener('abort', discard, { once: true });
  function discard() { finishSubmittedMessageScrollIntent(intent); }
  cleanups.set(intent, () => scope.signal.removeEventListener('abort', discard));
  listeners.forEach(listener => listener());
  return intent;
}

export function claimSubmittedMessageScrollIntent(sessionId: string, viewportId: number, includeUnbound = false) {
  const intent = pending.get(keyFor(getActiveSurfaceScope(), sessionId));
  if (!intent?.scope.isCurrent() || (intent.viewportId !== undefined && intent.viewportId !== viewportId)) return null;
  if (!includeUnbound && intent.messageId === null) return null;
  intent.viewportId = viewportId;
  return intent;
}

/** A host Turn can arrive before its submit RPC returns. Bind only a Turn this
 * device explicitly submitted, before publishing its user row to the store. */
export function bindSubmittedMessageScrollIntent(sessionId: string, turnId: string, messageId: string): void {
  const intent = pending.get(keyFor(getActiveSurfaceScope(), sessionId));
  if (!intent?.scope.isCurrent() || intent.turnId !== turnId || intent.messageId !== null) return;
  intent.messageId = messageId;
  listeners.forEach(listener => listener());
}

export function peekSubmittedMessageScrollIntent(scope: SurfaceScope, sessionId: string, turnId: string): SubmittedMessageScrollIntent | undefined {
  const intent = pending.get(keyFor(scope, sessionId));
  return intent?.turnId === turnId && intent.scope.isCurrent() ? intent : undefined;
}

export function finishSubmittedMessageScrollIntent(intent: SubmittedMessageScrollIntent): void {
  const key = keyFor(intent.scope, intent.sessionId);
  const wasPending = pending.get(key) === intent;
  if (wasPending) pending.delete(key);
  cleanups.get(intent)?.();
  cleanups.delete(intent);
  // Notify after the caller releases its own pending reference. The follow
  // hook finishes an intent inside its placement transaction.
  if (wasPending) queueMicrotask(() => listeners.forEach(listener => listener()));
}

export function isSubmittedMessageScrollIntentPending(intent: SubmittedMessageScrollIntent): boolean {
  return pending.get(keyFor(intent.scope, intent.sessionId)) === intent;
}

export function subscribeSubmittedMessageScrollIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
