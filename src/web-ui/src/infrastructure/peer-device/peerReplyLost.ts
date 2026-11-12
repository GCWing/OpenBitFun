/**
 * A device request whose reply was lost because this window's Relay
 * connection closed mid-flight (a reconnect or device switch). The request
 * may or may not have run, so callers show a calm "try again" instead of the
 * transport's own text.
 */

// `realtime_client::RELAY_REPLY_LOST` keeps this prefix byte-stable; the
// second pattern is the socket library's text from builds before it existed.
const REPLY_LOST = /Relay connection closed before the reply arrived|failed to receive ack|Relay is disconnected/;

/**
 * `PEER_HOST_NOT_RESPONDING_CODE` in the peer transport adapter: a read whose
 * host did not answer within its bounded deadline.
 */
const HOST_NOT_RESPONDING = /^peer_host_not_responding:/;

/** `PEER_HOST_UI_NOT_READY`: the host refused before executing; it is starting. */
const HOST_STARTING = /^peer_host_ui_not_ready:/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

export function isPeerReplyLost(error: unknown): boolean {
  return REPLY_LOST.test(messageOf(error));
}

export function isPeerHostNotResponding(error: unknown): boolean {
  return HOST_NOT_RESPONDING.test(messageOf(error));
}

export function isPeerHostStarting(error: unknown): boolean {
  return HOST_STARTING.test(messageOf(error));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Localized copy for a lost reply, an unresponsive host or a host that is
 * still starting, or `null` when `error` is something else. All are
 * retryable by the user.
 */
export function peerReplyLostMessage(error: unknown, t: Translate): string | null {
  if (isPeerHostStarting(error)) return t('common:peerHost.starting');
  if (isPeerHostNotResponding(error)) return t('common:peerHost.notResponding');
  return isPeerReplyLost(error) ? t('common:peerHost.connectionInterrupted') : null;
}
