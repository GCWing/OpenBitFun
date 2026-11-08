/**
 * Controller-side file IO for composer attachments.
 *
 * When the session executes on another host (Peer Device Mode), on a remote
 * workspace, or as a detached job, a path dropped or pasted into the composer
 * belongs to this controller. These helpers read such files on the controller
 * itself and, when the execution host supports it, stage them in that host's
 * runtime `attachments/` directory so its agent tools can open them.
 */
import { createTransportAdapter, type ITransportAdapter } from '@/infrastructure/api/adapters';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type { FileMetadata } from '@/infrastructure/api/service-api/WorkspaceAPI';
import {
  isLocalSurface,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import type { ImageContext } from '@/shared/types/context';
import { controllerAttachmentFileName } from './externalFileIntake';
import { createImageContextFromFile, getMimeTypeFromFilename } from './imageUtils';

/** Bounded so an accidental large drop cannot stall the relay or the host. */
export const MAX_CONTROLLER_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Matches the host's bounded `workspace_file_upload` chunk with headroom. */
const UPLOAD_CHUNK_BYTES = 1024 * 1024;

let controllerAdapter: ITransportAdapter | null = null;

/**
 * The controller's own Tauri host. The registered transport follows the
 * rendered device, so a controller path must never go through it in Peer
 * Device Mode. An explicit empty connection id is the local-provider marker,
 * so a path that collides with a registered remote root still reads locally.
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

async function readControllerFileBytes(path: string): Promise<Uint8Array> {
  const base64 = await controllerHost().request<string>('read_file_content', {
    request: { filePath: path, encoding: 'base64', remoteConnectionId: '' },
  });
  return decodeBase64(base64);
}

/** Clipboard file paths of this controller, not of the rendered device. */
export async function getControllerClipboardFiles(): Promise<string[]> {
  const result = await controllerHost().request<{ files?: string[] }>('get_clipboard_files');
  return Array.isArray(result?.files) ? result.files : [];
}

/** Clipboard image of this controller, or null when it holds no image. */
export async function getControllerClipboardImage(): Promise<{ base64: string; mimeType: string } | null> {
  const response = await controllerHost().request<{ base64?: string; mimeType?: string } | null>(
    'get_clipboard_image',
  );
  return response?.base64 && response.mimeType
    ? { base64: response.base64, mimeType: response.mimeType }
    : null;
}

/** Read a controller image into an inline (pixel-carrying) image context. */
export async function readControllerImageContext(
  path: string,
  name: string,
): Promise<ImageContext> {
  const bytes = await readControllerFileBytes(path);
  const file = new File([bytes as BlobPart], name, { type: getMimeTypeFromFilename(name) });
  const context = await createImageContextFromFile(file);
  if (!context.dataUrl) {
    throw new Error('Image pixels could not be read');
  }
  return { ...context, isLocal: false, imagePath: '' };
}

/**
 * Whether the execution host of the given surface accepts controller files.
 * The local surface is this build; a peer must have negotiated the capability.
 */
export function canUploadControllerFiles(scope: SurfaceScope): boolean {
  if (isLocalSurface(scope.surfaceId)) return true;
  return peerConnectionManager.get(scope.surfaceId)?.getState()
    .capabilities.runtimeAttachmentUploadV1 === true;
}

export interface UploadControllerFileOptions {
  path: string;
  name: string;
  /** Workspace record the session executes in; scopes the runtime URI. */
  workspaceId: string;
  scope: SurfaceScope;
  isCurrent: () => boolean;
}

interface UploadStatus {
  transferId: string;
  nextOffset: number;
  totalBytes: number;
  completed: boolean;
}

/**
 * Stage a controller file on the execution host and return the runtime URI
 * its agent tools resolve. Every host call is checked against the surface
 * scope captured by the caller so a device switch never redirects the bytes.
 */
export async function uploadControllerFileToRuntime(
  options: UploadControllerFileOptions,
): Promise<string> {
  const bytes = await readControllerFileBytes(options.path);
  if (bytes.byteLength > MAX_CONTROLLER_ATTACHMENT_BYTES) {
    throw new Error('File is too large to send');
  }
  const transferId = randomHex(32);
  const hostPath = buildRuntimeAttachmentUri(
    options.workspaceId,
    randomHex(8),
    controllerAttachmentFileName(options.name),
  );
  const sha256 = await sha256Hex(bytes);
  const assertCurrent = () => {
    options.scope.assertCurrent('upload composer attachment');
    if (!options.isCurrent()) throw new Error('Composer target changed');
  };
  const identity = {
    transferId,
    path: hostPath,
    workspaceId: options.workspaceId,
  };
  const call = async (args: Record<string, unknown>): Promise<UploadStatus> => {
    assertCurrent();
    const status = await api.invoke<UploadStatus>('workspace_file_upload', {
      request: { ...identity, ...args },
    });
    assertCurrent();
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
    sha256,
    // Empty: the unique destination must not exist yet.
    expectedHash: '',
  });
  try {
    while (!status.completed && status.nextOffset < bytes.byteLength) {
      const offset = status.nextOffset;
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
      try {
        status = await call({ action: 'append', offset, contentBase64: encodeBase64(chunk) });
      } catch (error) {
        // An unknown acknowledgement is resolved from the host cursor.
        const resolved = await call({ action: 'status' });
        if (resolved.nextOffset === offset) throw error;
        status = resolved;
      }
      if (status.nextOffset <= offset) {
        throw new Error('Upload made no progress');
      }
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
  return hostPath;
}

export function buildRuntimeAttachmentUri(
  workspaceId: string,
  uploadId: string,
  fileName: string,
): string {
  return `openbitfun://runtime/${workspaceId}/attachments/${uploadId}/${fileName}`;
}

function randomHex(byteCount: number): string {
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
