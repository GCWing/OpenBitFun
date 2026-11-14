import type { FileMetadata } from '@/infrastructure/api/service-api/WorkspaceAPI';
import type { ContextItem, DirectoryContext, FileContext, ImageContext } from '@/shared/types/context';
import { repositoryPathKey } from '@/shared/utils/pathUtils';
import { getMimeTypeFromFilename, isImageFile } from './imageUtils';

export type ExternalFileSource = 'drop' | 'clipboard';

export type ExternalFileIntakeUnavailableReason =
  | 'web'
  | 'remote-workspace'
  | 'peer-device'
  | 'detached-dispatch';

export interface ExternalFileIntakeEnvironment {
  desktopRuntime: boolean;
  remoteWorkspace: boolean;
  peerDevice: boolean;
  detachedDispatch: boolean;
}

export type ExternalFileIntakeAvailability =
  | { supported: true }
  | { supported: false; reason: ExternalFileIntakeUnavailableReason };

export interface ExternalFileIntakeFailure {
  path: string;
  reason:
    | 'metadata'
    | 'invalid-path'
    | 'image-limit'
    /** A controller folder cannot be staged on another execution host. */
    | 'directory'
    /** The execution host cannot receive controller files. */
    | 'file-unsupported'
    | 'too-large'
    | 'read'
    | 'upload';
  detail?: string;
}

export interface BuildExternalFileContextsOptions {
  source: ExternalFileSource;
  paths: string[];
  existingContexts: ContextItem[];
  workspacePath?: string;
  maxImageCount: number;
  loadMetadata: (path: string) => Promise<FileMetadata>;
}

export interface ExternalFileIntakeResult {
  contexts: Array<FileContext | DirectoryContext | ImageContext>;
  failures: ExternalFileIntakeFailure[];
  duplicateCount: number;
}

export interface ExternalFileDropPayload {
  paths: string[];
  fallbackImages: File[];
  hasUnavailableFiles: boolean;
}

export function resolveExternalFileIntakeAvailability(
  environment: ExternalFileIntakeEnvironment,
): ExternalFileIntakeAvailability {
  if (!environment.desktopRuntime) return { supported: false, reason: 'web' };
  if (environment.remoteWorkspace) return { supported: false, reason: 'remote-workspace' };
  if (environment.peerDevice) return { supported: false, reason: 'peer-device' };
  if (environment.detachedDispatch) return { supported: false, reason: 'detached-dispatch' };
  return { supported: true };
}

export function normalizeExternalFilePath(path: string): string {
  return repositoryPathKey(path);
}

/**
 * Whether a paste event should fall back to a native host clipboard read.
 *
 * WebKitGTK (the Linux webview) delivers paste events with NO DataTransfer
 * types or items at all, so the in-page file branch can never see a pasted
 * image. Engines that report any types (WebView2, WKWebView, Chromium)
 * deliver clipboard images in-band, so only fully empty-typed pastes use the
 * host fallback.
 */
export function shouldAttemptNativeClipboardImageRead(
  types: ReadonlyArray<string>,
): boolean {
  return types.length === 0;
}

/**
 * The controller path a context was attached from. Controller files staged on
 * another host carry a runtime path of that host, so duplicate detection keys
 * by the path the user dropped instead.
 */
export function getContextExternalSourcePath(context: ContextItem): string | undefined {
  const sourcePath = context.metadata?.controllerSourcePath;
  if (typeof sourcePath === 'string' && sourcePath) return sourcePath;
  return getContextLocalPath(context);
}

export function getContextLocalPath(context: ContextItem): string | undefined {
  if (context.type === 'file') return context.filePath;
  if (context.type === 'directory') return context.directoryPath;
  if (context.type === 'image' && context.isLocal && context.imagePath) return context.imagePath;
  return undefined;
}

export function partitionExternalDropFiles(
  files: File[],
  acceptLocalPaths: boolean,
): ExternalFileDropPayload {
  const filePath = (file: File) => (file as File & { path?: string }).path?.trim() ?? '';
  const paths = files.map(filePath).filter(Boolean);
  const pathSet = new Set(paths);
  return {
    paths,
    fallbackImages: files.filter(file => (
      file.type.startsWith('image/')
      && (!acceptLocalPaths || !pathSet.has(filePath(file)))
    )),
    hasUnavailableFiles: files.length === 0 || files.some(file => (
      !file.type.startsWith('image/') && !pathSet.has(filePath(file))
    )),
  };
}

