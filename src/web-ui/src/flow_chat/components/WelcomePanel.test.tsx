// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import { WelcomePanel } from './WelcomePanel';
import { welcomePanelAppearanceDescriptor } from './WelcomePanel.appearance';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const gitApiMock = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.count ?? key,
  }),
}));

vi.mock('../../infrastructure/api', () => ({
  gitAPI: gitApiMock,
}));

vi.mock('../../app/hooks/useApp', () => ({
  useApp: () => ({
    switchLeftPanelTab: vi.fn(),
  }),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    hasWorkspace: true,
    currentWorkspace: {
      id: 'workspace-1',
      name: 'OpenBitFun',
      rootPath: 'D:/workspace/OpenBitFun',
    },
    openedWorkspacesList: [],
    openWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
  }),
}));

vi.mock('./CoworkExampleCards', () => ({
  default: () => null,
}));

vi.mock('@/app/scenes/my-agent/useAgentIdentityDocument', () => ({
  useAgentIdentityDocument: () => ({ document: { name: '' } }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WelcomePanel Git summary loading', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    gitApiMock.isGitRepository.mockReset();
    gitApiMock.getStatus.mockReset();
    gitApiMock.getStatus.mockResolvedValue({
      current_branch: 'main',
      staged: [],
      unstaged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    document.head.querySelector('style[data-welcome-appearance-test]')?.remove();
    document.documentElement.removeAttribute('data-openbitfun-appearance');
    document.documentElement.removeAttribute('data-openbitfun-appearance-revision');
    container.remove();
  });

  it('does not request Git status after the panel unmounts during repository detection', async () => {
    const repositoryProbe = deferred<boolean>();
    gitApiMock.isGitRepository.mockReturnValue(repositoryProbe.promise);

    await act(async () => {
      root.render(<WelcomePanel sessionMode='Standard' />);
    });

    expect(gitApiMock.isGitRepository).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });

    act(() => {
      root.unmount();
    });

    await act(async () => {
      repositoryProbe.resolve(true);
      await repositoryProbe.promise;
    });

    expect(gitApiMock.getStatus).not.toHaveBeenCalled();
  });

  it('loads Git status when the panel remains mounted', async () => {
    gitApiMock.isGitRepository.mockResolvedValue(true);

    await act(async () => {
      root.render(<WelcomePanel sessionMode='Standard' />);
    });

    expect(gitApiMock.getStatus).toHaveBeenCalledWith({ workspaceId: 'workspace-1' }, 'welcome_panel');
    expect(container.querySelector('[data-openbitfun-product-part="workspaceAction"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="gitAction"]')).not.toBeNull();
  });

  it('does not render the retired panda mascot', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode="claw" workspacePath="D:/workspace/Assistant" />);
    });

    expect(container.querySelector('[data-openbitfun-product-part="mascot"]')).toBeNull();
    expect(container.querySelector('img[src^="/panda_full_"]')).toBeNull();
  });

  it('portals the workspace menu outside the scrollable welcome panel', async () => {
    gitApiMock.isGitRepository.mockResolvedValue(false);
    await act(async () => {
      root.render(<WelcomePanel sessionMode='Standard' />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]');
    expect(trigger?.getAttribute('data-openbitfun-component')).toBe('button');
    expect(trigger?.querySelector('[data-overflow-behavior]')).toBeNull();
    await act(async () => trigger?.querySelector<HTMLElement>('[data-openbitfun-part="label"]')?.click());

    const menu = document.querySelector<HTMLElement>('[data-openbitfun-product-part="workspaceMenu"]');
    expect(menu?.parentElement?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(menu?.style.visibility).toBe('visible');

    await act(async () => trigger?.querySelector<HTMLElement>('[data-openbitfun-part="trailing-icon"]')?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')).toBeNull();
  });

  it('keeps saved welcome action styles targeting the migrated Button', async () => {
    const legacyPackage: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.welcome', name: 'Welcome', version: '1.0.0', mode: 'dark',
      components: {
        'welcome-panel': { parts: {
          workspaceAction: { base: { opacity: { kind: 'number', value: 0.6 } } },
        } },
      },
    };
    const serialized = JSON.stringify(legacyPackage);
    const restored = JSON.parse(serialized) as AppearancePackage;
    const registry = new AppearanceRegistry().registerComponent(welcomePanelAppearanceDescriptor);
    const snapshot = new AppearanceCompiler(registry).compile(restored, 1);
    expect(JSON.stringify(restored)).toBe(serialized);
    document.documentElement.setAttribute('data-openbitfun-appearance', snapshot.id);
    document.documentElement.setAttribute('data-openbitfun-appearance-revision', String(snapshot.revision));
    const style = document.createElement('style');
    style.setAttribute('data-welcome-appearance-test', '');
    style.textContent = snapshot.cssText;
    document.head.appendChild(style);

    gitApiMock.isGitRepository.mockResolvedValue(false);
    await act(async () => root.render(<WelcomePanel sessionMode="Standard" />));

    const rule = Array.from(style.sheet!.cssRules).find(candidate =>
      candidate instanceof CSSStyleRule && candidate.style.opacity === '0.6',
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(document.querySelector(rule!.selectorText)).toBe(
      container.querySelector('[data-openbitfun-product-part="workspaceAction"]'),
    );
  });
});
