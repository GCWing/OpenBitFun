import { decodeRelayMessage, encodeRelayMessage } from './relayMessageEncoding';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
/**
 * E2E encryption for the mobile web client.
 *
 * Uses pure-JS implementations that work on plain HTTP pages:
 *   - X25519 key exchange: @noble/curves
 *   - AES-256-GCM:         @noble/ciphers
 *
 * The shared secret (32 bytes from X25519) is used directly as the AES key,
 * matching the Rust desktop side which uses x25519-dalek + aes-gcm the same way.
 */

// @ts-ignore — @noble/curves v2 exports with .js suffix in package.json
import { x25519 } from '@noble/curves/ed25519.js';
// @ts-ignore — @noble/ciphers v2 exports with .js suffix in package.json
import { gcm } from '@noble/ciphers/aes.js';

const NONCE_LEN = 12;

export interface MobileKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function generateKeyPair(): Promise<MobileKeyPair> {
  const priv = randomBytes(32);
  const pub = x25519.getPublicKey(priv);
  return { publicKey: new Uint8Array(pub), privateKey: priv };
}

export async function deriveSharedKey(
  kp: MobileKeyPair,
  peerPub: Uint8Array,
): Promise<Uint8Array> {
  const shared = x25519.getSharedSecret(kp.privateKey, peerPub);
  return new Uint8Array(shared);
}

export async function encrypt(
  key: Uint8Array,
  plaintext: string,
  acceptsZstd = false,
): Promise<{ data: string; nonce: string; usesZstd: boolean }> {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = gcm(key, nonce);
  const encoded = await encodeRelayMessage(new TextEncoder().encode(plaintext), acceptsZstd);
  const ct = cipher.encrypt(encoded);
  return { data: toB64(ct), nonce: toB64(nonce), usesZstd: encoded[0] === 0xff };
}

export async function decrypt(
  key: Uint8Array,
  dataB64: string,
  nonceB64: string,
): Promise<string> {
  const pt = decryptBytes(key, fromB64(dataB64), fromB64(nonceB64));
  return new TextDecoder('utf-8', { fatal: true }).decode(await decodeRelayMessage(pt));
}

/** Decrypt a raw AES-256-GCM payload, including its appended authentication tag. */
export function decryptBytes(
  key: Uint8Array,
  data: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return gcm(key, nonce).decrypt(data);
}

export function toB64(buf: Uint8Array): string {
  let s = '';
  buf.forEach(b => (s += String.fromCharCode(b)));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf;
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  // crypto.getRandomValues works on HTTP too (it's not part of subtle)
  (globalThis.crypto || (globalThis as any).msCrypto).getRandomValues(buf);
  return buf;
}

/** Matches the Relay v1 device key contract used by desktop and CLI. */
export function deriveDeviceMessageKey(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32 || peerPublicKey.length !== 32) throw new Error('Invalid device key.');
  const ownPublicKey = x25519.getPublicKey(privateKey);
  const shared = x25519.getSharedSecret(privateKey, peerPublicKey);
  if (shared.every((value: number) => value === 0)) throw new Error('Invalid peer key.');
  let first = ownPublicKey;
  let second = peerPublicKey;
  for (let i = 0; i < 32; i += 1) {
    if (ownPublicKey[i] === peerPublicKey[i]) continue;
    if (ownPublicKey[i] > peerPublicKey[i]) [first, second] = [second, first];
    break;
  }
  const info = new Uint8Array(64);
  info.set(first); info.set(second, 32);
  try {
    return hkdf(sha256, shared, new TextEncoder().encode('OpenBitFun Relay v1.0.0 device key'), info, 32);
  } finally { shared.fill(0); }
}
