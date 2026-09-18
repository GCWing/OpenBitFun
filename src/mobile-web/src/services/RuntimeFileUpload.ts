import { sha256 } from '@noble/hashes/sha2.js';

export interface UploadProgress { transferId: string; nextOffset: number; totalBytes: number; completed: boolean }
export interface UploadTarget { path: string; workspaceId?: string; workspacePath: string; remoteConnectionId?: string | null }
export type UploadInvoke = (request: Record<string, unknown>) => Promise<UploadProgress>;
const CHUNK_BYTES = 3 * 1024 * 1024;
function base64(bytes: Uint8Array): string {
  let value = '';
  for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(value);
}
export function newUploadId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** The selected local file is read in chunks; only the controlled runtime publishes it. */
export async function uploadRuntimeFile(file: Blob, target: UploadTarget, transferId: string, invoke: UploadInvoke,
  current: () => boolean, progress: (bytes: number) => void): Promise<void> {
  const identity = { ...target };
  const assertCurrent = () => { if (!current()) throw new Error('Upload target changed'); };
  const call = async (args: Record<string, unknown>) => {
    assertCurrent(); const result = await invoke({...identity,transferId,...args}); assertCurrent();
    if (result.transferId !== transferId || result.totalBytes !== file.size || !Number.isSafeInteger(result.nextOffset)
      || result.nextOffset < 0 || result.nextOffset > file.size) throw new Error('Invalid runtime upload cursor');
    return result;
  };
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    assertCurrent(); hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
  }
  const digest = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  let state: UploadProgress;
  try { state = await call({action:'begin',totalBytes:file.size,sha256:digest,expectedHash:''}); }
  catch (error) { assertCurrent(); try { state = await call({action:'status'}); } catch { throw error; } }
  progress(state.nextOffset);
  while (!state.completed && state.nextOffset < file.size) {
    const offset = state.nextOffset;
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    try { state = await call({action:'append',offset,contentBase64:base64(bytes)}); }
    catch (failure) {
      assertCurrent();
      // An unknown ACK outcome is resolved by the runtime cursor before retrying bytes.
      state = await call({action:'status'});
      if (state.nextOffset === offset) throw failure;
    }
    if (state.nextOffset <= offset) throw new Error('Runtime upload made no progress');
    progress(state.nextOffset);
  }
  if (!state.completed) {
    try { state = await call({action:'finish'}); }
    catch (error) { assertCurrent(); state = await call({action:'status'}); if (!state.completed) throw error; }
  }
  if (!state.completed || state.nextOffset !== file.size) throw new Error('Runtime upload is incomplete');
}
