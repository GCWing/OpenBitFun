/**
 * Upload / download between workspace (local or remote SFTP) and local disk.
 */

import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { sshApi } from "@/features/ssh-remote/sshApi";
import { workspaceAPI } from "@/infrastructure/api";
import { createTransportAdapter, getTransportAdapter } from "@/infrastructure/api/adapters";
import {
  PeerDeviceTransportAdapter,
  type PeerDeviceCommandResponse,
} from "@/infrastructure/api/adapters/peer-device-adapter";
import { i18nService } from "@/infrastructure/i18n";
import { isRemoteWorkspace, type WorkspaceInfo } from "@/shared/types";
import {
  dirnameAbsolutePath,
  normalizeLocalPathForRename,
  normalizePath,
  normalizeRemoteWorkspacePath,
  pathsEquivalentFs,
} from "@/shared/utils/pathUtils";

export type TransferPhase = "download" | "upload";

export interface TransferProgressState {
  phase: TransferPhase;
  current: number;
  total: number;
  label: string;
  /** No byte-level progress from backend — show indeterminate bar */
  indeterminate?: boolean;
  /** Bytes transferred so far (for byte-level progress) */
  bytesTransferred?: number;
  /** Total file size in bytes */
  bytesTotal?: number;
  /** Transfer speed in bytes per second (smoothed) */
  speed?: number;
}

export interface WorkspaceTransferResult {
  successCount: number;
  directoryCount: number;
  failedFiles: Array<{ path: string; error: string }>;
}

export interface UploadToWorkspaceOptions {
  isCut?: boolean;
}

const PEER_FILE_CHUNK_BYTES = 1024 * 1024;

interface PeerFileInfoResponse extends PeerDeviceCommandResponse {
  resp: "file_info";
  name: string;
  size: number;
  mime_type: string;
}

interface PeerFileChunkResponse extends PeerDeviceCommandResponse {
  resp: "file_chunk";
  name: string;
  chunk_base64: string;
  offset: number;
  chunk_size: number;
  total_size: number;
  mime_type: string;
  revision: string;
}

interface PeerDownloadEntry {
  sourcePath: string;
  destinationPath: string;
  size: number;
  name: string;
}

