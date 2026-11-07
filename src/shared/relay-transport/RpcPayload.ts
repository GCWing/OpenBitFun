import { relayEndpointBase } from './RelayEndpoint';

/** Short-lived opaque bulk transfers. References stay on the configured Relay. */
const INLINE_BYTES = 128 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

export class RpcPayload {
  private readonly endpoint: string;
  private readonly lifetime = new AbortController();
  constructor(url: string, private readonly token: string) {
    const base = relayEndpointBase(url);
    if (!base) throw new Error('Invalid Relay URL');
    this.endpoint = `${base}/v1/rpc/payloads`;
  }
  close(): void { this.lifetime.abort(); }
  async uploadIfLarge(value: unknown): Promise<unknown> {
    const body = new TextEncoder().encode(JSON.stringify(value));
    if (body.length <= INLINE_BYTES) return value;
    if (body.length > MAX_BYTES) throw new Error('RPC payload exceeds a transfer block; use paginated or chunked operations');
    const response = await fetch(this.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream' },
      body, signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) throw new Error(`Relay payload upload failed (${response.status}); request was not submitted`);
    const reference: unknown = await response.json();
    validate(reference);
    return reference;
  }
  async resolve<T>(value: unknown): Promise<T> {
    if (!value || typeof value !== 'object' || !('$relayPayload' in value)) return value as T;
    const { id, bytes } = validate(value);
    const response = await fetch(`${this.endpoint}/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) throw new Error(`Relay payload download failed (${response.status})`);
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== bytes) throw new Error('Relay payload length mismatch');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Relay payload response has no body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > bytes) throw new Error('Relay payload length mismatch');
        chunks.push(chunk.value);
      }
      if (size !== bytes) throw new Error('Incomplete Relay payload transfer');
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) as T;
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
function validate(value: unknown): { id: string; bytes: number } {
  const ref = (value as { $relayPayload?: { id?: unknown; bytes?: unknown } })?.$relayPayload;
  if (!ref || typeof ref.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id)
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > MAX_BYTES) {
    throw new Error('Invalid Relay payload reference');
  }
  return { id: ref.id, bytes: ref.bytes };
}
