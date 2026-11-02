/**
 * The reason a peer host gave for refusing a command, or `null` when the error
 * is not a host capability refusal. `PeerRefusal::message` keeps these prefixes
 * byte-stable, so settings pages can show the reason instead of a generic
 * failure without knowing every command a host lacks.
 */
const REFUSAL = /command '[^']+' is not supported on \w+ peer host(?:: (.+))?$/s;
const UNKNOWN_TO_HOST = /command '[^']+' is unknown to this OpenBitFun \w+ peer host version/;

export function peerHostRefusalReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const refusal = REFUSAL.exec(message);
  if (refusal) {
    const reason = refusal[1] ?? message.slice(refusal.index);
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  }
  return UNKNOWN_TO_HOST.test(message) ? message : null;
}