export function decodeBase64FileChunk(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isSafePeerTransferEntryName(name: string): boolean {
  return Boolean(
    name &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0"),
  );
}

function currentPeerAdapter(): PeerDeviceTransportAdapter | null {
  const adapter = getTransportAdapter();
  return adapter instanceof PeerDeviceTransportAdapter ? adapter : null;
}

export async function writeAllToLocalFile(
  destinationPath: string,
  chunks: AsyncIterable<Uint8Array>,
  onChunkWritten: (bytes: number) => void,
): Promise<void> {
  // The local sink must remain reachable for cleanup after peer logout.
  const adapter = createTransportAdapter("tauri");
  const send = (request: Record<string, unknown>) =>
    adapter.request<{id: number}>("local_file_download", { request });
  const { id } = await send({ action: "begin", destination: destinationPath });
  let offset = 0;
  try {
    for await (const chunk of chunks) {
      await send({ action: "write", id, offset, bytes: Array.from(chunk) });
      offset += chunk.byteLength;
      onChunkWritten(chunk.byteLength);
    }
    await send({ action: "finish", id, size: offset });
  } catch (error) {
    await send({ action: "cancel", id }).catch(() => undefined);
    throw error;
  }
}

export interface PeerFileWorkspaceIdentity {
  workspace_id: string;
  workspace_path: string;
  remote_connection_id?: string;
}

export async function* readPeerFileChunks(
  adapter: PeerDeviceTransportAdapter,
  sourcePath: string,
  onFileSize: (size: number) => void,
  identity: PeerFileWorkspaceIdentity,
): AsyncGenerator<Uint8Array, number> {
  const info = await adapter.requestPeerCommand<PeerFileInfoResponse>({
    cmd: "get_file_info",
    path: sourcePath,
    session_id: null,
    ...identity,
  });
  if (info.resp !== "file_info" || !Number.isSafeInteger(info.size) || info.size < 0) {
    throw new Error(`Invalid peer file info response for '${sourcePath}'`);
  }
  onFileSize(info.size);

  let offset = 0;
  let revision: string | undefined;
  while (offset < info.size) {
    const response = await adapter.requestPeerCommand<PeerFileChunkResponse>({
      cmd: "read_file_chunk",
      path: sourcePath,
      session_id: null,
      ...identity,
      offset,
      limit: PEER_FILE_CHUNK_BYTES,
    });
    if (
      response.resp !== "file_chunk" ||
      response.offset !== offset ||
      !Number.isSafeInteger(response.chunk_size) ||
      response.chunk_size < 0 ||
      !Number.isSafeInteger(response.total_size) ||
      response.total_size !== info.size ||
      response.chunk_size > Math.min(PEER_FILE_CHUNK_BYTES, info.size - offset)
    ) {
      throw new Error(`Invalid peer file chunk response for '${sourcePath}'`);
    }
    if (typeof response.revision !== "string" || !response.revision || (revision !== undefined && revision !== response.revision)) {
      throw new Error("Peer file changed during download");
    }
    revision = response.revision;
    const bytes = decodeBase64FileChunk(response.chunk_base64);
    if (
      bytes.byteLength !== response.chunk_size ||
      bytes.byteLength === 0 ||
      offset + bytes.byteLength > info.size
    ) {
      throw new Error(`Incomplete peer file chunk for '${sourcePath}' at offset ${offset}`);
    }
    offset += bytes.byteLength;
    yield bytes;
  }
  return info.size;
}

async function collectPeerDirectoryEntries(
  sourceDirectory: string,
  destinationDirectory: string,
  remoteConnectionId?: string,
): Promise<PeerDownloadEntry[]> {
  const { mkdir } = await import("@tauri-apps/plugin-fs");
  const pending = [{ source: sourceDirectory, destination: destinationDirectory }];
  const files: PeerDownloadEntry[] = [];

  while (pending.length > 0) {
    const current = pending.shift()!;
    await mkdir(current.destination, { recursive: true });
    const children = await workspaceAPI.getDirectoryChildren(current.source, remoteConnectionId ?? '');
    for (const child of children) {
      if (!isSafePeerTransferEntryName(child.name)) {
        throw new Error(`Unsafe peer file name: '${child.name}'`);
      }
      const destinationPath = joinWorkspaceTargetPath(
        current.destination,
        child.name,
        false,
      );
      if (child.isDirectory) {
        pending.push({ source: child.path, destination: destinationPath });
      } else {
        files.push({
          sourcePath: child.path,
          destinationPath,
          size: typeof child.size === "number" && child.size >= 0 ? child.size : 0,
          name: child.name,
        });
      }
    }
  }

  return files;
}

async function downloadPeerWorkspacePathToDisk(
  adapter: PeerDeviceTransportAdapter,
  sourcePath: string,
  destinationPath: string,
  workspace: WorkspaceInfo | null,
  isDirectory: boolean,
  onProgress: (state: TransferProgressState | null) => void,
): Promise<void> {
  if (!workspace?.id) throw new Error("A fixed peer workspace is required for download");
  if (isRemoteWorkspace(workspace) && !workspace.connectionId) {
    throw new Error(i18nService.t("panels/files:transfer.missingConnection"));
  }
  // The peer selects the workspace by ID. The root path and connection are
  // the legacy projection that pre-ID peer hosts still require.
  const identity: PeerFileWorkspaceIdentity = {
    workspace_id: workspace.id,
    workspace_path: workspace.rootPath,
    remote_connection_id: isRemoteWorkspace(workspace) ? workspace.connectionId : undefined,
  };
  const entries = isDirectory
    ? await collectPeerDirectoryEntries(sourcePath, destinationPath, identity.remote_connection_id)
    : [{
        sourcePath,
        destinationPath,
        size: 0,
        name: sourcePath.split(/[/\\]/).pop() || "file",
      }];
  let bytesTransferred = 0;
  let bytesTotal = entries.reduce((sum, entry) => sum + entry.size, 0);
  let lastTime = performance.now();
  let lastBytes = 0;
  let smoothedSpeed = 0;

  for (const entry of entries) {
    const entryStart = bytesTransferred;
    let entryWritten = 0;
    let expectedEntrySize = entry.size;
    const updateExpectedEntrySize = (size: number) => {
      bytesTotal += size - expectedEntrySize;
      expectedEntrySize = size;
    };
    const chunks = readPeerFileChunks(adapter, entry.sourcePath, updateExpectedEntrySize, identity);
    await writeAllToLocalFile(entry.destinationPath, chunks, (written) => {
      entryWritten += written;
      bytesTransferred = entryStart + entryWritten;
      if (expectedEntrySize === 0 && entryWritten > 0) {
        bytesTotal = Math.max(bytesTotal, bytesTransferred);
      }
      const now = performance.now();
      const elapsed = now - lastTime;
      const byteDelta = bytesTransferred - lastBytes;
      if (elapsed > 0 && byteDelta > 0) {
        const instantSpeed = (byteDelta / elapsed) * 1000;
        smoothedSpeed = smoothedSpeed === 0
          ? instantSpeed
          : smoothedSpeed * 0.7 + instantSpeed * 0.3;
      }
      lastTime = now;
      lastBytes = bytesTransferred;
      onProgress({
        phase: "download",
        current: bytesTransferred,
        total: Math.max(bytesTotal, bytesTransferred, 1),
        label: entry.name,
        indeterminate: bytesTotal === 0,
        bytesTransferred,
        bytesTotal: Math.max(bytesTotal, bytesTransferred),
        speed: smoothedSpeed,
      });
    });
    bytesTransferred = entryStart + entryWritten;
  }

  onProgress({
    phase: "download",
    current: Math.max(bytesTransferred, 1),
    total: Math.max(bytesTransferred, 1),
    label: sourcePath.split(/[/\\]/).pop() || "file",
    indeterminate: false,
    bytesTransferred,
    bytesTotal: bytesTransferred,
    speed: smoothedSpeed,
  });
}

function normalizeClipboardLocalPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }

  let normalized: string;

  if (trimmed.startsWith("file://")) {
    normalized = normalizePath(trimmed);
    // file:///absolute/unix/path loses its leading slash in normalizePath.
    if (
      /^file:\/\/\/(?!\/)/.test(trimmed) &&
      !/^[A-Za-z]:/.test(normalized) &&
      !normalized.startsWith("/")
    ) {
      normalized = `/${normalized}`;
    }
  } else if (trimmed.startsWith("\\\\")) {
    // UNC paths — return as-is (do not strip trailing backslash).
    return trimmed;
  } else {
    normalized = normalizeLocalPathForRename(trimmed);
  }

  // Strip trailing slashes so that directory names are not empty when
  // extracted via split(/[/\\]/).pop(). macOS `POSIX path of` returns a
  // trailing slash for directories (e.g. /Users/test/myfolder/).
  // Preserve root paths like "/" and "C:/".
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
    // For Windows drive roots like "C:/", keep the slash.
    if (/^[A-Za-z]:$/.test(normalized)) {
      normalized = `${normalized}/`;
    }
  }

  return normalized;
}

