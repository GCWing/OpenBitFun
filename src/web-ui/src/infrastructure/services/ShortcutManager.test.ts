/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Portal } from '@openbitfun/ui';
import { EDITOR_SHORTCUTS } from '@/shared/constants/shortcuts';
import { parseStoredKeybindings, shortcutManager } from './ShortcutManager';

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

function dispatchScopedKey(scope: string, init: KeyboardEventInit): void {
  const target = document.createElement('div');
  target.setAttribute('data-shortcut-scope', scope);
  document.body.appendChild(target);
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrlKey,
    metaKey: init.metaKey,
    shiftKey: init.shiftKey,
    altKey: init.altKey,
    keyCode: init.keyCode,
    bubbles: true,
    cancelable: true,
  }));
  target.remove();
}

describe('ShortcutManager platform primary modifier', () => {
  beforeEach(() => {
    shortcutManager.clear();
    shortcutManager.setEnabled(true);
    shortcutManager.loadUserOverrides({});
    document.body.innerHTML = '';
  });

  afterEach(() => {
    shortcutManager.clear();
    vi.restoreAllMocks();
  });

  it('lets the overlay consume Escape before the chat stop shortcut', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const stop = vi.fn(), dismiss = vi.fn();
    shortcutManager.register('chat.stop', { key: 'Escape', scope: 'chat', allowInInput: true }, stop);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container), surfaceRef = createRef<HTMLDivElement>();
    try {
      act(() => root.render(createElement(Portal, { surfaceRef, onDismiss: dismiss,
        children: createElement('div', { ref: surfaceRef }, 'Menu'),
      })));
      dispatchScopedKey('chat', { key: 'Escape' });
      expect(dismiss).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
    dispatchScopedKey('chat', { key: 'Escape' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('restores the registered default when synced overrides are removed', () => {
    setPlatform('Win32');
    const callback = vi.fn();
    shortcutManager.loadUserOverrides({ 'fixture.sync': { key: 'q', alt: true } });
    shortcutManager.register('fixture.sync', { key: 'n', ctrl: true, scope: 'app' }, callback);
    dispatchScopedKey('app', { key: 'q', altKey: true });
    expect(callback).toHaveBeenCalledTimes(1);

    shortcutManager.loadUserOverrides({});
    dispatchScopedKey('app', { key: 'q', altKey: true });
    expect(callback).toHaveBeenCalledTimes(1);
    dispatchScopedKey('app', { key: 'n', ctrlKey: true });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('maps logical Ctrl shortcuts to Command on macOS', () => {
    setPlatform('MacIntel');
    const callback = vi.fn();
    shortcutManager.register(
      'editor.findInFile',
      { key: 'f', ctrl: true, scope: 'editor', allowInInput: true },
      callback
    );

    dispatchScopedKey('editor', { key: 'f', metaKey: true });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not treat physical Control as the macOS primary modifier', () => {
    setPlatform('MacIntel');
    const callback = vi.fn();
    shortcutManager.register(
      'editor.findInFile',
      { key: 'f', ctrl: true, scope: 'editor', allowInInput: true },
      callback
    );

    dispatchScopedKey('editor', { key: 'f', ctrlKey: true });

    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps shortcut catalog defaults platform-neutral', () => {
    const findInFile = EDITOR_SHORTCUTS.find((shortcut) => shortcut.id === 'editor.findInFile');

    expect(findInFile?.config).toMatchObject({ key: 'f', ctrl: true });
    expect(findInFile?.config.meta).toBeUndefined();
  });

  it('allows the Agent session shortcut to use stored overrides', () => {
    const overrides = parseStoredKeybindings({
      __version__: 1,
      overrides: {
        'scene.openSession': { key: 'J', alt: true },
      },
    });

    shortcutManager.loadUserOverrides(overrides);

    expect(shortcutManager.getEffectiveConfig('scene.openSession', {
      key: 'A',
      ctrl: true,
      shift: true,
      scope: 'app',
      allowInInput: true,
    })).toEqual({
      key: 'J',
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
      scope: 'app',
      allowInInput: true,
    });
  });

  it('detects app-scope conflicts against scoped shortcuts', () => {
    setPlatform('Win32');
    shortcutManager.register('app.search', { key: 'k', ctrl: true, scope: 'app' }, vi.fn());
    shortcutManager.register('chat.search', { key: 'k', ctrl: true, scope: 'chat' }, vi.fn());

    expect(shortcutManager.checkConflicts({ key: 'k', ctrl: true, scope: 'chat' }, 'chat.search'))
      .toEqual([expect.objectContaining({ id: 'app.search' })]);
    expect(shortcutManager.checkConflicts({ key: 'k', ctrl: true, scope: 'app' }, 'app.search'))
      .toEqual([expect.objectContaining({ id: 'chat.search' })]);
  });

  it('detects Ctrl and Meta as the same primary modifier on macOS conflicts', () => {
    setPlatform('MacIntel');
    shortcutManager.register('app.find', { key: 'f', meta: true, scope: 'app' }, vi.fn());

    expect(shortcutManager.checkConflicts({ key: 'f', ctrl: true, scope: 'editor' }))
      .toEqual([expect.objectContaining({ id: 'app.find' })]);
  });

  it('does not run Escape shortcuts while IME owns the key', () => {
    const callback = vi.fn();
    shortcutManager.register(
      'chat.stopGeneration',
      { key: 'Escape', scope: 'chat', allowInInput: true },
      callback
    );

    dispatchScopedKey('chat', { key: 'Escape', keyCode: 229 } as KeyboardEventInit);

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not inherit canvas shortcuts when focus is inside terminal scope', () => {
    const canvasCallback = vi.fn();
    const terminalCallback = vi.fn();
    shortcutManager.register(
      'canvas.testEscape',
      { key: 'Escape', scope: 'canvas', allowInInput: true },
      canvasCallback
    );
    shortcutManager.register(
      'terminal.escape',
      { key: 'Escape', scope: 'terminal', allowInInput: true },
      terminalCallback
    );

    dispatchScopedKey('terminal', { key: 'Escape' });

    expect(canvasCallback).not.toHaveBeenCalled();
    expect(terminalCallback).toHaveBeenCalledTimes(1);
  });
});
