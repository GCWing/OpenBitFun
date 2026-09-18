// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInfo } from '@/infrastructure/config/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), scan: vi.fn(), remove: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/MCPAPI', () => ({ MCPAPI: { loadMCPJsonConfig: mocks.load, saveMCPJsonConfig: mocks.save } }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getSkillScanReport: mocks.scan, deleteSkill: mocks.remove } }));
vi.mock('@/infrastructure/api/service-api/ExternalHooksAPI', () => ({ externalHooksAPI: {} }));
import { applyImportUndo, matchesSkillReceipt, prepareMcpUndo, readSkillImportReceipt, rememberSkillImport } from './ecosystemImportUndo';

const native = { key: 'native-demo', path: '/native/demo', sourceId: 'openbitfun', level: 'user', isBuiltin: false } as SkillInfo;
const key = (source: string) => `openbitfun:external-skill-import:v2:${JSON.stringify(['local', '', source])}`;

describe('external import undo ownership and compatibility', () => {
  beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); resetDeviceSurfaceForTest(); });

  it('reads saved native identities after reload and shares user copies across workspaces', () => {
    rememberSkillImport('/source/demo', native, 'workspace-id');
    const saved = JSON.parse(localStorage.getItem(key('/source/demo'))!);
    localStorage.setItem(key('/source/demo'), JSON.stringify({ ...saved, futureOptionalField: true }));
    expect(readSkillImportReceipt('/source/demo', 'another-workspace-id')).toMatchObject(saved);
    expect(matchesSkillReceipt({ ...native, sourceId: 'codex' }, saved)).toBe(false);
    expect(matchesSkillReceipt({ ...native, isBuiltin: true }, saved)).toBe(false);
  });

  it('keeps project copy receipts scoped to the owning workspace', () => {
    rememberSkillImport('/project-source/demo', { ...native, level: 'project' }, 'workspace-a');
    expect(readSkillImportReceipt('/project-source/demo', 'workspace-a')).not.toBeNull();
    expect(readSkillImportReceipt('/project-source/demo', 'workspace-b')).toBeNull();
  });

  it('rejects project imports without an ID and never reads project receipts from the global slot', async () => {
    const source = '/missing-owner/demo';
    expect(() => rememberSkillImport(source, { ...native, level: 'project' })).toThrow('workspace ID');
    expect(localStorage.getItem(key(source))).toBeNull();
    const receipt = { schemaVersion: 1 as const, sourcePath: source, nativeKey: native.key, nativePath: native.path, level: 'project' as const };
    localStorage.setItem(key(source), JSON.stringify(receipt));
    expect(readSkillImportReceipt(source)).toBeNull();
    expect(readSkillImportReceipt(source, 'workspace-a')).toBeNull();
    await expect(applyImportUndo({ kind: 'skill', target: native.path, receipt })).rejects.toThrow('workspace ID');
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(localStorage.getItem(key(source))).toBe(JSON.stringify(receipt));
  });

  it.each(['{broken', '{"schemaVersion":99,"important":"preserve"}'])('preserves unreadable or newer receipts: %s', (stored) => {
    localStorage.setItem(key('/legacy/demo'), stored);
    rememberSkillImport('/legacy/demo', native);
    readSkillImportReceipt('/legacy/demo');
    expect(localStorage.getItem(key('/legacy/demo'))).toBe(stored);
  });

  it('does not delete a different Skill that replaced the remembered copy', async () => {
    rememberSkillImport('/changed/demo', native);
    const receipt = readSkillImportReceipt('/changed/demo')!;
    mocks.scan.mockResolvedValue({ skills: [{ ...native, path: '/other/demo' }] });
    await expect(applyImportUndo({ kind: 'skill', receipt, target: receipt.nativePath })).rejects.toThrow('changed');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(readSkillImportReceipt('/changed/demo')).not.toBeNull();
  });

  it('rejects MCP entries without provenance instead of guessing by native name', async () => {
    mocks.load.mockResolvedValue({ fingerprint: 'f1', jsonConfig: '{"mcpServers":{"docs":{"command":"user-owned"}}}' });
    await expect(prepareMcpUndo('docs')).rejects.toThrow('identified');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('preserves all unrelated MCP settings and carries the reviewed CAS fingerprint', async () => {
    const config = { extra: { future: true }, mcpServers: {
      renamed: { command: 'imported', _openbitfunImport: { sourceCandidateId: 'source-docs', behaviorVersion: 'v1' } },
      docs: { command: 'native', env: { SECRET: 'kept-in-memory' } },
    } };
    mocks.load.mockResolvedValue({ fingerprint: 'f1', jsonConfig: JSON.stringify(config) });
    const review = await prepareMcpUndo('source-docs');
    mocks.save.mockResolvedValue({ runtimeApplied: false });
    await expect(applyImportUndo(review)).resolves.toEqual({ runtimeApplied: false });
    expect(JSON.parse(mocks.save.mock.calls[0][0])).toEqual({ extra: config.extra, mcpServers: { docs: config.mcpServers.docs } });
    expect(mocks.save.mock.calls[0][1]).toBe('f1');
    expect(localStorage.length).toBe(0);
  });

  it('rejects remote surfaces before reading local data', async () => {
    activateSurface('peer');
    await expect(prepareMcpUndo('source-docs')).rejects.toThrow('local host');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('stops Skill removal if the surface changes while its identity is being checked', async () => {
    rememberSkillImport('/late/demo', native);
    const receipt = readSkillImportReceipt('/late/demo')!;
    mocks.scan.mockImplementation(async () => { activateSurface('peer'); return { skills: [native] }; });
    await expect(applyImportUndo({ kind: 'skill', receipt, target: native.path })).rejects.toThrow('surface changed');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