export function normalizeClipboardLocalPaths(paths: string[]): string[] {
  const normalized: string[] = [];

  for (const path of paths) {
    const next = normalizeClipboardLocalPath(path);
    if (
      !next ||
      normalized.some((existing) => pathsEquivalentFs(existing, next))
    ) {
      continue;
    }
    normalized.push(next);
  }

  return normalized;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export function resolvePasteTargetDirectory<
  T extends { path: string; isDirectory: boolean; children?: T[] },
>(options: {
  workspacePath: string;
  explicitTargetDir?: string;
  selectedFile?: string;
  fileTree: T[];
  findNode: (nodes: T[], path: string) => T | null;
}): string {
  if (options.explicitTargetDir) {
    return options.explicitTargetDir;
  }

  const targetDirectory = options.workspacePath;
  if (!options.selectedFile) {
    return targetDirectory;
  }

  const selectedNode = options.findNode(options.fileTree, options.selectedFile);
  if (!selectedNode) {
    return targetDirectory;
  }

  if (selectedNode.isDirectory) {
    return selectedNode.path;
  }

  return dirnameAbsolutePath(selectedNode.path) || targetDirectory;
}

export function normalizeWorkspaceTargetDirectory(
  targetDirectory: string,
  workspace: WorkspaceInfo | null,
): string {
  if (isRemoteWorkspace(workspace)) {
    return normalizeRemoteWorkspacePath(targetDirectory);
  }
  return normalizeLocalPathForRename(targetDirectory);
}

export function joinWorkspaceTargetPath(
  dir: string,
  fileName: string,
  remote = false,
): string {
  const sep = remote ? "/" : dir.includes("\\") ? "\\" : "/";
  const base = remote
    ? normalizeRemoteWorkspacePath(dir)
    : dir.replace(/[/\\]+$/, "");
  return `${base}${sep}${fileName}`;
}

export function resolveExplorerDropTargetDirectory(
  clientX: number,
  clientY: number,
  workspacePath: string,
  boundary?: HTMLElement | null,
): string {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) {
    return workspacePath;
  }

  const explorer = boundary ?? el.closest(".openbitfun-file-explorer");
  if (!explorer) {
    return workspacePath;
  }

  if (!explorer.contains(el)) {
    return workspacePath;
  }

  const node = el.closest("[data-file-path]");
  if (!node || !explorer.contains(node)) {
    return workspacePath;
  }

  const path = node.getAttribute("data-file-path");
  if (!path) {
    return workspacePath;
  }
  const isDir = node.getAttribute("data-is-directory") === "true";
  if (isDir) {
    return path;
  }
  return dirnameAbsolutePath(path) || workspacePath;
}

