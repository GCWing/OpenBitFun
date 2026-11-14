import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from "@/shared/types";

const mocks = vi.hoisted(() => {
  class PeerDeviceTransportAdapter {}
  return {
    PeerDeviceTransportAdapter,
    peerAdapter: new PeerDeviceTransportAdapter(),
    surfaceCurrent: true,
    getControllerFileMetadata: vi.fn(),
    readControllerFileBytes: vi.fn(),
    uploadBytesToHost: vi.fn(),
    getControllerClipboardFiles: vi.fn(),
    getWorkspaceFileMetadata: vi.fn(),
    getClipboardFiles: vi.fn(),
    pasteFiles: vi.fn(),
    uploadFromLocalPath: vi.fn(),
  };
});

vi.mock("@/infrastructure/api/adapters/peer-device-adapter", () => ({
  PeerDeviceTransportAdapter: mocks.PeerDeviceTransportAdapter,
}));
vi.mock("@/infrastructure/api/adapters", () => ({
  getTransportAdapter: () => mocks.peerAdapter,
  createTransportAdapter: () => ({ request: vi.fn() }),
}));
vi.mock("@/infrastructure/files/controllerFiles", () => ({
  getControllerFileMetadata: mocks.getControllerFileMetadata,
  readControllerFileBytes: mocks.readControllerFileBytes,
  uploadBytesToHost: mocks.uploadBytesToHost,
  getControllerClipboardFiles: mocks.getControllerClipboardFiles,
}));
vi.mock("@/infrastructure/api", () => ({
  workspaceAPI: {
    getWorkspaceFileMetadata: mocks.getWorkspaceFileMetadata,
    getClipboardFiles: mocks.getClipboardFiles,
    pasteFiles: mocks.pasteFiles,
  },
}));
vi.mock("@/features/ssh-remote/sshApi", () => ({
  sshApi: { uploadFromLocalPath: mocks.uploadFromLocalPath },
}));
vi.mock("@/infrastructure/peer-device/deviceSurface", () => ({
  getActiveSurfaceScope: () => ({
    isCurrent: () => mocks.surfaceCurrent,
    assertCurrent: () => {
      if (!mocks.surfaceCurrent) throw new Error("surface changed");
    },
  }),
}));

import {
  MAX_PEER_UPLOAD_FILE_BYTES,
  pasteClipboardFilesToWorkspaceDirectory,
  uploadLocalPathsToWorkspaceDirectory,
} from "./workspaceFileTransfer";

const workspace = (kind: WorkspaceKind, rootPath: string): WorkspaceInfo => ({
  id: "peer-ws",
  name: "peer",
  rootPath,
  workspaceType: WorkspaceType.SingleProject,
  workspaceKind: kind,
  ...(kind === WorkspaceKind.Remote ? { connectionId: "peer-ssh" } : {}),
  languages: [],
  openedAt: "2024-01-01T00:00:00.000Z",
  lastAccessed: "2024-01-01T00:00:00.000Z",
  tags: [],
});

const fileMetadata = (size = 3) => ({ path: "", modified: 0, size, isFile: true, isDir: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.surfaceCurrent = true;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { __TAURI__: unknown }).__TAURI__ = {};
  mocks.getControllerFileMetadata.mockResolvedValue(fileMetadata());
  mocks.readControllerFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.uploadBytesToHost.mockResolvedValue(undefined);
  mocks.getWorkspaceFileMetadata.mockRejectedValue(new Error("not found"));
});

describe("Peer Device workspace uploads from the controller", () => {
  it("publishes controller bytes on the peer instead of sending controller paths", async () => {
    // `a.txt` already exists on the peer, so local-paste naming applies.
    mocks.getWorkspaceFileMetadata.mockImplementation(async (_id: string, path: string) => {
      if (path === "/srv/repo/src/a.txt") return fileMetadata();
      throw new Error("not found");
    });

    const result = await uploadLocalPathsToWorkspaceDirectory(
      ["/Users/me/Desktop/a.txt"],
      "/srv/repo/src",
      workspace(WorkspaceKind.Remote, "/srv/repo"),
      vi.fn(),
      { isCut: true },
      "drop-1",
    );

    expect(result).toMatchObject({ successCount: 1, failedFiles: [] });
    expect(mocks.readControllerFileBytes).toHaveBeenCalledWith("/Users/me/Desktop/a.txt");
    expect(mocks.uploadBytesToHost).toHaveBeenCalledWith(expect.objectContaining({
      path: "/srv/repo/src/a (1).txt",
      workspaceId: "peer-ws",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    expect(mocks.pasteFiles).not.toHaveBeenCalled();
    expect(mocks.uploadFromLocalPath).not.toHaveBeenCalled();
  });

  it("refuses folders and oversize files explicitly while keeping other files", async () => {
    mocks.getControllerFileMetadata.mockImplementation(async (path: string) => {
      if (path.endsWith("folder")) return { ...fileMetadata(), isFile: false, isDir: true };
      if (path.endsWith("huge.bin")) return fileMetadata(MAX_PEER_UPLOAD_FILE_BYTES + 1);
      return fileMetadata();
    });

    const result = await uploadLocalPathsToWorkspaceDirectory(
      ["/tmp/folder", "/tmp/huge.bin", "/tmp/ok.md"],
      "C:\\work\\repo",
      workspace(WorkspaceKind.Normal, "C:\\work\\repo"),
      vi.fn(),
    );

    expect(result.successCount).toBe(1);
    expect(result.failedFiles.map(entry => entry.path)).toEqual(["/tmp/folder", "/tmp/huge.bin"]);
    expect(mocks.uploadBytesToHost).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBytesToHost.mock.calls[0][0].path).toBe("C:/work/repo/ok.md");
    expect(mocks.readControllerFileBytes).not.toHaveBeenCalledWith("/tmp/huge.bin");
  });

  it("abandons the drop when the rendered device changes", async () => {
    mocks.uploadBytesToHost.mockImplementation(async () => {
      mocks.surfaceCurrent = false;
      throw new Error("surface changed");
    });

    await expect(uploadLocalPathsToWorkspaceDirectory(
      ["/tmp/a.txt", "/tmp/b.txt"],
      "/srv/repo",
      workspace(WorkspaceKind.Remote, "/srv/repo"),
      vi.fn(),
    )).rejects.toThrow("surface changed");
    expect(mocks.uploadBytesToHost).toHaveBeenCalledTimes(1);
  });

  it("pastes from the controller clipboard, not the peer clipboard", async () => {
    mocks.getControllerClipboardFiles.mockResolvedValue({ files: ["/Users/me/b.txt"], isCut: false });

    const result = await pasteClipboardFilesToWorkspaceDirectory(
      "/srv/repo",
      workspace(WorkspaceKind.Remote, "/srv/repo"),
      vi.fn(),
    );

    expect(result.successCount).toBe(1);
    expect(mocks.getControllerClipboardFiles).toHaveBeenCalledTimes(1);
    expect(mocks.getClipboardFiles).not.toHaveBeenCalled();
    expect(mocks.uploadBytesToHost.mock.calls[0][0].path).toBe("/srv/repo/b.txt");
  });
});
