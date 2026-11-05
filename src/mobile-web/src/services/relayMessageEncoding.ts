// The first octet is outside UTF-8. Legacy JSON therefore needs no marker.
const prefix = [0xff, 0x4f, 0x5a, 1];
const headerSize = 8;
const maxPlainBytes = 64 * 1024 * 1024;
export const relayZstd = 'zstd-1';

let ready = false;
let preparing = false;
let codec: Promise<typeof import('@bokuweb/zstd-wasm')> | undefined;
function getCodec() {
  if (!codec) {
    codec = import('@bokuweb/zstd-wasm').then(async module => {
      await module.init();
      ready = true;
      return module;
    }).catch(error => {
      codec = undefined;
      throw error;
    });
  }
  return codec;
}

// Start loading the local decoder during connection setup. A browser with
// unavailable WebAssembly continues exchanging the original JSON envelopes.
export function prepareRelayEncoding(): void {
  if (preparing) return;
  preparing = true;
  void Promise.resolve().then(() => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))
    .then(() => getCodec()).catch(() => { preparing = false; });
}

export function acceptsRelayZstd(): boolean { return ready; }

export async function encodeRelayMessage(plain: Uint8Array, accepted: boolean): Promise<Uint8Array> {
  if (!accepted || plain.length <= 256 || plain.length > maxPlainBytes) return plain;
  const frame = (await getCodec()).compress(plain, 1);
  if (frame.length + headerSize >= plain.length) return plain;
  const result = new Uint8Array(frame.length + headerSize);
  result.set(prefix);
  new DataView(result.buffer).setUint32(4, plain.length, true);
  result.set(frame, headerSize);
  return result;
}

// The WASM wrapper allocates from the Zstd frame's content-size field. Check
// it before entering WASM, including 64-bit sizes and streaming frames.
function validateFrame(frame: Uint8Array, expected: number): void {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
  if (frame.length < 6 || view.getUint32(0, true) !== 0xfd2fb528) throw new Error('Invalid Relay Zstd frame');
  const descriptor = frame[4];
  const single = (descriptor & 32) !== 0;
  const dictFlag = descriptor & 3;
  if ((descriptor & 8) || dictFlag) throw new Error('Unsupported Relay Zstd frame');
  let offset = single ? 5 : 6;
  const sizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  if (offset + sizeBytes > frame.length) throw new Error('Incomplete Relay Zstd header');
  if (sizeBytes) {
    let size = 0;
    for (let i = sizeBytes - 1; i >= 0; i--) size = size * 256 + frame[offset + i];
    if (sizeBytes === 2) size += 256;
    if (size !== expected) throw new Error('Relay decoded size mismatch');
  }
  offset += sizeBytes;
  // Reject concatenated frames, including empty/skippable suffixes.
  let last: boolean;
  do {
    if (offset + 3 > frame.length) throw new Error('Incomplete Relay Zstd block');
    const block = frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    const kind = (block >>> 1) & 3;
    if (kind === 3) throw new Error('Invalid Relay Zstd block');
    last = (block & 1) !== 0;
    offset += 3 + (kind === 1 ? 1 : block >>> 3);
  } while (!last);
  if (offset + (descriptor & 4 ? 4 : 0) !== frame.length) throw new Error('Invalid Relay Zstd frame length');
}

export async function decodeRelayMessage(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0xff) return bytes;
  if (bytes.length <= headerSize || !prefix.every((v, i) => bytes[i] === v)) throw new Error('Unknown Relay message encoding');
  const expected = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(4, true);
  if (!expected || expected > maxPlainBytes) throw new Error('Invalid Relay decoded size');
  const frame = bytes.subarray(headerSize);
  validateFrame(frame, expected);
  const plain = (await getCodec()).decompress(frame, { defaultHeapSize: expected });
  if (plain.length !== expected) throw new Error('Relay decoded size mismatch');
  return plain;
}
