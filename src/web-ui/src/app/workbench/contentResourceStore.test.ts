import { beforeEach, describe, expect, it } from 'vitest';
import { contentResourceIdentity, useContentResourceStore } from './contentResourceStore';
import type { PanelContent } from '@/shared/types/panelContent';

const scope = { surfaceId: 'local', workspacePath: '/project' };
const file = (path = '/project/readme.md'): PanelContent => ({ type: 'markdown-editor', title: 'readme.md', data: { filePath: path } });

describe('content resource ownership', () => {
  beforeEach(() => useContentResourceStore.setState({ resources: {} }));
  it('replaces immutable dispatch snapshots without creating a filesystem resource', () => {
    const store = useContentResourceStore.getState();
    const preview: PanelContent = { type: 'image-viewer', title: 'output.png', data: {
      filePath: 'dispatch-file://job/output.png', imageSource: { dataUrl: 'data:image/png;base64,AQ==', size: 1 },
    } };
    const id = store.open(preview, scope, 'job/output.png', true);
    expect(useContentResourceStore.getState().resources[id].target.kind).toBe('content');
    const updated = { ...preview, data: { ...preview.data, imageSource: { dataUrl: 'data:image/png;base64,Ag==', size: 1 } } };
    expect(store.open(updated, scope, 'job/output.png', true)).toBe(id);
    expect(useContentResourceStore.getState().resources[id].content.data.imageSource.dataUrl).toBe('data:image/png;base64,Ag==');
  });
  it('deduplicates a file across entry points and navigates without replacing its buffer', () => {
    const store = useContentResourceStore.getState();
    const id = store.open(file(), scope);
    const edited = { ...file(), data: { ...file().data, content: 'unsaved draft' } };
    store.update(id, { content: edited, isDirty: true });
    expect(store.open({ ...file(), data: { ...file().data, jumpToLine: 12, navigationToken: 2 } }, scope)).toBe(id);
    expect(Object.keys(useContentResourceStore.getState().resources)).toHaveLength(1);
    expect(useContentResourceStore.getState().resources[id]).toMatchObject({ isDirty: true,
      content: { data: { content: 'unsaved draft', jumpToLine: 12 } } });
  });
  it('separates identical paths by device and remote connection, preserving remote path case and escapes', () => {
    const a = contentResourceIdentity(file('/project/A%20B.md'), { ...scope, remoteConnectionId: 'ssh-a' });
    const b = contentResourceIdentity(file('/project/A%20B.md'), { ...scope, remoteConnectionId: 'ssh-b' });
    const c = contentResourceIdentity(file('/project/A%20B.md'), { ...scope, surfaceId: 'peer', remoteConnectionId: 'ssh-a' });
    const d = contentResourceIdentity(file('/project/a%20b.md'), { ...scope, remoteConnectionId: 'ssh-a' });
    expect(new Set([a.key, b.key, c.key, d.key]).size).toBe(4);
    expect(a.target).toEqual({ kind: 'file', path: '/project/A%20B.md' });
  });
  it('owns files by workspace ID so a reconnected remote workspace keeps its buffers', () => {
    const owned = { ...scope, workspaceId: 'remote_1', remoteConnectionId: 'ssh-a' };
    const reconnected = { ...owned, remoteConnectionId: 'ssh-b' };
    const other = { ...scope, workspaceId: 'remote_2', remoteConnectionId: 'ssh-a' };
    const a = contentResourceIdentity(file(), owned);
    expect(contentResourceIdentity(file(), reconnected).key).toBe(a.key);
    expect(contentResourceIdentity(file(), other).key).not.toBe(a.key);
    expect(contentResourceIdentity(file(), { ...scope, remoteConnectionId: 'ssh-a' }).key).not.toBe(a.key);

    const store = useContentResourceStore.getState();
    const id = store.open(file(), owned);
    store.update(id, { isDirty: true });
    store.renameFile({ surfaceId: 'local', workspaceId: 'remote_2' }, '/project', '/elsewhere');
    expect(useContentResourceStore.getState().resources[id].target).toEqual({ kind: 'file', path: '/project/readme.md' });
    store.renameFile({ surfaceId: 'local', workspaceId: 'remote_1' }, '/project', '/renamed');
    expect(useContentResourceStore.getState().resources[id]).toMatchObject({ isDirty: true,
      target: { kind: 'file', path: '/renamed/readme.md' } });
  });
  it('keeps one document when changing the representation of an edited file', () => {
    const store = useContentResourceStore.getState();
    const id = store.open(file(), scope);
    store.update(id, { isDirty: true });
    expect(store.open({ ...file(), type: 'code-editor' }, scope, undefined, true)).toBe(id);
    expect(useContentResourceStore.getState().resources[id]).toMatchObject({ documentId: id, isDirty: true, content: { type: 'code-editor' } });
  });
  it('renames a file or directory without losing document identity and dirty state', () => {
    const store = useContentResourceStore.getState();
    const id = store.open(file(), scope);
    store.update(id, { isDirty: true });
    store.renameFile(scope, '/project', '/renamed');
    expect(useContentResourceStore.getState().resources[id]).toMatchObject({ documentId: id, isDirty: true,
      target: { kind: 'file', path: '/renamed/readme.md' } });
    expect(store.open(file('/renamed/readme.md'), scope)).toBe(id);
  });
  it('preserves primitive content and gives unrelated transient content independent identities', () => {
    const store = useContentResourceStore.getState();
    const panel: PanelContent = { type: 'markdown-viewer', title: 'Note', data: '# text' };
    const a = store.open(panel, scope);
    const b = store.open(panel, scope);
    expect(a).not.toBe(b);
    expect(useContentResourceStore.getState().resources[a].content.data).toBe('# text');
  });
  it('reuses terminal identity without conflating separate terminal sessions', () => {
    const store = useContentResourceStore.getState();
    const terminal: PanelContent = { type: 'terminal', title: 'shell', data: { sessionId: 'pty-a' } };
    const id = store.open(terminal, scope);
    expect(store.open(terminal, scope)).toBe(id);
    expect(store.open({ ...terminal, data: { sessionId: 'pty-b' } }, scope)).not.toBe(id);
  });
  it('deduplicates Windows paths without decoding native percent sequences or merging UNC origins', () => {
    const store = useContentResourceStore.getState();
    const id = store.open(file('C:/project/a%20b.ts'), { surfaceId: 'local' });
    expect(store.open(file('c:/PROJECT/a%20b.ts'), { surfaceId: 'local' })).toBe(id);
    expect(store.open(file('C:/project/a b.ts'), { surfaceId: 'local' })).not.toBe(id);
    const unc = store.open(file('//server/share/a.ts'), { surfaceId: 'local' });
    expect(useContentResourceStore.getState().resources[unc].target).toEqual({ kind: 'file', path: '//server/share/a.ts' });
    expect(store.open(file('/server/share/a.ts'), { surfaceId: 'local' })).not.toBe(unc);
  });
  it('resolves workspace-relative paths before deduplication', () => {
    const store = useContentResourceStore.getState();
    const id = store.open(file('src/../readme.md'), scope);
    expect(store.open(file(), scope)).toBe(id);
  });

  it('replaces navigation intent without reusing a stale range', () => {
    const store = useContentResourceStore.getState();
    const id = store.open({ ...file(), data: { filePath: '/project/readme.md', jumpToRange: { start: 2, end: 5 } } }, scope);
    store.open({ ...file(), data: { filePath: '/project/readme.md', jumpToLine: 9, jumpToColumn: 3, navigationToken: 2 } }, scope);
    const data = useContentResourceStore.getState().resources[id].content.data;
    expect(data.jumpToRange).toBeUndefined();
    expect(data).toMatchObject({ jumpToLine: 9, jumpToColumn: 3 });
  });

});
