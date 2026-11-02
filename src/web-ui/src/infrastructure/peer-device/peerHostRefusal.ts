export interface PeerHostRefusal {
  /** `unavailable`: this host kind does not offer it. `updateRequired`: a newer host may. */
  kind: 'unavailable' | 'updateRequired';
  /** The host's own English explanation, for use as secondary detail only. */
  detail: string;
}

// `PeerRefusal::message` keeps these prefixes byte-stable for frontend matching.
const REFUSAL = /command '[^']+' is not supported on \w+ peer host(?:: (.+))?$/s;
const UNKNOWN_TO_HOST = /command '[^']+' is unknown to this OpenBitFun \w+ peer host version/;
/** Registry reason `CLI_NOT_IMPLEMENTED`: this host version has no handler yet. */
const NOT_YET_IMPLEMENTED = 'has no handler for this command';

export function classifyPeerHostRefusal(error: unknown): PeerHostRefusal | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (UNKNOWN_TO_HOST.test(message)) return { kind: 'updateRequired', detail: message };
  const refusal = REFUSAL.exec(message);
  if (!refusal) return null;
  const detail = refusal[1] ?? message.slice(refusal.index);
  return { kind: detail.includes(NOT_YET_IMPLEMENTED) ? 'updateRequired' : 'unavailable', detail };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Localized copy for a peer host refusal, or `null` when `error` is something else. */
export function peerHostRefusalMessage(error: unknown, t: Translate): string | null {
  const refusal = classifyPeerHostRefusal(error);
  if (!refusal) return null;
  return t('common:peerHost.withDetail', {
    message: t(refusal.kind === 'updateRequired'
      ? 'common:peerHost.updateRequired'
      : 'common:peerHost.unavailable'),
    detail: refusal.detail,
  });
}
