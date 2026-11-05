/**
 * A device request whose reply was lost because this window's Relay
 * connection closed mid-flight (a reconnect or device switch). The request
 * may or may not have run, so callers show a calm "try again" instead of the
 * transport's own text.
 */

// `realtime_client::RELAY_REPLY_LOST` keeps this prefix byte-stable; the
// second pattern is the socket library's text from builds before it existed.
const REPLY_LOST = /Relay connection closed before the reply arrived|failed to receive ack|Relay is disconnected/;

export function isPeerReplyLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return REPLY_LOST.test(message);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Localized copy for a lost reply, or `null` when `error` is something else. */
export function peerReplyLostMessage(error: unknown, t: Translate): string | null {
  return isPeerReplyLost(error) ? t('common:peerHost.connectionInterrupted') : null;
}
