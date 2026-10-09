import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openDestination: vi.fn(),
  openScene: vi.fn(),
  activateProductAction: vi.fn(),
}));

vi.mock('@/app/scenes/settings/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ openDestination: mocks.openDestination }),
  },
}));

vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: {
    getState: () => ({ openScene: mocks.openScene }),
  },
}));

vi.mock('./productActionActivator', () => ({
  activateProductAction: mocks.activateProductAction,
}));

import { activateInteractiveCapability } from './interactiveCapabilityActivator';

describe('activateInteractiveCapability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the exact settings subview declared by a documented item', async () => {
    await activateInteractiveCapability('setting.application.shortcuts', {
      itemId: 'shortcut-browser',
    });

    expect(mocks.openDestination).toHaveBeenCalledWith({
      kind: 'settings',
      pageId: 'application.input', sectionId: 'shortcuts',
    });
    expect(mocks.openScene).toHaveBeenCalledWith('settings');
  });

  it('routes terminal and editor items to their independent settings pages', async () => {
    await activateInteractiveCapability('setting.application.terminal', {
      itemId: 'default-shell',
    });
    expect(mocks.openDestination).toHaveBeenLastCalledWith({
      kind: 'settings',
      pageId: 'development.terminal',
    });

    await activateInteractiveCapability('setting.application.development', {
      itemId: 'editor-appearance',
    });
    expect(mocks.openDestination).toHaveBeenLastCalledWith({
      kind: 'settings',
      pageId: 'development.editor',
    });
  });


  it.each([
    ['feature.computer-use', undefined, { pageId: 'tools.desktop-control' }],
    ['setting.application.input', 'voice-enabled', { pageId: 'application.input', sectionId: 'voice' }],
    ['setting.application.input', 'auto-show-selection-toolbar', { pageId: 'application.input', sectionId: 'text-selection' }],
    ['setting.application.appearance', 'language', { pageId: 'application.general' }],
    ['setting.workspace.session', 'default-agent-harness', { pageId: 'ai.session-memory', sectionId: 'session' }],
    ['setting.workspace.session', 'accelerated-search', { pageId: 'development.workspace', sectionId: 'workspace-search' }],
    ['setting.tools.execution', 'permission-mode', { pageId: 'ai.permissions' }],
    ['setting.tools.execution', 'timeouts', { pageId: 'ai.execution' }],
    ['setting.tools.execution', 'computer-use', { pageId: 'tools.desktop-control' }],
    ['setting.tools.automation', 'hooks-enabled', { pageId: 'tools.automation', sectionId: 'hooks' }],
  ])('opens the reorganized destination for %s / %s using the stable host ID', async (capabilityId, itemId, destination) => {
    await activateInteractiveCapability(capabilityId, { itemId });
    expect(mocks.openDestination).toHaveBeenLastCalledWith({ kind: 'settings', ...destination });
  });

  it('rejects stale item IDs instead of silently opening the wrong place', async () => {
    await expect(activateInteractiveCapability('setting.application.shortcuts', {
      itemId: 'missing-item',
    })).rejects.toThrow('Unknown documented item');
    expect(mocks.openDestination).not.toHaveBeenCalled();
  });
});
