import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const files = vi.hoisted(() => ({ readFileContent: vi.fn(), getFileMetadata: vi.fn(), writeFileContent: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({ workspaceAPI: files }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: vi.fn() } }));
import { EditorDocument, getEditorDocument, releaseEditorDocument } from './EditorDocument';

describe('editor document origin and lifetime', () => {
  beforeEach(() => { activateSurface('local'); vi.resetAllMocks(); });
  it('keeps unsaved content independent of its view and preserves the saved baseline', () => {
    const document = new EditorDocument('file-a', { surfaceId: 'local' });
    document.capture('saved', false);
    document.capture('draft', true);
    expect(document.snapshot).toEqual({ content: 'draft', isDirty: true, savedContent: 'saved' });
  });
  it('uses the captured workspace and connection for reads, metadata and writes', async () => {
    const document = new EditorDocument('file-a', { surfaceId: 'local', workspacePath: '/origin', remoteConnectionId: 'ssh-a' });
    await document.files.readFileContent('/origin/a.ts');
    await document.files.getFileMetadata('/origin/a.ts');
    await document.files.writeFileContent('/unrelated-active-workspace', '/origin/a.ts', 'content');
    expect(files.readFileContent).toHaveBeenCalledWith('/origin/a.ts', undefined, 'ssh-a');
    expect(files.getFileMetadata).toHaveBeenCalledWith('/origin/a.ts', 'ssh-a');
    expect(files.writeFileContent).toHaveBeenCalledWith('/origin', '/origin/a.ts', 'content', 'ssh-a');
  });
  it('rejects a stale read after the device changed and never writes through the new transport', async () => {
    let resolve!: (value: string) => void;
    files.readFileContent.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const document = new EditorDocument('file-a', { surfaceId: 'local' });
    const read = document.files.readFileContent('/a.ts');
    activateSurface('peer');
    resolve('old host response');
    await expect(read).rejects.toMatchObject({ isSurfaceChangedError: true });
    expect(document.isFileDeletedFromDisk('/a.ts', true)).toBe(false);
    await expect(document.files.writeFileContent('', '/a.ts', 'draft')).rejects.toThrow('inactive device');
    expect(files.writeFileContent).not.toHaveBeenCalled();
  });

  it('does not label an initially missing file or an in-memory draft as deleted', async () => {
    const document = new EditorDocument('missing', { surfaceId: 'local' });
    document.capture('draft', true);
    files.readFileContent.mockRejectedValueOnce(new Error('File does not exist'));
    await expect(document.files.readFileContent('/missing.md')).rejects.toThrow('does not exist');
    files.getFileMetadata.mockResolvedValueOnce({ isFile: false });
    await document.files.getFileMetadata('/missing.md');
    expect(document.isFileDeletedFromDisk('/missing.md', true)).toBe(false);
  });

  it.each([
    { surfaceId: 'local', workspacePath: '/project' },
    { surfaceId: 'local', workspacePath: '/project', remoteConnectionId: 'ssh-a' },
    { surfaceId: 'peer-a', workspacePath: '/project' },
  ])('labels disappearance only after a successful read on $surfaceId / $remoteConnectionId', async scope => {
    activateSurface(scope.surfaceId);
    const document = new EditorDocument('observed', scope);
    files.readFileContent.mockResolvedValueOnce('');
    await document.files.readFileContent('/project/a.md');
    expect(document.isFileDeletedFromDisk('/project/a.md', true)).toBe(true);
    expect(document.isFileDeletedFromDisk('/project/a.md', false)).toBe(false);
    expect(document.isFileDeletedFromDisk('/project/b.md', true)).toBe(false);
    const otherOrigin = new EditorDocument('other-origin', { ...scope, remoteConnectionId: 'ssh-b' });
    expect(otherOrigin.isFileDeletedFromDisk('/project/a.md', true)).toBe(false);
  });

  it('retains valid metadata observations across view remounts and transfers', async () => {
    const scope = { surfaceId: 'local', remoteConnectionId: 'ssh-a' };
    const document = getEditorDocument('retained-presence', scope, '/a.md');
    try {
      files.getFileMetadata.mockResolvedValueOnce({ isFile: true });
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
    const document = new EditorDocument('saved', { surfaceId: 'local' });
    files.writeFileContent.mockResolvedValueOnce(undefined);
    await document.files.writeFileContent('', 'E:\\project\\a.md', 'new file');
    expect(document.isFileDeletedFromDisk('e:/project/a.md', true)).toBe(true);
  });

  it.each(['Permission denied', 'timeout', 'offline'])('does not infer existence from %s', async error => {
    const document = new EditorDocument('unavailable', { surfaceId: 'local' });
    files.getFileMetadata.mockRejectedValueOnce(new Error(error));
    await expect(document.files.getFileMetadata('/a.md')).rejects.toThrow(error);
    files.writeFileContent.mockRejectedValueOnce(new Error(error));
    await expect(document.files.writeFileContent('', '/a.md', 'draft')).rejects.toThrow(error);
    expect(document.isFileDeletedFromDisk('/a.md', true)).toBe(false);
  });
});
