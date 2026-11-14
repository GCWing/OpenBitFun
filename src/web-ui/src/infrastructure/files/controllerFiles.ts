/**
 * Files that belong to the controller device.
 *
 * In Peer Device Mode the registered transport follows the rendered device, so
 * every `api.invoke` reaches the peer. A path dropped from Finder/Explorer, or
 * copied to the OS clipboard, belongs to this controller instead. These helpers
 * read such files through the controller's own Tauri host and move their bytes
 * to an execution host with the runtime-owned `workspace_file_upload` service,
 * so a controller path is never handed to another host as a reference.
 */
import { createTransportAdapter, type ITransportAdapter } from '@/infrastructure/api/adapters';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type { FileMetadata } from '@/infrastructure/api/service-api/WorkspaceAPI';
import type { ExplorerNodeDto } from '@/infrastructure/api/service-api/tauri-commands';

/** Bounded by the host's `MAX_UPLOAD_CHUNK` (3 MiB) with relay headroom. */
const UPLOAD_CHUNK_BYTES = 1024 * 1024;

let controllerAdapter: ITransportAdapter | null = null;

/**
 * The controller's own Tauri host. An explicit empty connection id is the
 * local-provider marker, so a path that collides with a registered remote
 * workspace root still resolves on this machine's filesystem.
 */
function controllerHost(): ITransportAdapter {
  controllerAdapter ??= createTransportAdapter('tauri');
  return controllerAdapter;
}

export async function getControllerFileMetadata(path: string): Promise<FileMetadata> {
  const raw = await controllerHost().request<Record<string, unknown>>('get_file_metadata', {
    request: { path, remoteConnectionId: '' },
  });
  return {
    path: String(raw.path ?? path),
    modified: Number(raw.modified ?? 0),
    size: Number(raw.size ?? 0),
    isFile: raw.isFile === true,
    isDir: raw.isDir === true,
    isSymlink: typeof raw.isSymlink === 'boolean' ? raw.isSymlink : undefined,
  };
}

export async function readControllerFileBytes(path: string): Promise<Uint8Array> {
  const base64 = await controllerHost().request<string>('read_file_content', {
    request: { filePath: path, encoding: 'base64', remoteConnectionId: '' },
  });
  return decodeBase64(base64);
}

/** Immediate children of a controller directory. */
export async function listControllerDirectory(path: string): Promise<ExplorerNodeDto[]> {
  const children = await controllerHost().request<ExplorerNodeDto[]>('get_directory_children', {
    request: { path, remoteConnectionId: '' },
  });
  return Array.isArray(children) ? children : [];
}

/** File paths on this controller's OS clipboard, not on the rendered device. */
export async function getControllerClipboardFiles(): Promise<{ files: string[]; isCut: boolean }> {
  const result = await controllerHost().request<{ files?: string[]; isCut?: boolean }>(
    'get_clipboard_files',
  );
  return {
    files: Array.isArray(result?.files) ? result.files : [],
    isCut: result?.isCut === true,
  };
}

/** Image on this controller's OS clipboard, or null when it holds none. */
export async function getControllerClipboardImage(): Promise<{ base64: string; mimeType: string } | null> {
  const response = await controllerHost().request<{ base64?: string; mimeType?: string } | null>(
    'get_clipboard_image',
  );
  return response?.base64 && response.mimeType
    ? { base64: response.base64, mimeType: response.mimeType }
    : null;
}

export interface UploadBytesToHostOptions {
  bytes: Uint8Array;
  /** Destination as the execution host resolves it for `workspaceId`. */
  path: string;
  workspaceId: string;
  /** Throw once the target changed; checked around every host call. */
  assertCurrent: () => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** SHA-256 of the existing destination; omitted means create a new file only. */
  expectedHash?: string;
}

interface UploadStatus {
  transferId: string;
  nextOffset: number;
  totalBytes: number;
  completed: boolean;
}

/**
 * Publish bytes on the rendered execution host.
 *
 * The host verifies the SHA-256 digest and, because the expected hash is
 * empty by default, refuses to replace an existing file. A supplied expected
 * hash permits replacing only that exact destination version. An unknown append outcome is
 * resolved from the host cursor before any byte is resent.
 */
export async function uploadBytesToHost(options: UploadBytesToHostOptions): Promise<void> {
  const { bytes } = options;
  const transferId = randomHex(32);
  const identity = { transferId, path: options.path, workspaceId: options.workspaceId };
  const call = async (args: Record<string, unknown>): Promise<UploadStatus> => {
    options.assertCurrent();
    const status = await api.invoke<UploadStatus>('workspace_file_upload', {
      request: { ...identity, ...args },
    });
    options.assertCurrent();
    if (
      status?.transferId !== transferId
      || status.totalBytes !== bytes.byteLength
      || !Number.isSafeInteger(status.nextOffset)
      || status.nextOffset < 0
      || status.nextOffset > bytes.byteLength
    ) {
      throw new Error('Invalid upload cursor from the execution host');
    }
    return status;
  };

  let status = await call({
    action: 'begin',
    totalBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    expectedHash: options.expectedHash ?? '',
  });
  try {
    options.onProgress?.(status.nextOffset, bytes.byteLength);
    while (!status.completed && status.nextOffset < bytes.byteLength) {
      const offset = status.nextOffset;
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
      try {
        status = await call({ action: 'append', offset, contentBase64: encodeBase64(chunk) });
      } catch (error) {
        const resolved = await call({ action: 'status' });
        if (resolved.nextOffset === offset) throw error;
        status = resolved;
      }
      if (status.nextOffset <= offset) {
        throw new Error('Upload made no progress');
      }
      options.onProgress?.(status.nextOffset, bytes.byteLength);
    }
    if (!status.completed) {
      status = await call({ action: 'finish' });
    }
  } catch (error) {
    // Release the staged bytes; the cancel outcome does not change the error.
    void api.invoke('workspace_file_upload', {
      request: { ...identity, action: 'cancel' },
    }).catch(() => undefined);
    throw error;
  }
  if (!status.completed || status.nextOffset !== bytes.byteLength) {
    throw new Error('Upload is incomplete');
  }
}

export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}
