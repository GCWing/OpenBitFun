// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SceneChromeHost, SceneChromeProvider } from '@/app/components/SceneTopBar/SceneChrome';
import MiniAppScene from './MiniAppScene';

const state = vi.hoisted(() => {
  const noop = () => {};
  const ticket = (id: string) => ({ instance: { instanceId: id, appId: id, workspacePath: null }, view: { viewId: id, kind: 'tab' } });
  return {
    supported: true, open: vi.fn(), ready: vi.fn(), actions: vi.fn(),
    miniApps: { composerClaims: {}, markCustomizationActive: noop, markCustomizationIdle: noop, upsertApp: noop },
    presentations: { tabs: { notes: ticket('notes'), other: ticket('other') }, snapshot: { hostEpoch: 'host', instances: [] } },
    scenes: { openTabs: [{ id: 'miniapp:notes' }, { id: 'miniapp:other' }] },
  };
});
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: { getMiniApp: async (id: string) => ({ id, name: id, permissions: {}, compiled_html: '<html></html>', chrome: { titlebar: { actions: [{ id: 'export', icon: 'download', label: `Export ${id}` }] } } }) } }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { listen: () => () => {} } }));
vi.mock('@/infrastructure/appearance', () => ({ useAppearance: () => ({ current: { mode: 'dark' } }) }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: null, workspacePath: null }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, currentLanguage: 'en-US' }) }));
vi.mock('@/app/hooks/useSceneManager', () => ({ useSceneManager: () => ({ closeScene: vi.fn() }) }));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: Object.assign((select: (value: unknown) => unknown) => select(state.scenes), { getState: () => state.scenes }) }));
vi.mock('./miniAppStore', () => ({ useMiniAppStore: Object.assign((select: (value: unknown) => unknown) => select(state.miniApps), { getState: () => state.miniApps }) }));
vi.mock('./miniAppPresentationStore', () => ({
  useMiniAppPresentationStore: Object.assign((select: (value: unknown) => unknown) => select(state.presentations), { getState: () => state.presentations }),
  ensureMiniAppTab: async (id: 'notes' | 'other') => state.presentations.tabs[id],
}));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({ hasLocalMiniAppPresentation: () => state.supported, miniAppPresentationAPI: { open: state.open, ready: state.ready } }));
vi.mock('./customization/useMiniAppCustomizeHotspot', () => ({ useMiniAppCustomizeHotspot: () => {} }));
vi.mock('./customization/MiniAppCustomizePanel', () => ({ default: () => null }));
vi.mock('./customization/MiniAppDraftPreview', () => ({ default: () => null }));
vi.mock('./components/MiniAppSystemAppActions', () => ({ MiniAppSystemAppActions: () => null }));
vi.mock('./utils/miniAppSystemIcon', () => ({ renderMiniAppSystemIcon: () => '<svg />' }));
vi.mock('./components/MiniAppRunner', async () => {
  const { useEffect } = await import('react');
  return { default: ({ app, onReady, chromeActionRef }: { app: { id: string }; onReady: () => void; chromeActionRef: { current: unknown } }) => {
    useEffect(() => {
      chromeActionRef.current = (id: string) => state.actions(app.id, id);
      onReady();
      return () => { chromeActionRef.current = null; };
    }, [app.id, onReady, chromeActionRef]);
    return null;
  } };
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  state.supported = true; vi.clearAllMocks(); state.ready.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(element => element.remove());
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const render = (active: 'notes' | 'other') => act(async () => root.render(
  <SceneChromeProvider activeSceneId={`miniapp:${active}`}>
    <SceneChromeHost data-testid="main-topbar-right" />
    <MiniAppScene appId="notes" /><MiniAppScene appId="other" />
  </SceneChromeProvider>,
));

it('places only the selected MiniApp actions in the main top bar and targets its content', async () => {
  await render('notes');
  const host = container.querySelector('[data-testid="main-topbar-right"]')!;
  expect(host.querySelector('[aria-label="Export notes"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Export other"]')).toBeNull();
  expect(container.querySelector('.miniapp-scene__header')).toBeNull();
  expect(host.querySelector('[aria-label="presentation.openWindow"]')?.textContent).toBe('');
  expect(host.querySelector('[aria-label="scene.reload"]')).toBeNull();
  expect(host.querySelector('[aria-label="customize.trigger"] [data-openbitfun-name="creative"]')).not.toBeNull();
  act(() => (host.querySelector('[aria-label="Export notes"]') as HTMLButtonElement).click());
  expect(state.actions).toHaveBeenCalledExactlyOnceWith('notes', 'export');
  await render('other');
  expect(host.querySelector('[aria-label="Export notes"]')).toBeNull();
  expect(host.querySelector('[aria-label="Export other"]')).not.toBeNull();
});

it('disables local window presentation on unsupported driving surfaces', async () => {
  state.supported = false;
  await render('notes');
  const button = container.querySelector<HTMLButtonElement>('[aria-label="presentation.openWindow"]')!;
  expect(button.disabled).toBe(true);
  const trigger = button.closest<HTMLElement>('[data-openbitfun-tooltip-trigger]')!;
  expect(trigger.getAttribute('aria-disabled')).toBe('true');
  act(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  act(() => vi.advanceTimersByTime(150));
  act(() => vi.advanceTimersByTime(30));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('presentation.unsupported');
  button.click();
  expect(state.open).not.toHaveBeenCalled();
});

it.each(['customize.trigger', 'presentation.openWindow', 'Export notes'])(
  'shows the %s icon hint below the main top bar on hover and keyboard focus', async label => {
    await render('notes');
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => vi.advanceTimersByTime(150));
    act(() => vi.advanceTimersByTime(30));
    const popup = () => document.querySelector('[role="tooltip"]');
    expect(popup()?.textContent).toBe(label);
    expect(popup()?.getAttribute('data-openbitfun-placement')).toBe('bottom');
    expect(button.getAttribute('aria-describedby')).toBe(popup()?.id);
    act(() => button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
    act(() => vi.advanceTimersByTime(500));
    expect(popup()).toBeNull();
    act(() => button.focus());
    act(() => vi.advanceTimersByTime(150));
    act(() => vi.advanceTimersByTime(30));
    expect(popup()?.textContent).toBe(label);
  },
);
