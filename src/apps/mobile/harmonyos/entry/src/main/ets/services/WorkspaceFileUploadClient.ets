import fs from '@ohos.file.fs';
import picker from '@ohos.file.picker';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { Encoding } from './Encoding';
import { RemoteSessionManager } from './RemoteSessionManager';

interface UploadRequest { action: string; transferId: string; path: string; workspacePath: string; remoteConnectionId?: string; totalBytes?: number; sha256?: string; expectedHash?: string; offset?: number; contentBase64?: string; }
interface UploadArgs { request: UploadRequest; }
interface UploadStatus { transferId: string; nextOffset: number; totalBytes: number; completed: boolean; }
interface PendingUpload { file: fs.File; request: UploadRequest; targetId: string; started: boolean; }

/** Native file IO remains on the phone; only bounded encrypted chunks cross to the runtime. */
export class WorkspaceFileUploadClient {
  private pending?: PendingUpload;
  private manager: RemoteSessionManager;
  private target: () => string;
  constructor(manager: RemoteSessionManager, target: () => string) { this.manager = manager; this.target = target; }
  hasPending(): boolean { return this.pending !== undefined; }
  private async call(request: UploadRequest): Promise<UploadStatus> {
    if (this.pending && this.pending.targetId !== this.target()) throw new Error('Reconnect to the upload owning runtime first');
    const args: UploadArgs = { request: request };
    const status = await this.manager.hostInvoke<UploadStatus>('workspace_file_upload', args);
    if (request.action !== 'cancel' && (status.transferId !== request.transferId ||
      status.totalBytes !== request.totalBytes || !Number.isSafeInteger(status.nextOffset) ||
      status.nextOffset < 0 || status.nextOffset > (request.totalBytes || 0))) {
      throw new Error('Invalid upload acknowledgement');
    }
    return status;
  }
  async select(path: string, remoteConnectionId: string | undefined, expectedHash: string, current: () => boolean, workspacePath: string): Promise<void> {
    if (this.pending) throw new Error('Finish or cancel the current file upload first');
    if (!workspacePath) throw new Error('Upload workspace identity is required');
    const targetId = this.target();
    const options = new picker.DocumentSelectOptions(); options.maxSelectNumber = 1;
    const files = await new picker.DocumentViewPicker().select(options);
    if (!files.length || !current() || targetId !== this.target()) return;
    const file = await fs.open(files[0], fs.OpenMode.READ_ONLY);
    try {
      const metadata = await fs.stat(file.fd);
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new Error('Selected file size is not supported');
      if (!metadata.isFile()) throw new Error('Select a regular file');
      const digest = cryptoFramework.createMd('SHA256');
      let offset = 0;
      while (offset < metadata.size) {
        if (!current() || targetId !== this.target()) throw new Error('File upload target changed');
        const buffer = new ArrayBuffer(Math.min(1024 * 1024, metadata.size - offset));
        const count = await fs.read(file.fd, buffer, { offset: offset, length: buffer.byteLength });
        if (count <= 0) throw new Error('Selected file changed during hashing');
        await digest.update({ data: new Uint8Array(buffer.slice(0, count)) }); offset += count;
      }
      const hash = await digest.digest();
      if (!current() || targetId !== this.target()) throw new Error('File upload target changed');
      const transferId = Array.from(Encoding.randomBytes(32)).map((value: number) => value.toString(16).padStart(2, '0')).join('');
      const request: UploadRequest = { action: 'begin', transferId: transferId, path: path, workspacePath: workspacePath, remoteConnectionId: remoteConnectionId, totalBytes: metadata.size,
        sha256: Array.from(hash.data).map((value: number) => value.toString(16).padStart(2, '0')).join(''), expectedHash: expectedHash };
      this.pending = { file: file, request: request, targetId: targetId, started: false };
    } catch (error) { await fs.close(file); throw error as Error; }
  }
  async resume(current: () => boolean, progress: (offset: number, total: number) => void): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (pending.targetId !== this.target()) throw new Error('Reconnect to the upload owning runtime first');
    const request = pending.request;
    // Begin is idempotent even when its earlier acknowledgement was lost.
    pending.started = true;
    request.action = 'begin'; request.contentBase64 = undefined; request.offset = undefined;
    let status: UploadStatus;
    try { status = await this.call(request); }
    catch (error) {
      if (!current() || pending.targetId !== this.target()) throw error as Error;
      request.action = 'status';
      status = await this.call(request);
    }
    while (!status.completed && status.nextOffset < (request.totalBytes || 0)) {
      if (!current() || pending.targetId !== this.target()) return;
      const offset = status.nextOffset;
      const buffer = new ArrayBuffer(Math.min(1024 * 1024, (request.totalBytes || 0) - offset));
      const count = await fs.read(pending.file.fd, buffer, { offset: offset, length: buffer.byteLength });
      if (count <= 0) throw new Error('Selected file changed during upload');
      request.action = 'append'; request.offset = offset;
      request.contentBase64 = Encoding.bytesToBase64(new Uint8Array(buffer.slice(0, count)));
      try { status = await this.call(request); }
      catch (error) {
        // Query the owning runtime before deciding whether an uncertain chunk needs resending.
        request.action = 'status'; request.contentBase64 = undefined;
        status = await this.call(request);
        if (status.nextOffset === offset) throw error as Error;
      }
      if (status.nextOffset <= offset || status.nextOffset > (request.totalBytes || 0)) throw new Error('Invalid upload acknowledgement offset');
      progress(status.nextOffset, request.totalBytes || 0);
    }
    if (!current() || pending.targetId !== this.target()) return;
    if (!status.completed) {
      request.action = 'finish'; request.contentBase64 = undefined;
      try { status = await this.call(request); }
      catch (error) {
        if (!current() || pending.targetId !== this.target()) throw error as Error;
        request.action = 'status';
        status = await this.call(request);
        if (!status.completed) throw error as Error;
      }
    }
    if (!status.completed || status.nextOffset !== request.totalBytes) throw new Error('Runtime did not complete the file upload');
    await fs.close(pending.file); if (this.pending === pending) this.pending = undefined;
  }
  async cancel(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (pending.targetId !== this.target()) throw new Error('Reconnect to the upload owning runtime before cancelling');
    pending.request.action = 'cancel'; pending.request.contentBase64 = undefined;
    if (pending.started) await this.call(pending.request);
    await fs.close(pending.file); if (this.pending === pending) this.pending = undefined;
  }
}
