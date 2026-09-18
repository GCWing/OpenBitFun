import type { RemoteSessionManager, RuntimeFileWorkspace } from './RemoteSessionManager';

interface DownloadWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface SavePickerHost {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<DownloadWriter>;
  }>;
}
export interface DownloadOptions {
  sessionId?: string;
  workspace?: RuntimeFileWorkspace;
  /** Captured by the calling view before the picker opens. */
  isCurrent: () => boolean;
  onProgress?: (downloaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Call directly from the user's click so Chrome retains picker activation. */
export async function downloadRuntimeFile(
  manager: Pick<RemoteSessionManager, 'streamFile'>,
  path: string,
  options: DownloadOptions,
  host: SavePickerHost = window as unknown as SavePickerHost,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (!options.isCurrent()) throw new Error('Remote control target changed');
  };
  assertCurrent();
  let writer: DownloadWriter | undefined;
  const parts: BlobPart[] = [];
  try {
    if (host.showSaveFilePicker) {
      const handle = await host.showSaveFilePicker({ suggestedName: path.split('/').pop() || 'download' });
      assertCurrent();
      writer = await handle.createWritable();
      assertCurrent();
    }
    const metadata = await manager.streamFile(path, async bytes => {
      assertCurrent();
      // Backpressure reaches the read owner; there is never another chunk in
      // flight while the local sink is writing. Safari lacks a writable picker
      // and uses its browser download API, which necessarily retains Blob parts.
      if (writer) await writer.write(bytes);
      else parts.push(bytes.slice().buffer);
      assertCurrent();
    }, options.sessionId, options.onProgress, undefined, options.workspace);
    assertCurrent();
    if (writer) {
      await writer.close();
      writer = undefined;
    } else {
      const url = URL.createObjectURL(new Blob(parts, { type: metadata.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = metadata.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  } catch (error) {
    await writer?.abort(error).catch(() => {});
    // Closing the system picker is a normal user cancellation, not a failed RPC.
    if (error instanceof Error && error.name === 'AbortError') return;
    throw error;
  }
}
