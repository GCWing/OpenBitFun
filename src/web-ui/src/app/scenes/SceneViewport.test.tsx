// @vitest-environment jsdom
import { sceneSelection, type PaneSelections } from '../workbench/scenePaneModel';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sceneHarness = vi.hoisted(() => {
  let resolveAgents: (() => void) | null = null;
  let agentsAreReady = false;
  const agentsReady = new Promise<void>((resolve) => {
    resolveAgents = () => {
      agentsAreReady = true;
      resolve();
    };
  });

  return {
    state: {
      openTabs: [{ id: 'session', lastUsed: 0 }],
      activeTabId: 'session' as string | null,
      navigationMotion: 'instant',
      navigationSequence: 0,
    } as { openTabs: { id: string; lastUsed: number; pane?: 'primary' | 'secondary' }[]; activeTabId: string | null; navigationMotion: string; navigationSequence: number; paneSelections?: PaneSelections },
    agentsReady,
    agentsAreReady: () => agentsAreReady,
    resolveAgents: () => resolveAgents?.(),
  };
});

vi.mock('../hooks/useSceneManager', () => ({
  useSceneManager: () => sceneHarness.state,
}));

vi.mock('../hooks/useDialogCompletionNotify', () => ({
  useDialogCompletionNotify: () => undefined,
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Spinner: () => <div data-testid="scene-loader" />,
}));

vi.mock('./session/SessionScene', () => ({
  default: () => <div data-testid="session-scene-content" />,
}));

vi.mock('./settings/SettingsScene', () => ({
  default: ({ isActive }: { isActive?: boolean }) => (
    <div
      data-testid="settings-scene-content"
      data-scene-prop-active={isActive ? 'true' : 'false'}
    />
  ),
}));

vi.mock('./assistant/AssistantScene', () => ({
  default: () => <div data-testid="assistant-scene-content" />,
}));

vi.mock('./welcome/WelcomeScene', () => ({
  default: () => <div data-testid="welcome-scene" />,
}));

vi.mock('./agents/AgentsScene', () => ({
  default: () => {
    if (!sceneHarness.agentsAreReady()) {
      throw sceneHarness.agentsReady;
    }
    return <div data-testid="agents-scene-content" />;
  },
}));

vi.mock('./miniapps/MiniAppScene', () => ({
  default: ({ appId }: { appId: string }) => (
    <div data-testid="miniapp-scene-content" data-miniapp-id={appId} />
  ),
}));

import SceneViewport from './SceneViewport';
import { sessionPaneLayoutStore } from './session/sessionPaneLayoutStore';

