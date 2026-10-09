import {
  getActiveSurfaceScope,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import type { DialogTurn } from '../types/flow-chat';
import { registerSubmittedMessageScrollIntent } from './submittedMessageScrollIntent';

export const SUBMITTED_MESSAGE_PRESENTATION_MS = 300;
const STATUS_REVEAL_AFTER_MS = 160;

export interface SubmittedMessageArrival {
  readonly startedAt: number;
  readonly scope: SurfaceScope;
}

interface PendingArrival extends SubmittedMessageArrival {
  messageId: string;
  claimed: boolean;
}

// Presentation receipts only: never persisted or inferred from transcript growth.
// The short lifetime also prevents an offscreen send from animating on a later visit.
const arrivals = new Map<string, PendingArrival>();

export interface SubmittedMessagePreview {
  readonly scope: SurfaceScope;
  readonly sessionId: string;
  readonly turnId: string;
  readonly message: DialogTurn['userMessage'];
  readonly phase: 'forming' | 'failed';
  readonly error?: string;
  readonly failedAt?: number;
  readonly failureClaimed?: boolean;
}

const EMPTY_PREVIEWS: readonly SubmittedMessagePreview[] = [];
const previews = new Map<string, readonly SubmittedMessagePreview[]>();
const previewListeners = new Set<() => void>();
const previewCleanups = new WeakMap<SubmittedMessagePreview, () => void>();

function previewKey(scope: SurfaceScope, sessionId: string): string {
  return scope.key('submitted-message-previews', scope.epoch, sessionId);
}

export function subscribeSubmittedMessagePreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => { previewListeners.delete(listener); };
}

export function getSubmittedMessagePreviews(
  scope: SurfaceScope,
  sessionId: string,
): readonly SubmittedMessagePreview[] {
  return scope.isCurrent() ? previews.get(previewKey(scope, sessionId)) ?? EMPTY_PREVIEWS : EMPTY_PREVIEWS;
}

export function getSubmittedMessagePreview(
  sessionId: string,
  turnId: string,
): SubmittedMessagePreview | undefined {
  return getSubmittedMessagePreviews(getActiveSurfaceScope(), sessionId)
    .find(preview => preview.turnId === turnId);
}

function publishPreviews(scope: SurfaceScope, sessionId: string, next: readonly SubmittedMessagePreview[]): void {
  const key = previewKey(scope, sessionId);
  if (next.length) previews.set(key, next);
  else previews.delete(key);
  previewListeners.forEach(listener => listener());
}

/** A foreground composer send owns this display-only row until a real Turn adopts it. */
export function beginSubmittedMessagePreview(
  scope: SurfaceScope,
  sessionId: string,
  turnId: string,
  message: DialogTurn['userMessage'],
): SubmittedMessagePreview | undefined {
  if (!scope.isCurrent()) return undefined;
  const previous = getSubmittedMessagePreviews(scope, sessionId);
  // A fresh attempt supersedes the failed shell, while other in-flight sends keep their identity.
  for (const preview of previous) {
    if (preview.phase === 'failed' || preview.turnId === turnId) {
      previewCleanups.get(preview)?.();
      if (preview.phase === 'failed') arrivals.delete(arrivalKey(scope, sessionId, preview.turnId));
    }
  }
  const preview: SubmittedMessagePreview = { scope, sessionId, turnId, message, phase: 'forming' };
  registerSubmittedMessage(scope, sessionId, turnId, message.id);
  registerSubmittedMessageScrollIntent(scope, sessionId, turnId, message.id);
  const abort = () => finishSubmittedMessagePreview(scope, sessionId, turnId);
  scope.signal.addEventListener('abort', abort, { once: true });
  previewCleanups.set(preview, () => scope.signal.removeEventListener('abort', abort));
  publishPreviews(scope, sessionId, [
    ...previous.filter(item => item.phase !== 'failed' && item.turnId !== turnId), preview,
  ]);
  return preview;
}

