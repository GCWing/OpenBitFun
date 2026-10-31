// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { getWorkspaceIconState, invalidateWorkspaceIcons, loadWorkspaceIcon, saveWorkspaceIcon, subscribeWorkspaceIcons, supportsWorkspaceIcons } from './workspaceIcons';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(() => () => {}), peer: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.invoke, listen: mocks.listen } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({ peerConnectionManager: { get: mocks.peer, subscribe: () => () => {} } }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: mocks.runtime }));
const snapshot = (color = 'blue') => ({ workspaceId: 'project', icon: { version: 1, revision: 1, mode: 'default', color }, imageUnavailable: false });

describe('host-owned workspace icons', () => {
  beforeEach(() => {
    vi.clearAllMocks(); resetDeviceSurfaceForTest(); invalidateWorkspaceIcons();
    mocks.runtime.mockReturnValue(true); mocks.peer.mockReturnValue(undefined); mocks.invoke.mockResolvedValue(snapshot());
  });
  it('deduplicates reads and preserves recoverable errors', async () => {
    await Promise.all([loadWorkspaceIcon('project'), loadWorkspaceIcon('project')]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(getWorkspaceIconState('project').snapshot?.icon.color).toBe('blue');
    invalidateWorkspaceIcons(); mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').error).toContain('offline');
  });
  it.each([undefined, false])('does not send mutations or reads to an old peer (%s)', async supported => {
    activateSurface('peer'); mocks.peer.mockReturnValue({ getState: () => ({ capabilities: { workspaceIconV1: supported } }) });
    expect(supportsWorkspaceIcons()).toBe(false);
    await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').unsupported).toBe(true);
    await expect(saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 0, 'req', { kind: 'reset' })).rejects.toThrow('does not support');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('keeps equal workspace IDs isolated across devices and fences A → B → A reads', async () => {
    const stop = subscribeWorkspaceIcons(() => {});
    mocks.peer.mockReturnValue({ getState: () => ({ capabilities: { workspaceIconV1: true } }) });
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    activateSurface('a'); const abandoned = loadWorkspaceIcon('project');
    activateSurface('b'); await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').snapshot?.icon.color).toBe('blue');
    activateSurface('a'); mocks.invoke.mockResolvedValueOnce(snapshot('green')); await loadWorkspaceIcon('project');
    resolve(snapshot('red')); await abandoned;
    expect(getWorkspaceIconState('project').snapshot?.icon.color).toBe('green');
    stop();
  });
  it('never submits a file chosen on another device and never persists a local path', async () => {
    const scope = getActiveSurfaceScope(); activateSurface('other');
    await expect(saveWorkspaceIcon(scope, 'project', 0, 'req', { kind: 'image', color: 'default', dataBase64: 'bytes' })).rejects.toThrow('surface changed');
    expect(mocks.invoke).not.toHaveBeenCalled();
    activateSurface('local');
    await saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 0, 'same-retry-id', { kind: 'reset' });
    expect(mocks.invoke).toHaveBeenCalledWith('set_workspace_icon', { request: { workspaceId: 'project', expectedRevision: 0, requestId: 'same-retry-id', icon: { kind: 'reset' } } });
  });
  it('rejects remote URLs and future payload versions without fabricating success', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), imageData: 'file:///private/icon.png' });
    await loadWorkspaceIcon('project'); expect(getWorkspaceIconState('project').error).toContain('Unsupported');
    invalidateWorkspaceIcons(); mocks.invoke.mockResolvedValueOnce({ ...snapshot(), icon: { ...snapshot().icon, version: 2 } });
    await loadWorkspaceIcon('project'); expect(getWorkspaceIconState('project').snapshot).toBeUndefined();
  });
  it('gates the retired Web Server surface explicitly', () => {
    mocks.runtime.mockReturnValue(false); expect(supportsWorkspaceIcons()).toBe(false);
  });
  it('re-reads instead of replacing a newer catalog event with a delayed save response', async () => {
    let complete!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const pending = saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 0, 'write', { kind: 'reset' });
    invalidateWorkspaceIcons();
    complete(snapshot('red'));
    await pending;
    expect(getWorkspaceIconState('project').snapshot).toBeUndefined();
    mocks.invoke.mockResolvedValueOnce({ ...snapshot('green'), icon: { ...snapshot('green').icon, revision: 2 } });
    await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').snapshot?.icon.color).toBe('green');
  });
  it('negotiates glyph support before writing and keeps old hosts on their working color path', async () => {
    await expect(saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'glyph', { kind: 'default', color: 'blue', glyph: 'design' })).rejects.toThrow('does not support');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][0]).toBe('get_workspace_icon');
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), supportedGlyphs: ['default', 'design'] });
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), icon: { ...snapshot().icon, glyph: 'design', revision: 2 }, supportedGlyphs: ['default', 'design'] });
    await saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'glyph', { kind: 'default', color: 'blue', glyph: 'design' });
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_workspace_icon', { request: { workspaceId: 'project', expectedRevision: 1, requestId: 'glyph', icon: { kind: 'default', color: 'blue', glyph: 'design' } } });
    expect(getWorkspaceIconState('project').snapshot?.icon.glyph).toBe('design');
  });
  it('does not submit a glyph if the device changes during capability negotiation', async () => {
    let complete!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const pending = saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'glyph', { kind: 'default', color: 'blue', glyph: 'learning' });
    activateSurface('another-device');
    complete({ ...snapshot(), supportedGlyphs: ['learning'] });
    await expect(pending).rejects.toThrow('surface changed');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('retains unknown future glyphs so a compatible controller can render them later', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), icon: { ...snapshot().icon, glyph: 'future-category' } });
    await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').snapshot?.icon.glyph).toBe('future-category');
  });
  it('negotiates separate image variants and rejects an old host before writing', async () => {
    const input = { kind: 'image', color: 'default', dataBase64: 'light', darkDataBase64: 'dark' } as const;
    await expect(saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'pair', input)).rejects.toThrow('separate light and dark');
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['get_workspace_icon']);
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), supportsThemedImages: true });
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), imageData: 'data:image/png;base64,light', darkImageData: 'data:image/png;base64,dark' });
    const saved = await saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'pair', input);
    expect(saved.darkImageData).toBe('data:image/png;base64,dark');
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_workspace_icon', { request: { workspaceId: 'project', expectedRevision: 1, requestId: 'pair', icon: input } });
  });
  it('rejects unsafe dark image data and stale themed-image capability completions', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(), darkImageData: 'file:///private/dark.png' });
    await loadWorkspaceIcon('project');
    expect(getWorkspaceIconState('project').error).toContain('Unsupported');
    let complete!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const pending = saveWorkspaceIcon(getActiveSurfaceScope(), 'project', 1, 'dark', { kind: 'image', color: 'blue', darkDataBase64: 'dark' });
    activateSurface('other');
    complete({ ...snapshot(), supportsThemedImages: true });
    await expect(pending).rejects.toThrow('surface changed');
    expect(mocks.invoke.mock.calls.some(call => call[0] === 'set_workspace_icon')).toBe(false);
  });

});
