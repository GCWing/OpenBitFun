import { relayEndpointBase } from '../../../shared/relay-transport/RelayEndpoint';

/**
 * Bulk RPC parameters (image attachments) travel to the Relay as a short-lived
 * opaque payload and the RPC carries only its reference. The shared transport
 * does this in one attempt; mobile-web uploads first so a flaky mobile link
 * gets a bounded retry and the chat can tell uploading apart from waiting for
 * the desktop. The shared transport passes a reference through unchanged,
 * because it is far below the inline limit.
 *
 * Mirrors `INLINE_BYTES` / `MAX_BYTES` in `shared/relay-transport/RpcPayload.ts`.
 */
export const RELAY_INLINE_PAYLOAD_BYTES = 128 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const RELAY_PAYLOAD_UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const ATTEMPT_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RelayPayloadReference { $relayPayload: { id: string; bytes: number } }

/** UTF-8 JSON of `value` when it must travel by reference, otherwise null. */
export function relayPayloadBytes(value: unknown): Uint8Array | null {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length <= RELAY_INLINE_PAYLOAD_BYTES) return null;
  if (body.length > MAX_PAYLOAD_BYTES) {
    throw new Error('RPC payload exceeds a transfer block; request was not submitted');
  }
  return body;
}

function validateReference(value: unknown): RelayPayloadReference {
  const ref = (value as { $relayPayload?: { id?: unknown; bytes?: unknown } } | null)?.$relayPayload;
  if (!ref || typeof ref.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id)
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > MAX_PAYLOAD_BYTES) {
    throw new Error('Invalid Relay payload reference; request was not submitted');
  }
  return { $relayPayload: { id: ref.id, bytes: ref.bytes } };
}

export interface RelayPayloadUploadOptions {
  /** Throws when the owner changed; checked before every attempt. */
  assertCurrent?: () => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

/**
 * Upload `body` to the Relay, retrying transport failures and transient
 * statuses a bounded number of times. Every failure states that nothing was
 * submitted, because the RPC itself has not been sent yet.
 */
export async function uploadRelayPayload(
  relayUrl: string,
  token: string,
  body: Uint8Array,
  options: RelayPayloadUploadOptions = {},
): Promise<RelayPayloadReference> {
  const base = relayEndpointBase(relayUrl);
  if (!base) throw new Error('Invalid Relay URL');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? RELAY_PAYLOAD_UPLOAD_ATTEMPTS;
  let lastFailure = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.assertCurrent?.();
    let retryable = true;
    try {
      const response = await fetchImpl(`${base}/v1/rpc/payloads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.ok) return validateReference(await response.json());
      lastFailure = String(response.status);
      retryable = RETRYABLE_STATUSES.has(response.status);
      void response.body?.cancel();
    } catch (error) {
      if ((error as Error)?.message?.includes('request was not submitted')) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (!retryable || attempt === attempts) break;
    console.warn('[RelayPayload] upload attempt failed; retrying', { attempt, failure: lastFailure });
    await sleep(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  }
  throw new Error(`Relay payload upload failed (${lastFailure}); request was not submitted`);
}
