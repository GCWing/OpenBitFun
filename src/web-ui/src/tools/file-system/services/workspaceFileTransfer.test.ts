import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeBase64FileChunk,
  writeAllToLocalFile,
  readPeerFileChunks,
  isSafePeerTransferEntryName,
  joinWorkspaceTargetPath,
  normalizeClipboardLocalPaths,
  resolvePasteTargetDirectory,
} from "./workspaceFileTransfer";

describe("workspaceFileTransfer", () => {
  it("decodes peer file chunks without corrupting binary bytes", () => {
    expect(Array.from(decodeBase64FileChunk("AP+AAQI="))).toEqual([
      0x00, 0xff, 0x80, 0x01, 0x02,
    ]);
  });

  it("rejects peer directory entries that can escape the selected destination", () => {
    expect(isSafePeerTransferEntryName("report.txt")).toBe(true);
    expect(isSafePeerTransferEntryName("..")).toBe(false);
    expect(isSafePeerTransferEntryName("nested/file.txt")).toBe(false);
    expect(isSafePeerTransferEntryName("nested\\file.txt")).toBe(false);
    expect(isSafePeerTransferEntryName("bad\0name")).toBe(false);
  });

  it("joins remote workspace paths with POSIX separators", () => {
    expect(
      joinWorkspaceTargetPath("/home/user/project/", "file.txt", true),
    ).toBe("/home/user/project/file.txt");
  });

  it("joins local workspace paths with native separators", () => {
    expect(
      joinWorkspaceTargetPath("/Users/dev/project", "file.txt", false),
    ).toBe("/Users/dev/project/file.txt");
    expect(joinWorkspaceTargetPath("C:\\dev\\project", "file.txt", false)).toBe(
      "C:\\dev\\project\\file.txt",
    );
  });

  it("normalizes clipboard file URLs and deduplicates paths", () => {
    expect(
      normalizeClipboardLocalPaths(["file:///tmp/a.txt", " /tmp/a.txt ", ""]),
    ).toEqual(["/tmp/a.txt"]);

    expect(
      normalizeClipboardLocalPaths([
        "file:///C:/Users/dev/Documents/report.pdf",
      ]),
    ).toEqual(["C:/Users/dev/Documents/report.pdf"]);
  });

  it("strips trailing slashes from directory paths so the name is not empty", () => {
    // macOS `POSIX path of` returns trailing slash for directories.
    expect(normalizeClipboardLocalPaths(["/tmp/myfolder/"])).toEqual([
      "/tmp/myfolder",
    ]);

    expect(
      normalizeClipboardLocalPaths(["file:///home/user/myfolder/"]),
    ).toEqual(["/home/user/myfolder"]);

    // Multiple trailing slashes.
    expect(normalizeClipboardLocalPaths(["/tmp/myfolder//"])).toEqual([
      "/tmp/myfolder",
    ]);
  });

  it("resolves paste target from selected directory node", () => {
    const fileTree = [
      {
        path: "/tmp/project",
        isDirectory: true,
        children: [{ path: "/tmp/project/src", isDirectory: true }],
      },
    ];

    const findNode = (nodes: typeof fileTree, path: string) => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const child = node.children.find((entry) => entry.path === path);
          if (child) return child;
        }
      }
      return null;
    };

    expect(
      resolvePasteTargetDirectory({
        workspacePath: "/tmp/project",
        selectedFile: "/tmp/project/src",
        fileTree,
        findNode,
      }),
    ).toBe("/tmp/project/src");
  });
});

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/infrastructure/api/adapters", () => ({ getTransportAdapter: () => native, createTransportAdapter: () => native }));

describe("atomic peer download sink", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.request.mockResolvedValue({ id: 7 });
  });
  async function* content() { yield new Uint8Array([1, 2, 3]); }
  it("commits only after the full stream is validated", async () => {
    const progress = vi.fn();
    await writeAllToLocalFile("/external/existing.bin", content(), progress);
    expect(native.request.mock.calls).toEqual([
      ["local_file_download", {request: {action: "begin", destination: "/external/existing.bin"}}],
      ["local_file_download", {request: {action: "write", id: 7, offset: 0, bytes: [1, 2, 3]}}],
      ["local_file_download", {request: {action: "finish", id: 7, size: 3}}],
    ]);
    expect(progress).toHaveBeenCalledExactlyOnceWith(3);
  });
  it("cancels staging when the remote stream fails", async () => {
    async function* broken() { yield new Uint8Array([1]); throw new Error("revision changed"); }
    await expect(writeAllToLocalFile("/external/existing.bin", broken(), vi.fn())).rejects.toThrow("revision changed");
    expect(native.request.mock.calls.map((call) => call[1].request.action)).toEqual(["begin", "write", "cancel"]);
  });
  it("preserves replacement errors even if cleanup reports the resource closed", async () => {
    native.request.mockImplementation(async (_command, {request}) => {
      if (request.action === "finish") throw new Error("permission denied");
      if (request.action === "cancel") throw new Error("already closed");
      return { id: 7 };
    });
    await expect(writeAllToLocalFile("/external/existing.bin", content(), vi.fn())).rejects.toThrow("permission denied");
  });
});

describe("fixed peer download identity", () => {
  it("retains the workspace and SSH identity on every request", async () => {
    const requestPeerCommand = vi.fn()
      .mockResolvedValueOnce({ resp: "file_info", size: 2 })
      .mockResolvedValueOnce({ resp: "file_chunk", offset: 0, chunk_size: 1, total_size: 2, chunk_base64: "AQ==", revision: "r1" })
      .mockResolvedValueOnce({ resp: "file_chunk", offset: 1, chunk_size: 1, total_size: 2, chunk_base64: "Ag==", revision: "r1" });
    const adapter = { requestPeerCommand } as unknown as Parameters<typeof readPeerFileChunks>[0];
    const bytes: number[] = [];
    for await (const chunk of readPeerFileChunks(adapter, "/workspace/file", vi.fn(), {workspace_id: "workspace-1", workspace_path: "/workspace", remote_connection_id: "saved-ssh"})) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2]);
    for (const [request] of requestPeerCommand.mock.calls) {
      expect(request).toMatchObject({path: "/workspace/file", workspace_id: "workspace-1", workspace_path: "/workspace", remote_connection_id: "saved-ssh", session_id: null});
    }
  });

  it("rejects changed revisions before installing mixed content", async () => {
    const requestPeerCommand = vi.fn()
      .mockResolvedValueOnce({ resp: "file_info", size: 2 })
      .mockResolvedValueOnce({ resp: "file_chunk", offset: 0, chunk_size: 1, total_size: 2, chunk_base64: "AQ==", revision: "r1" })
      .mockResolvedValueOnce({ resp: "file_chunk", offset: 1, chunk_size: 1, total_size: 2, chunk_base64: "Ag==", revision: "r2" });
    const adapter = { requestPeerCommand } as unknown as Parameters<typeof readPeerFileChunks>[0];
    const stream = readPeerFileChunks(adapter, "/workspace/file", vi.fn(), {workspace_path: "/workspace"});
    await stream.next();
    await expect(stream.next()).rejects.toThrow("changed during download");
  });
});