describe('SceneViewport transitions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionPaneLayoutStore.setState(sessionPaneLayoutStore.getInitialState());
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 16)
    ));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sceneHarness.state = {
      openTabs: [{ id: 'session', lastUsed: 0 }],
      activeTabId: 'session',
      navigationMotion: 'instant',
      navigationSequence: 0,
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function visibleScenes(): Element[] {
    return Array.from(container.querySelectorAll('[data-testid="scene-viewport-scene"]'))
      .filter(scene => scene.classList.contains('openbitfun-scene-viewport__scene--visible'));
  }

  it('renders the welcome surface when no tab is open', () => {
    sceneHarness.state = {
      openTabs: [],
      activeTabId: null,
      navigationMotion: 'instant',
      navigationSequence: 0,
    };

    act(() => root.render(<SceneViewport />));

    expect(visibleScenes()).toHaveLength(1);
    expect(container.querySelector('[data-testid="welcome-scene"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });

  it('shares one mounted Session host across workspace tab identities', () => {
    sceneHarness.state.openTabs = [
      { id: 'session:workspace-a', lastUsed: 1 },
      { id: 'session:workspace-b', lastUsed: 2 },
    ];
    sceneHarness.state.activeTabId = 'session:workspace-a';
    act(() => root.render(<SceneViewport />));
    const host = container.querySelector('[data-testid="session-scene-content"]');
    expect(container.querySelectorAll('[data-testid="session-scene-content"]')).toHaveLength(1);
    sceneHarness.state.activeTabId = 'session:workspace-b';
    sceneHarness.state.navigationSequence++;
    act(() => root.render(<SceneViewport />));
    expect(container.querySelector('[data-testid="session-scene-content"]')).toBe(host);
  });

  it('keeps both selected pages mounted while moving a scene between panes', () => {
    sessionPaneLayoutStore.getState().showContent();
    sceneHarness.state = {
      openTabs: [{ id: 'session', lastUsed: 1 }, { id: 'settings', lastUsed: 2, pane: 'secondary' }],
      activeTabId: 'settings', navigationMotion: 'instant', navigationSequence: 1,
      paneSelections: { primary: sceneSelection('session'), secondary: sceneSelection('settings') },
    };
    act(() => root.render(<SceneViewport paned />));
    const settings = container.querySelector('[data-testid="settings-scene-content"]');
    const session = container.querySelector('[data-testid="session-scene-content"]');
    expect(visibleScenes()).toHaveLength(2);
    expect(settings?.closest('[data-split-surface]')?.getAttribute('data-split-surface')).toBe('secondary');
    sceneHarness.state.openTabs[1].pane = 'primary';
    sceneHarness.state.paneSelections = { primary: sceneSelection('settings'), secondary: { kind: 'canvas' } };
    act(() => root.render(<SceneViewport paned />));
    expect(container.querySelector('[data-testid="settings-scene-content"]')).toBe(settings);
    expect(settings?.closest('[data-split-surface]')?.getAttribute('data-split-surface')).toBe('primary');
    sceneHarness.state.openTabs[0].pane = 'secondary';
    sceneHarness.state.paneSelections.secondary = sceneSelection('session');
    act(() => root.render(<SceneViewport paned />));
    expect(container.querySelector('[data-testid="session-scene-content"]')).toBe(session);
    expect(container.querySelectorAll('[data-testid="session-scene-content"]')).toHaveLength(1);
    expect(session?.closest('[data-split-surface]')?.getAttribute('data-split-surface')).toBe('secondary');
    expect(visibleScenes()).toHaveLength(2);
    act(() => sessionPaneLayoutStore.getState().hideContent());
    expect(visibleScenes().map(scene => scene.getAttribute('data-scene-id'))).toEqual(['settings']);
  });

  it('keeps one scene visible while a lazy pointer target becomes ready', async () => {
    act(() => root.render(<SceneViewport />));
    expect(visibleScenes().map(scene => scene.getAttribute('data-scene-id'))).toEqual(['session']);
    expect(container.querySelector('[data-scene-id="session"]')?.hasAttribute('hidden')).toBe(false);

    sceneHarness.state = {
      openTabs: [
        { id: 'session', lastUsed: 0 },
        { id: 'agents', lastUsed: 1 },
      ],
      activeTabId: 'agents',
      navigationMotion: 'pointer',
      navigationSequence: 1,
    };
    await act(async () => {
      root.render(<SceneViewport />);
      await Promise.resolve();
    });

    expect(visibleScenes().map(scene => scene.getAttribute('data-scene-id'))).toEqual(['session']);

    await act(async () => {
      sceneHarness.resolveAgents();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(visibleScenes().map(scene => scene.getAttribute('data-scene-id'))).toEqual(['agents']);
    expect(container.querySelector('[data-scene-id="session"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-scene-id="session"]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-scene-id="agents"]')?.classList.contains(
      'openbitfun-scene-viewport__scene--incoming',
    )).toBe(true);

    act(() => vi.advanceTimersByTime(32));
    expect(container.querySelector('[data-scene-id="agents"]')?.classList.contains(
      'openbitfun-scene-viewport__scene--incoming',
    )).toBe(true);

    act(() => vi.advanceTimersByTime(479));
    expect(container.querySelector('[data-scene-id="agents"]')?.classList.contains(
      'openbitfun-scene-viewport__scene--incoming',
    )).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('[data-scene-id="agents"]')?.classList.contains(
      'openbitfun-scene-viewport__scene--incoming',
    )).toBe(false);

    sceneHarness.state = {
      ...sceneHarness.state,
      activeTabId: 'session',
      navigationSequence: 2,
    };
    act(() => root.render(<SceneViewport />));

    expect(visibleScenes().map(scene => scene.getAttribute('data-scene-id'))).toEqual(['session']);
    expect(container.querySelector('[data-scene-id="agents"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-scene-id="agents"]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-scene-id="agents"]')?.hasAttribute('hidden')).toBe(false);
  });

  it('keeps an inactive open MiniApp scene mounted and hidden', async () => {
    sceneHarness.state = {
      openTabs: [
        { id: 'session', lastUsed: 0 },
        { id: 'miniapp:gomoku', lastUsed: 1 },
      ],
      activeTabId: 'session',
      navigationMotion: 'instant',
      navigationSequence: 0,
    };

    await act(async () => {
      root.render(<SceneViewport />);
      await Promise.resolve();
    });

    const inactive = container.querySelector('[data-scene-id="miniapp:gomoku"]');
    expect(inactive).not.toBeNull();
    expect(inactive?.classList.contains('openbitfun-scene-viewport__scene--visible')).toBe(false);
    expect(inactive?.getAttribute('aria-hidden')).toBe('true');
    expect(inactive?.hasAttribute('inert')).toBe(true);
    expect(inactive?.hasAttribute('hidden')).toBe(false);
  });

  it('updates a retained Settings scene when it becomes active again', () => {
    sceneHarness.state = {
      openTabs: [
        { id: 'session', lastUsed: 0 },
        { id: 'settings', lastUsed: 1 },
      ],
      activeTabId: 'settings',
      navigationMotion: 'instant',
      navigationSequence: 0,
    };

    act(() => root.render(<SceneViewport />));
    const settingsContent = container.querySelector('[data-testid="settings-scene-content"]');
    expect(settingsContent?.getAttribute('data-scene-prop-active')).toBe('true');

    sceneHarness.state = {
      ...sceneHarness.state,
      activeTabId: 'session',
      navigationSequence: 1,
    };
    act(() => root.render(<SceneViewport />));
    expect(container.querySelector('[data-testid="settings-scene-content"]')).toBe(settingsContent);
    expect(settingsContent?.getAttribute('data-scene-prop-active')).toBe('false');

    sceneHarness.state = {
      ...sceneHarness.state,
      activeTabId: 'settings',
      navigationSequence: 2,
    };
    act(() => root.render(<SceneViewport />));
    expect(container.querySelector('[data-testid="settings-scene-content"]')).toBe(settingsContent);
    expect(settingsContent?.getAttribute('data-scene-prop-active')).toBe('true');
  });
});