function normalizeExternalPathSpelling(path: string): string {
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path);
  let normalized = isWindowsPath ? path.replace(/\\/g, '/') : path;
  while (normalized.length > 1 && normalized.endsWith('/') && !normalized.endsWith(':/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function getPathName(path: string): string {
  const normalized = normalizeExternalPathSpelling(path);
  return normalized.split('/').pop() || normalized;
}

function getFileMimeType(filename: string): string | undefined {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (!extension || extension === filename.toLowerCase()) return undefined;
  const mimeTypes: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeTypes[extension];
}

function createPathContext(
  path: string,
  name: string,
  isDirectory: boolean,
  workspacePath?: string,
): FileContext | DirectoryContext {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `external-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const timestamp = Date.now();

  if (isDirectory) {
    return {
      id,
      type: 'directory',
      directoryPath: path,
      directoryName: name,
      recursive: true,
      timestamp,
    };
  }

  const normalizedWorkspace = workspacePath
    ? normalizeExternalPathSpelling(workspacePath)
    : undefined;
  const normalizedPath = normalizeExternalPathSpelling(path);
  const workspaceKey = normalizedWorkspace
    ? normalizeExternalFilePath(normalizedWorkspace)
    : undefined;
  const pathKey = normalizeExternalFilePath(normalizedPath);
  const workspacePrefix = workspaceKey
    ? (workspaceKey.endsWith('/') ? workspaceKey : `${workspaceKey}/`)
    : undefined;
  const relativeStart = normalizedWorkspace
    ? normalizedWorkspace.length + (normalizedWorkspace.endsWith('/') ? 0 : 1)
    : 0;
  const relativePath = workspacePrefix && pathKey.startsWith(workspacePrefix)
    ? normalizedPath.slice(relativeStart)
    : undefined;
  return {
    id,
    type: 'file',
    filePath: path,
    fileName: name,
    relativePath,
    timestamp,
  };
}

function withExternalMetadata<T extends FileContext | DirectoryContext>(
  context: T,
  source: ExternalFileSource,
  metadata: FileMetadata,
): T {
  return {
    ...context,
    ...(context.type === 'file'
      ? { fileSize: metadata.size, mimeType: getFileMimeType(context.fileName) }
      : {}),
    metadata: {
      ...context.metadata,
      externalLocal: true,
      externalFileSource: source,
      isSymlink: Boolean(metadata.isSymlink),
    },
  };
}

export async function buildExternalFileContexts(
  options: BuildExternalFileContextsOptions,
): Promise<ExternalFileIntakeResult> {
  const seen = externalSourcePathKeys(options.existingContexts);
  let imageCount = options.existingContexts.filter((context) => context.type === 'image').length;
  const contexts: ExternalFileIntakeResult['contexts'] = [];
  const failures: ExternalFileIntakeFailure[] = [];
  let duplicateCount = 0;

  for (const path of options.paths) {
    const normalizedPath = normalizeExternalFilePath(path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalizedPath);

    let metadata: FileMetadata;
    try {
      metadata = await options.loadMetadata(path);
    } catch {
      failures.push({ path, reason: 'metadata' });
      continue;
    }

    if (!metadata.isFile && !metadata.isDir) {
      failures.push({ path, reason: 'invalid-path' });
      continue;
    }

    const name = getPathName(path);
    if (metadata.isFile && isImageFile(name)) {
      if (imageCount >= options.maxImageCount) {
        failures.push({ path, reason: 'image-limit' });
        continue;
      }
      imageCount += 1;
      contexts.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'image',
        imagePath: path,
        imageName: name,
        fileSize: metadata.size,
        mimeType: getMimeTypeFromFilename(name),
        source: 'file',
        isLocal: true,
        timestamp: Date.now(),
        metadata: {
          externalLocal: true,
          externalFileSource: options.source,
          isSymlink: Boolean(metadata.isSymlink),
          isImage: true,
        },
      });
      continue;
    }

    contexts.push(
      withExternalMetadata(
        createPathContext(path, name, metadata.isDir, options.workspacePath),
        options.source,
        metadata,
      ),
    );
  }

  return { contexts, failures, duplicateCount };
}

function externalSourcePathKeys(contexts: ContextItem[]): Set<string> {
  return new Set(
    contexts
      .map(getContextExternalSourcePath)
      .filter((path): path is string => Boolean(path))
      .map(normalizeExternalFilePath),
  );
}

/** Image extensions the composer can send as inline pixels. */
const INLINE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function isInlineImageName(name: string): boolean {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return extension !== name.toLowerCase() && INLINE_IMAGE_EXTENSIONS.has(extension);
}

export interface BuildControllerFileContextsOptions {
  source: ExternalFileSource;
  paths: string[];
  existingContexts: ContextItem[];
  maxImageCount: number;
  /** Largest non-image file sent to the execution host. */
  maxFileBytes: number;
  /** Metadata read on the controller, never on the execution host. */
  loadMetadata: (path: string) => Promise<FileMetadata>;
  /** Read controller image pixels into an inline image context. */
  readImage: (path: string, name: string, metadata: FileMetadata) => Promise<ImageContext>;
  /**
   * Stage a controller file on the execution host and return the path its
   * agent tools resolve. Absent when that host cannot receive files.
   */
  uploadFile?: (path: string, name: string, metadata: FileMetadata) => Promise<string>;
  /** Stop before further host work once the composer target changed. */
  isCurrent?: () => boolean;
}

/**
 * Attach controller files to a session whose execution host cannot read the
 * controller filesystem (Peer Device, remote workspace, detached dispatch).
 *
 * Images travel as inline pixels, which every execution host already accepts.
 * Other files are staged on the execution host when it supports that. A path
 * of this controller is never sent as a reference: the host would resolve it
 * against its own filesystem.
 */
export async function buildControllerFileContexts(
  options: BuildControllerFileContextsOptions,
): Promise<ExternalFileIntakeResult> {
  const seen = externalSourcePathKeys(options.existingContexts);
  let imageCount = options.existingContexts.filter((context) => context.type === 'image').length;
  const contexts: ExternalFileIntakeResult['contexts'] = [];
  const failures: ExternalFileIntakeFailure[] = [];
  let duplicateCount = 0;
  const isCurrent = options.isCurrent ?? (() => true);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  for (const path of options.paths) {
    if (!isCurrent()) break;
    const normalizedPath = normalizeExternalFilePath(path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalizedPath);

    let metadata: FileMetadata;
    try {
      metadata = await options.loadMetadata(path);
    } catch {
      failures.push({ path, reason: 'metadata' });
      continue;
    }
    if (metadata.isDir) {
      failures.push({ path, reason: 'directory' });
      continue;
    }
    if (!metadata.isFile) {
      failures.push({ path, reason: 'invalid-path' });
      continue;
    }

    const name = getPathName(path);
    if (isInlineImageName(name)) {
      if (imageCount >= options.maxImageCount) {
        failures.push({ path, reason: 'image-limit' });
        continue;
      }
      try {
        const image = await options.readImage(path, name, metadata);
        imageCount += 1;
        contexts.push({
          ...image,
          metadata: {
            ...image.metadata,
            controllerSourcePath: path,
            externalFileSource: options.source,
          },
        });
      } catch (error) {
        failures.push({ path, reason: 'read', detail: errorText(error) });
      }
      continue;
    }

    if (!options.uploadFile) {
      failures.push({ path, reason: 'file-unsupported' });
      continue;
    }
    if (metadata.size > options.maxFileBytes) {
      failures.push({ path, reason: 'too-large' });
      continue;
    }
    let hostPath: string;
    try {
      hostPath = await options.uploadFile(path, name, metadata);
    } catch (error) {
      failures.push({ path, reason: 'upload', detail: errorText(error) });
      continue;
    }
    const context = createPathContext(hostPath, name, false) as FileContext;
    contexts.push({
      ...context,
      fileSize: metadata.size,
      mimeType: getFileMimeType(name),
      metadata: {
        ...context.metadata,
        controllerSourcePath: path,
        controllerUpload: true,
        externalFileSource: options.source,
      },
    });
  }

  return { contexts, failures, duplicateCount };
}

/**
 * File name safe to use as one runtime path segment on any host OS. The
 * original name stays visible on the context pill.
 */
export function controllerAttachmentFileName(name: string): string {
  const cleaned = Array.from(name.trim())
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '/\\:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '_')
    .slice(0, 180);
  return cleaned || 'attachment';
}