function dragPositionToLogicalCandidates(
  position: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number }[] {
  const logical = new PhysicalPosition(position.x, position.y).toLogical(
    scaleFactor,
  );
  return [
    { x: logical.x, y: logical.y },
    { x: position.x, y: position.y },
    { x: position.x / scaleFactor, y: position.y / scaleFactor },
  ];
}

/**
 * Tauri emits physical pixel positions; `elementFromPoint` / `getBoundingClientRect` use logical CSS pixels.
 * Try a few conversions because platform / overlay titlebars can differ.
 */
export function resolveDropTargetDirectoryFromDragPosition(
  position: { x: number; y: number },
  scaleFactor: number,
  workspacePath: string,
  boundary?: HTMLElement | null,
): string {
  for (const { x, y } of dragPositionToLogicalCandidates(
    position,
    scaleFactor,
  )) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    const hit = document.elementFromPoint(x, y);
    const explorer = boundary ?? hit?.closest(".openbitfun-file-explorer");
    if (!explorer) {
      continue;
    }

    if (hit && !explorer.contains(hit)) {
      continue;
    }

    return resolveExplorerDropTargetDirectory(
      x,
      y,
      workspacePath,
      explorer as HTMLElement,
    );
  }

  return workspacePath;
}

export function isDragPositionOverElement(
  position: { x: number; y: number },
  scaleFactor: number,
  element: HTMLElement | null,
): boolean {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  for (const { x, y } of dragPositionToLogicalCandidates(
    position,
    scaleFactor,
  )) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    if (
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

export async function downloadWorkspaceFileToDisk(
  filePath: string,
  workspace: WorkspaceInfo | null,
  onProgress: (state: TransferProgressState | null) => void,
  transferId?: string,
  isDirectory?: boolean,
): Promise<void> {
  if (!isTauri()) {
    throw new Error(i18nService.t("common:ssh.remote.transferNeedsDesktop"));
  }
  const baseName = filePath.split(/[/\\]/).pop() || "file";
  let dest: string | null;

  if (isDirectory) {
    // For directory downloads, ask the user to pick a destination folder,
    // then append the folder name so the tree is recreated under it.
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      title: i18nService.t("common:file.downloadSaveTitle"),
      directory: true,
      recursive: true,
    });
    if (picked === null) {
      return;
    }
    dest = joinWorkspaceTargetPath(picked, baseName, false);
  } else {
    const { save } = await import("@tauri-apps/plugin-dialog");
    dest = await save({
      title: i18nService.t("common:file.downloadSaveTitle"),
      defaultPath: baseName,
    });
  }
  if (dest === null) {
    return;
  }

  onProgress({
    phase: "download",
    current: 0,
    total: 1,
    label: baseName,
    indeterminate: true,
  });
  try {
    const peerAdapter = currentPeerAdapter();
    if (peerAdapter) {
      await downloadPeerWorkspacePathToDisk(
        peerAdapter,
        filePath,
        dest,
        workspace,
        Boolean(isDirectory),
        onProgress,
      );
    } else if (isRemoteWorkspace(workspace)) {
      const cid = workspace?.connectionId;
      if (!cid) {
        throw new Error(
          i18nService.t("panels/files:transfer.missingConnection"),
        );
      }

      // Speed tracking state — EMA over per-event instantaneous speed.
      let lastTime = 0;
      let lastBytes = 0;
      let smoothedSpeed = 0;
      let isFirstEvent = true;

      await sshApi.downloadToLocalPath(cid, filePath, dest, (downloaded, total) => {
        const now = performance.now();

        if (!isFirstEvent && now > lastTime) {
          const elapsed = now - lastTime;
          const bytesDiff = downloaded - lastBytes;
          if (elapsed > 0 && bytesDiff > 0) {
            const instantSpeed = (bytesDiff / elapsed) * 1000; // bytes/sec
            smoothedSpeed = smoothedSpeed === 0
              ? instantSpeed
              : smoothedSpeed * 0.7 + instantSpeed * 0.3;
          }
        }

        isFirstEvent = false;
        lastTime = now;
        lastBytes = downloaded;

        // If total is 0, file size is unknown — keep indeterminate.
        if (total > 0) {
          onProgress({
            phase: "download",
            current: downloaded,
            total,
            label: baseName,
            indeterminate: false,
            bytesTransferred: downloaded,
            bytesTotal: total,
            speed: smoothedSpeed,
          });
        }
      }, transferId);
    } else {
      await workspaceAPI.exportLocalFileToPath(filePath, dest, workspace?.id);
    }
    onProgress({
      phase: "download",
      current: 1,
      total: 1,
      label: baseName,
      indeterminate: false,
    });
  } finally {
    window.setTimeout(() => onProgress(null), 450);
  }
}

