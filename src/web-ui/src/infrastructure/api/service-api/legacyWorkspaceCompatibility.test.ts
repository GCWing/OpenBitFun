import { describe, expect, it, vi, beforeEach } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));
import { migrateLegacySkillReceipts, upgradeLegacyWorktreeReferences, upgradeLegacyEditorWorkspaceId } from './legacyWorkspaceCompatibility';

const parent = { id: 'parent-id', rootPath: '/repo', workspaceKind: 'normal' };
const execution = {
  id: 'worktree-id', rootPath: '/repo/tree', workspaceKind: 'normal',
  worktree: { isMain: false, mainRepoPath: '/repo', mainWorkspaceId: undefined as string | undefined },
};

describe('temporary legacy worktree catalog upgrade', () => {
  it('resolves a local parent despite a remote record with the same path', () => {
    const result = upgradeLegacyWorktreeReferences([
      parent, execution, { ...parent, id: 'remote-id', workspaceKind: 'remote' },
    ]);
    expect(result[1].worktree?.mainWorkspaceId).toBe('parent-id');
    expect(execution.worktree.mainWorkspaceId).toBeUndefined();
  });

  it('preserves explicit IDs despite missing owners and stale paths', () => {
    const record = { ...execution, worktree: { ...execution.worktree, mainWorkspaceId: 'missing-id' } };
    expect(upgradeLegacyWorktreeReferences([parent, record])[1]).toBe(record);
  });

  it('leaves ambiguous relationships intact instead of picking the first parent', () => {
    const records = [parent, { ...parent, id: 'other-id' }, execution];
    const result = upgradeLegacyWorktreeReferences(records);
    expect(result).toHaveLength(3);
    expect(result[2]).toBe(execution);
    expect(result[2].worktree?.mainWorkspaceId).toBeUndefined();
  });
});


describe('temporary Skill receipt upgrade', () => {
  function storage() {
    const values = new Map<string, string>();
    return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
    } satisfies Storage;
  }
  const oldKey = 'openbitfun:external-skill-import:' + JSON.stringify(['/repo', '/source']);
  const newKey = 'openbitfun:external-skill-import:v2:' + JSON.stringify(['local', 'parent-id', '/source']);
  it('copies exact old bytes to the ID owner and preserves a removal tombstone', () => {
    const data = storage();
    const raw = '{"schemaVersion":1,"future":"preserve"}';
    data.setItem(oldKey, raw);
    migrateLegacySkillReceipts(data, [parent, { ...parent, id: 'remote-id', workspaceKind: 'remote' }]);
    expect(data.getItem(newKey)).toBe(raw);
    expect(data.getItem(oldKey)).toBe(raw);
    data.setItem(newKey, 'null');
    migrateLegacySkillReceipts(data, [parent]);
    expect(data.getItem(newKey)).toBe('null');
  });
  it('does not turn an old project receipt with a missing root into a global receipt', () => {
    const data = storage();
    const source = '/source';
    const oldGlobal = 'openbitfun:external-skill-import:' + JSON.stringify(['', source]);
    const target = 'openbitfun:external-skill-import:v2:' + JSON.stringify(['local', '', source]);
    const raw = JSON.stringify({ schemaVersion: 1, sourcePath: source, level: 'project' });
    data.setItem(oldGlobal, raw);
    migrateLegacySkillReceipts(data, [parent]);
    expect(data.getItem(target)).toBeNull();
    expect(data.getItem(oldGlobal)).toBe(raw);
    data.setItem(oldGlobal, JSON.stringify({ schemaVersion: 1, sourcePath: source, level: 'user' }));
    migrateLegacySkillReceipts(data, [parent]);
    expect(data.getItem(target)).toBe(data.getItem(oldGlobal));
  });

  it('does not choose between colliding owners or reset unknown old records', () => {
    const data = storage();
    data.setItem(oldKey, '{unreadable');
    migrateLegacySkillReceipts(data, [parent, { ...parent, id: 'another-local-id' }]);
    expect(data.getItem(newKey)).toBeNull();
    expect(data.getItem(oldKey)).toBe('{unreadable');
  });
});

describe('temporary editor scope upgrade', () => {
  beforeEach(() => { activateSurface('local'); invoke.mockReset(); });
  it('resolves old roots once and retains explicit IDs without using stale paths', async () => {
    invoke.mockResolvedValue([parent]);
    expect(await upgradeLegacyEditorWorkspaceId({ surfaceId: 'local', workspacePath: '/repo' })).toBe('parent-id');
    invoke.mockClear();
    expect(await upgradeLegacyEditorWorkspaceId({ surfaceId: 'local', workspaceId: 'unavailable-id', workspacePath: '/repo' })).toBe('unavailable-id');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects ambiguous and missing scope without choosing the active workspace', async () => {
    invoke.mockResolvedValue([parent, { ...parent, id: 'remote-id', workspaceKind: 'remote' }]);
    await expect(upgradeLegacyEditorWorkspaceId({ surfaceId: 'local', workspacePath: '/repo' })).rejects.toThrow('ambiguous');
    await expect(upgradeLegacyEditorWorkspaceId({ surfaceId: 'local' })).rejects.toThrow('no workspace ID');
    await expect(upgradeLegacyEditorWorkspaceId({ surfaceId: 'other-host', workspacePath: '/repo' })).rejects.toThrow('inactive device');
  });
});
