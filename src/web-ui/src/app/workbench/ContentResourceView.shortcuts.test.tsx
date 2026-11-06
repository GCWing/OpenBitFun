// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContentResourceView from './ContentResourceView';
import { useContentResourceStore } from './contentResourceStore';
import { resetSceneStoreForTest, useSceneStore } from '../stores/sceneStore';
import { releaseEditorDocument } from '@/tools/editor/services/EditorDocument';
import { shortcutManager } from '@/infrastructure/services/ShortcutManager';
import { activeEditTargetService } from '@/tools/editor/services/ActiveEditTargetService';
import { handleBrowserShortcut } from '../browserShortcutPolicy';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/tools/editor/services/ActiveEditTargetService', () => ({
  activeEditTargetService: { openMonacoFind: vi.fn() },
}));
vi.mock('../components/panels/base/FlexiblePanel', () => ({
  default: () => <div data-shortcut-scope="editor"><textarea aria-label="Code" /></div>,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('independent workbench document shortcuts', () => {
  let container: HTMLDivElement, root: Root, resourceId: string;
  const browserGuard = (event: KeyboardEvent) => handleBrowserShortcut(event, false, () => {});
  const press = (key: string, modifiers: KeyboardEventInit) => {
    const input = container.querySelector('textarea')!;
    input.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
    act(() => input.dispatchEvent(event));
    return event;
  };
  const render = (active = true) => act(() => root.render(<ContentResourceView resourceId={resourceId} isActive={active} />));

  beforeEach(() => {
    vi.clearAllMocks();
    resetSceneStoreForTest();
    useContentResourceStore.setState({ resources: {} });
    shortcutManager.clear();
    shortcutManager.setEnabled(true);
    shortcutManager.loadUserOverrides({});
    resourceId = useContentResourceStore.getState().open({
      type: 'code-editor', title: 'file.ts', data: { filePath: '/workspace/file.ts' },
    }, { surfaceId: 'local', workspaceId: 'workspace', workspacePath: '/workspace' });
    useSceneStore.getState().openContentScene(resourceId);
    container = document.createElement('div');
    container.dataset.shortcutScope = 'workbench-content';
    document.body.appendChild(container);
    root = createRoot(container);
    // The real app suppresses native browser find after product shortcut routing.
    window.addEventListener('keydown', browserGuard, true);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.removeEventListener('keydown', browserGuard, true);
    container.remove();
    useContentResourceStore.setState({ resources: {} });
    releaseEditorDocument(resourceId);
    shortcutManager.clear();
    shortcutManager.loadUserOverrides({});
    resetSceneStoreForTest();
    vi.restoreAllMocks();
  });

  it.each([
    ['MacIntel', { metaKey: true }],
    ['Win32', { ctrlKey: true }],
  ])('opens find without a mounted side canvas on %s', (platform, modifiers) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform as string);
    render();
    expect(press('f', modifiers as KeyboardEventInit).defaultPrevented).toBe(true);
    expect(activeEditTargetService.openMonacoFind).toHaveBeenCalledOnce();
  });

  it('preserves overrides and releases the command while inactive', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    shortcutManager.loadUserOverrides({ 'editor.findInFile': { key: 'g', ctrl: true } });
    render();
    press('f', { metaKey: true });
    expect(activeEditTargetService.openMonacoFind).not.toHaveBeenCalled();
    press('g', { metaKey: true });
    expect(activeEditTargetService.openMonacoFind).toHaveBeenCalledOnce();
    render(false);
    press('g', { metaKey: true });
    expect(activeEditTargetService.openMonacoFind).toHaveBeenCalledOnce();
    render();
    press('g', { metaKey: true });
    expect(activeEditTargetService.openMonacoFind).toHaveBeenCalledTimes(2);
  });
});