export async function uploadLocalPathsToWorkspaceDirectory(
  localPaths: string[],
  targetDirectory: string,
  workspace: WorkspaceInfo | null,
  onProgress: (state: TransferProgressState | null) => void,
  options: UploadToWorkspaceOptions = {},
  transferId?: string,
): Promise<WorkspaceTransferResult> {
  if (!isTauri()) {
    throw new Error(i18nService.t("common:ssh.remote.transferNeedsDesktop"));
  }

  const normalizedLocalPaths = normalizeClipboardLocalPaths(localPaths);
  if (normalizedLocalPaths.length === 0) {
    return { successCount: 0, directoryCount: 0, failedFiles: [] };
  }

  const remote = isRemoteWorkspace(workspace);
  const normalizedTargetDirectory = normalizeWorkspaceTargetDirectory(
    targetDirectory,
    workspace,
  );
  const isCut = options.isCut ?? false;

  if (remote) {
    const cid = workspace?.connectionId;
    if (!cid) {
      throw new Error(i18nService.t("panels/files:transfer.missingConnection"));
    }

    const failedFiles: WorkspaceTransferResult["failedFiles"] = [];
    let successCount = 0;
    let directoryCount = 0;
    const total = normalizedLocalPaths.length;

    for (let i = 0; i < total; i++) {
      const localPath = normalizedLocalPaths[i]!;
      const name = localPath.split(/[/\\]/).pop();
      if (!name) {
        continue;
      }

      const destPath = joinWorkspaceTargetPath(
        normalizedTargetDirectory,
        name,
        true,
      );

      // For single-item uploads, use byte-level progress from the backend.
      // For multi-item uploads, use count-based progress per item.
      const singleItem = total === 1;

      onProgress({
        phase: "upload",
        current: i,
        total,
        label: singleItem ? name : `${name} (${i + 1}/${total})`,
        indeterminate: singleItem,
      });

      try {
        if (singleItem) {
          // Speed tracking state — EMA over per-event instantaneous speed.
          let lastTime = 0;
          let lastBytes = 0;
          let smoothedSpeed = 0;
          let isFirstEvent = true;

          const uploadResult = await sshApi.uploadFromLocalPath(
            cid,
            localPath,
            destPath,
            (uploaded, totalBytes) => {
              const now = performance.now();

              if (!isFirstEvent && now > lastTime) {
                const elapsed = now - lastTime;
                const bytesDiff = uploaded - lastBytes;
                if (elapsed > 0 && bytesDiff > 0) {
                  const instantSpeed = (bytesDiff / elapsed) * 1000;
                  smoothedSpeed = smoothedSpeed === 0
                    ? instantSpeed
                    : smoothedSpeed * 0.7 + instantSpeed * 0.3;
                }
              }

              isFirstEvent = false;
              lastTime = now;
              lastBytes = uploaded;

              if (totalBytes > 0) {
                onProgress({
                  phase: "upload",
                  current: uploaded,
                  total: totalBytes,
                  label: name,
                  indeterminate: false,
                  bytesTransferred: uploaded,
                  bytesTotal: totalBytes,
                  speed: smoothedSpeed,
                });
              }
            },
            transferId,
          );
          successCount += 1;
          if (uploadResult.wasDirectory) {
            directoryCount += 1;
          }
        } else {
          const uploadResult = await sshApi.uploadFromLocalPath(cid, localPath, destPath);
          successCount += 1;
          if (uploadResult.wasDirectory) {
            directoryCount += 1;
          }
        }
      } catch (error) {
        failedFiles.push({
          path: localPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    onProgress({
      phase: "upload",
      current: total,
      total,
      label: "",
      indeterminate: false,
    });
    window.setTimeout(() => onProgress(null), 450);

    if (successCount === 0 && failedFiles.length > 0) {
      const details = failedFiles
        .map((entry) => `${entry.path}: ${entry.error}`)
        .join("; ");
      throw new Error(details);
    }

    return { successCount, directoryCount, failedFiles };
  }

  onProgress({
    phase: "upload",
    current: 0,
    total: normalizedLocalPaths.length,
    label:
      normalizedLocalPaths.length === 1
        ? (normalizedLocalPaths[0]?.split(/[/\\]/).pop() ?? "")
        : "",
    indeterminate: normalizedLocalPaths.length === 1,
  });

  const result = await workspaceAPI.pasteFiles(
    normalizedLocalPaths,
    normalizedTargetDirectory,
    isCut,
    workspace?.id,
  );

  onProgress({
    phase: "upload",
    current: normalizedLocalPaths.length,
    total: normalizedLocalPaths.length,
    label: "",
    indeterminate: false,
  });
  window.setTimeout(() => onProgress(null), 450);

  if (result.successCount === 0 && result.failedFiles.length > 0) {
    const details = result.failedFiles
      .map((entry) => `${entry.path}: ${entry.error}`)
      .join("; ");
    throw new Error(details);
  }

  return {
    successCount: result.successCount,
    directoryCount: result.directoryCount,
    failedFiles: result.failedFiles,
  };
}

export async function pasteClipboardFilesToWorkspaceDirectory(
  targetDirectory: string,
  workspace: WorkspaceInfo | null,
  onProgress: (state: TransferProgressState | null) => void,
  transferId?: string,
): Promise<WorkspaceTransferResult> {
  const { files, isCut } = await workspaceAPI.getClipboardFiles();
  return uploadLocalPathsToWorkspaceDirectory(
    files,
    targetDirectory,
    workspace,
    onProgress,
    { isCut },
    transferId,
  );
}