export function finishSubmittedMessagePreview(scope: SurfaceScope, sessionId: string, turnId: string): void {
  const current = previews.get(previewKey(scope, sessionId));
  const preview = current?.find(item => item.turnId === turnId);
  if (!preview || !current) return;
  previewCleanups.get(preview)?.();
  if (preview.phase === 'failed') arrivals.delete(arrivalKey(scope, sessionId, turnId));
  publishPreviews(scope, sessionId, current.filter(item => item !== preview));
}

export function failSubmittedMessagePreview(
  scope: SurfaceScope,
  sessionId: string,
  turnId: string,
  error: string,
): void {
  const current = previews.get(previewKey(scope, sessionId));
  const preview = current?.find(item => item.turnId === turnId);
  if (!preview || !current || !scope.isCurrent()) return;
  const failed: SubmittedMessagePreview = {
    ...preview, phase: 'failed', error, failedAt: performance.now(), failureClaimed: false,
  };
  previewCleanups.set(failed, previewCleanups.get(preview)!);
  previewCleanups.delete(preview);
  publishPreviews(scope, sessionId, current.map(item => item === preview ? failed : item));
}

/** Only the first mounted instance may animate the failed handoff. */
export function consumeSubmittedMessageFailure(
  sessionId: string, turnId: string, messageId: string,
): SubmittedMessagePreview | undefined {
  const preview = getSubmittedMessagePreview(sessionId, turnId);
  if (preview?.phase !== 'failed' || preview.failureClaimed || preview.message.id !== messageId
    || preview.failedAt === undefined || performance.now() - preview.failedAt > SUBMITTED_MESSAGE_PRESENTATION_MS) return undefined;
  // The claim is deliberately mutable so a virtualized remount does not publish another row.
  (preview as { failureClaimed: boolean }).failureClaimed = true;
  return preview;
}

function arrivalKey(scope: SurfaceScope, sessionId: string, turnId: string): string {
  return scope.key('submitted-message', scope.epoch, sessionId, turnId);
}

export function registerSubmittedMessage(
  scope: SurfaceScope,
  sessionId: string,
  turnId: string,
  messageId: string,
): void {
  if (!scope.isCurrent()) return;
  const key = arrivalKey(scope, sessionId, turnId);
  if (arrivals.has(key)) return;

  const arrival: PendingArrival = { startedAt: performance.now(), scope, messageId, claimed: false };
  arrivals.set(key, arrival);
  const timer = setTimeout(dispose, SUBMITTED_MESSAGE_PRESENTATION_MS);
  function dispose() {
    if (arrivals.get(key) === arrival) arrivals.delete(key);
    clearTimeout(timer);
    scope.signal.removeEventListener('abort', dispose);
  }
  scope.signal.addEventListener('abort', dispose, { once: true });
}

function getArrival(sessionId: string, turnId: string): PendingArrival | undefined {
  const scope = getActiveSurfaceScope();
  const arrival = arrivals.get(arrivalKey(scope, sessionId, turnId));
  return arrival && performance.now() - arrival.startedAt < SUBMITTED_MESSAGE_PRESENTATION_MS
    ? arrival
    : undefined;
}

/** One renderer can claim the send; virtualized remounts and replay get nothing. */
export function consumeSubmittedMessageArrival(
  sessionId: string,
  turnId: string,
  messageId: string,
): SubmittedMessageArrival | undefined {
  const arrival = getArrival(sessionId, turnId);
  if (!arrival || arrival.claimed || arrival.messageId !== messageId) return undefined;
  arrival.claimed = true;
  return arrival;
}

/** Only the initial send can defer paint; runtime status and output remain immediate. */
export function submittedMessageStatusDelay(sessionId: string, turnId: string): number {
  const arrival = getArrival(sessionId, turnId);
  return arrival ? Math.max(0, STATUS_REVEAL_AFTER_MS - (performance.now() - arrival.startedAt)) : 0;
}
