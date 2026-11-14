// @vitest-environment jsdom
import React, { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TabGroupItem } from '@openbitfun/ui';
import SceneBar from './SceneBar';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { resetSceneStoreForTest, useSceneStore } from '../../stores/sceneStore';
import { createPaneState } from '../../workbench/scenePaneModel';
import { useContentResourceStore } from '../../workbench/contentResourceStore';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import type { SceneTab } from './types';

const captured = vi.hoisted(() => ({ items: [] as TabGroupItem[][] }));
vi.mock('@openbitfun/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('@openbitfun/ui')>();
  const React = await import('react');
  return { ...actual, TabGroup: React.forwardRef<HTMLDivElement, React.ComponentProps<typeof actual.TabGroup>>((props, ref) => {
    captured.items.push(props.items);
    return <actual.TabGroup {...props} ref={ref} />;
  }) };
});
vi.mock('@/infrastructure/runtime', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/runtime')>(), supportsNativeWindowDragging: () => false,
}));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
it('reuses compiled tabs across parent renders and ignores history-only updates', async () => {
  resetSceneStoreForTest();
  const tabs: SceneTab[] = Array.from({ length: 24 }, (_, i) => ({
    id: `session:perf-${i}`, lastUsed: i,
    session: { surfaceId: 'local', workspaceKey: 'perf', sessionId: `perf-${i}` },
  }));
  useSceneStore.setState({ ...createPaneState(tabs, tabs[0].id), activeTabId: tabs[0].id });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const durations: number[] = [];
  const render = () => root.render(<Profiler id="scene-bar" onRender={(_id, _phase, duration) => durations.push(duration)}><SceneBar /></Profiler>);
  try {
    await act(async () => { render(); });
    for (let i = 0; i < 10; i++) act(render);
    const measure = (name: string, update: (i: number) => void) => {
      captured.items.length = 0;
      durations.length = 0;
      for (let i = 0; i < 100; i++) act(() => update(i));
      const ordered = [...durations].sort((a, b) => a - b);
      const result = { scenario: name, renders: captured.items.length, compilations: new Set(captured.items).size,
        totalRenderMs: +durations.reduce((a, b) => a + b, 0).toFixed(2),
        p50Ms: +(ordered[Math.floor(ordered.length * .5)] ?? 0).toFixed(3),
        p95Ms: +(ordered[Math.floor(ordered.length * .95)] ?? 0).toFixed(3) };
      if (process.env.SCENE_BAR_BENCH) process.stdout.write(`${JSON.stringify(result)}\n`);
      return result;
    };
    const parents = measure('parent-rerender', render);
    if (!process.env.SCENE_BAR_BASELINE) expect(parents.compilations).toBe(1);
    const history = measure('history-only', i => useSceneStore.setState({ navCursor: i }));
    if (!process.env.SCENE_BAR_BASELINE) expect(history.renders).toBe(0);
    // Model committed navigation, including the real lastUsed update.
    measure('selection-with-lastUsed', i => {
      const id = tabs[i % tabs.length].id;
      const openTabs = useSceneStore.getState().openTabs.map(tab => tab.id === id ? { ...tab, lastUsed: 1000 + i } : tab);
      useSceneStore.setState({ ...createPaneState(openTabs, id), activeTabId: id, navigationSequence: i });
    });
  } finally {
    act(() => root.unmount());
    container.remove();
    resetSceneStoreForTest();
  }
});

it('invalidates cached file badges, titles, pinning, pane membership and device groups', async () => {
  resetSceneStoreForTest();
  activateSurface('local');
  const resource = useContentResourceStore.getState().open(
    { type: 'code-editor', title: 'before.ts', data: { filePath: '/project/before.ts' } },
    { surfaceId: 'local', remoteConnectionId: 'ssh-fixture', workspaceId: 'project' },
  );
  const file: SceneTab = { id: `content:${resource}`, contentId: resource, lastUsed: 1 };
  const peer: SceneTab = { id: 'session:peer-fixture', lastUsed: 2,
    session: { surfaceId: 'peer-fixture', workspaceKey: 'project', sessionId: 'remote' } };
  useSceneStore.setState({ ...createPaneState([file, peer], file.id), activeTabId: file.id });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const latest = () => captured.items[captured.items.length - 1];
  try {
    await act(async () => root.render(<SceneBar />));
    expect(latest().find(item => item.value === file.id)?.label).toBe('before.ts');
    expect(container.querySelectorAll('[data-openbitfun-part="tabDevice"]')).toHaveLength(2);
    const initial = latest();
    act(() => useContentResourceStore.getState().update(resource, { isDirty: true, fileMissing: true }));
    expect(latest()).not.toBe(initial);
    expect(latest().find(item => item.value === file.id)?.labelSuffix).toBeTruthy();
    act(() => useContentResourceStore.getState().update(resource, { isDirty: false, fileMissing: false,
      content: { type: 'code-editor', title: 'after.ts', data: { filePath: '/project/after.ts' } } }));
    expect(latest().find(item => item.value === file.id)?.label).toBe('after.ts');
    expect(latest().find(item => item.value === file.id)?.labelSuffix).toBeUndefined();
    act(() => useSceneStore.getState().togglePinScene(file.id));
    expect(latest().find(item => item.value === file.id)?.labelSuffix).toBeTruthy();
    act(() => useDeviceDirectory.setState({ devices: [{ device_id: 'peer-fixture', device_name: 'Renamed peer' } as never] }));
    expect(container.textContent).toContain('Renamed peer');
    act(() => activateSurface('peer-fixture'));
    expect(container.querySelectorAll('[data-openbitfun-part="tabDevice"]')).toHaveLength(0);
    const session: Session = { sessionId: 'remote', title: 'Remote title', config: {},
      dialogTurns: [], status: 'idle', createdAt: 1, lastActiveAt: 1, error: null };
    act(() => flowChatStore.setState(state => ({ ...state, sessions: new Map([['remote', session]]) })));
    expect(latest().find(item => item.value === peer.id)?.label).toBe('Remote title');
    act(() => flowChatStore.setState(state => ({ ...state,
      sessions: new Map([['remote', { ...session, title: 'Renamed session' }]]) })));
    expect(latest().find(item => item.value === peer.id)?.label).toBe('Renamed session');
    act(() => root.render(<SceneBar pane="secondary" />));
    expect(latest()).toHaveLength(0);
    act(() => root.render(<SceneBar pane="primary" />));
    expect(latest()).toHaveLength(2);
  } finally {
    act(() => root.unmount());
    container.remove();
    activateSurface('local');
    flowChatStore.discardSurfaceState('peer-fixture');
    useDeviceDirectory.setState({ devices: [], localId: null });
    useContentResourceStore.getState().remove(resource);
    resetSceneStoreForTest();
  }
});
