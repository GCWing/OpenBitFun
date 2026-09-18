import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const files = vi.hoisted(() => ({ readWorkspaceFile: vi.fn(), getWorkspaceFileMetadata: vi.fn(), writeWorkspaceFile: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({ workspaceAPI: files }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: vi.fn() } }));
import { EditorDocument, getEditorDocument, releaseEditorDocument } from './EditorDocument';

describe('editor document origin and lifetime', () => {
  beforeEach(() => { activateSurface('local'); vi.resetAllMocks(); });
  it('keeps unsaved content independent of its view and preserves the saved baseline', () => {
    const document = new EditorDocument('file-a', { workspaceId: 'workspace-1', surfaceId: 'local' });
    document.capture('saved', false);
    document.capture('draft', true);
    expect(document.snapshot).toEqual({ content: 'draft', isDirty: true, savedContent: 'saved' });
  });
  it('uses the captured workspace and connection for reads, metadata and writes', async () => {
    const document = new EditorDocument('file-a', { workspaceId: 'workspace-1', surfaceId: 'local', workspacePath: '/origin', remoteConnectionId: 'ssh-a' });
    await document.files.readFileContent('/origin/a.ts');
    await document.files.getFileMetadata('/origin/a.ts');
    await document.files.writeFileContent('/unrelated-active-workspace', '/origin/a.ts', 'content');
    expect(files.readWorkspaceFile).toHaveBeenCalledWith('workspace-1', '/origin/a.ts', undefined);
    expect(files.getWorkspaceFileMetadata).toHaveBeenCalledWith('workspace-1', '/origin/a.ts');
    expect(files.writeWorkspaceFile).toHaveBeenCalledWith('workspace-1', '/origin/a.ts', 'content');
  });
  it('rejects a stale read after the device changed and never writes through the new transport', async () => {
    let resolve!: (value: string) => void;
    files.readWorkspaceFile.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const document = new EditorDocument('file-a', { workspaceId: 'workspace-1', surfaceId: 'local' });
    const read = document.files.readFileContent('/a.ts');
    await Promise.resolve();
    activateSurface('peer');
    resolve('old host response');
    await expect(read).rejects.toMatchObject({ isSurfaceChangedError: true });
    expect(document.isFileDeletedFromDisk('/a.ts', true)).toBe(false);
    await expect(document.files.writeFileContent('', '/a.ts', 'draft')).rejects.toThrow('inactive device');
    expect(files.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('does not issue IO if the device changes while obtaining the workspace ID', async () => {
    const document = new EditorDocument('pending-id', { surfaceId: 'local', workspaceId: 'workspace-1' });
    const write = document.files.writeFileContent('/ignored', '/a.ts', 'draft');
    activateSurface('peer');
    await expect(write).rejects.toMatchObject({ isSurfaceChangedError: true });
    expect(files.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('does not label an initially missing file or an in-memory draft as deleted', async () => {
    const document = new EditorDocument('missing', { workspaceId: 'workspace-1', surfaceId: 'local' });
    document.capture('draft', true);
    files.readWorkspaceFile.mockRejectedValueOnce(new Error('File does not exist'));
    await expect(document.files.readFileContent('/missing.md')).rejects.toThrow('does not exist');
    files.getWorkspaceFileMetadata.mockResolvedValueOnce({ isFile: false });
    await document.files.getFileMetadata('/missing.md');
    expect(document.isFileDeletedFromDisk('/missing.md', true)).toBe(false);
  });

  it.each([
    { workspaceId: 'workspace-1', surfaceId: 'local', workspacePath: '/project' },
    { workspaceId: 'workspace-1', surfaceId: 'local', workspacePath: '/project', remoteConnectionId: 'ssh-a' },
    { workspaceId: 'workspace-1', surfaceId: 'peer-a', workspacePath: '/project' },
  ])('labels disappearance only after a successful read on $surfaceId / $remoteConnectionId', async scope => {
    activateSurface(scope.surfaceId);
    const document = new EditorDocument('observed', scope);
    files.readWorkspaceFile.mockResolvedValueOnce('');
    await document.files.readFileContent('/project/a.md');
    expect(document.isFileDeletedFromDisk('/project/a.md', true)).toBe(true);
    expect(document.isFileDeletedFromDisk('/project/a.md', false)).toBe(false);
    expect(document.isFileDeletedFromDisk('/project/b.md', true)).toBe(false);
    const otherOrigin = new EditorDocument('other-origin', { ...scope, remoteConnectionId: 'ssh-b' });
    expect(otherOrigin.isFileDeletedFromDisk('/project/a.md', true)).toBe(false);
  });

  it('retains valid metadata observations across view remounts and transfers', async () => {
    const scope = { workspaceId: 'workspace-1', surfaceId: 'local', remoteConnectionId: 'ssh-a' };
    const document = getEditorDocument('retained-presence', scope, '/a.md');
    try {
      files.getWorkspaceFileMetadata.mockResolvedValueOnce({ isFile: true });
      await document.files.getFileMetadata('/a.md');
      const remounted = getEditorDocument('retained-presence', scope, '/a.md');
      expect(remounted).toBe(document);
      expect(remounted.isFileDeletedFromDisk('/a.md', true)).toBe(true);
    } finally {
      releaseEditorDocument('retained-presence');
    }
    const reopened = getEditorDocument('retained-presence', scope, '/a.md');
    expect(reopened.isFileDeletedFromDisk('/a.md', true)).toBe(false);
    releaseEditorDocument('retained-presence');
  });

  it('recognizes files created by a successful save and normalizes local path spelling', async () => {
    const document = new EditorDocument('saved', { workspaceId: 'workspace-1', surfaceId: 'local' });
    files.writeWorkspaceFile.mockResolvedValueOnce(undefined);
    await document.files.writeFileContent('', 'E:\\project\\a.md', 'new file');
    expect(document.isFileDeletedFromDisk('e:/project/a.md', true)).toBe(true);
  });

  it.each(['Permission denied', 'timeout', 'offline'])('does not infer existence from %s', async error => {
    const document = new EditorDocument('unavailable', { workspaceId: 'workspace-1', surfaceId: 'local' });
    files.getWorkspaceFileMetadata.mockRejectedValueOnce(new Error(error));
    await expect(document.files.getFileMetadata('/a.md')).rejects.toThrow(error);
    files.writeWorkspaceFile.mockRejectedValueOnce(new Error(error));
    await expect(document.files.writeFileContent('', '/a.md', 'draft')).rejects.toThrow(error);
    expect(document.isFileDeletedFromDisk('/a.md', true)).toBe(false);
  });
});
