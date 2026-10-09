import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readIndexHtml(): string {
  return readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8');
}

function readWindowControlsSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../components/WindowControls/WindowControls.tsx', import.meta.url)),
    'utf8',
  );
}

function readLoadingMessage(locale: string): string {
  const common = JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../locales/${locale}/common.json`, import.meta.url)),
    'utf8',
  ));
  return common.loading.app;
}

describe('startup preload shell', () => {
  it.each([
    ['zh-CN', 'en-US', 'zh-CN'],
    ['en-US', 'zh-CN', 'en-US'],
    ['zh-TW', 'en-US', 'zh-TW'],
    ['  ZH-hant-TW  ', 'en-US', 'zh-TW'],
    ['zh-HK', 'en-US', 'zh-TW'],
    ['en-GB', 'zh-CN', 'en-US'],
    [undefined, 'zh-Hant', 'zh-TW'],
    ['fr-FR', 'en-US', 'zh-CN'],
  ])('localizes first-paint text for saved locale %s and system language %s', (saved, system, expected) => {
    const dom = new JSDOM(readIndexHtml(), {
      url: 'http://localhost:1422/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'language', { value: system });
        Object.assign(window, {
          __OPENBITFUN_BOOTSTRAP_LOCALE__: saved,
          // Older hosts may still inject their own copy; the surface owns it now.
          __OPENBITFUN_BOOTSTRAP_MESSAGES__: { loadingApp: 'Legacy startup copy' },
        });
      },
    });

    expect(dom.window.document.documentElement.lang).toBe(expected);
    expect(dom.window.document.querySelector('.splash-screen__message')?.textContent)
      .toBe(readLoadingMessage(expected!));
    dom.window.close();
  });

  it('uses injected startup locale text and mirrors native window-control state', async () => {
    let isMaximized = true;
    const invoke = vi.fn().mockImplementation((_command, payload) => {
      const action = (payload as { request: { action: string } }).request.action;
      if (action === 'toggle_maximize') isMaximized = !isMaximized;
      return Promise.resolve({ isMaximized });
    });
    const dom = new JSDOM(readIndexHtml(), {
      url: 'http://localhost:1422/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'platform', { value: 'Win32' });
        Object.assign(window, {
          __OPENBITFUN_BOOTSTRAP_LOCALE__: 'zh-CN',
          __OPENBITFUN_SHOW_STARTUP_WINDOW_CONTROLS__: true,
          __TAURI_INTERNALS__: { invoke },
        });
      },
    });

    const hint = dom.window.document.querySelector('.splash-screen__message');
    expect(dom.window.document.documentElement.lang).toBe('zh-CN');
    expect(dom.window.document.getElementById('root')?.childElementCount).toBe(0);
    expect(dom.window.document.getElementById('openbitfun-startup-overlay')).not.toBeNull();
    expect(hint?.textContent).toBe('正在启动 OpenBitFun...');

    const controls = dom.window.document.querySelector<HTMLElement>('[data-startup-window-controls]');
    expect(controls?.hidden).toBe(false);
    expect(controls?.classList.contains('window-controls')).toBe(true);
    expect(controls?.classList.contains('window-controls--windows')).toBe(true);
    expect(controls?.getAttribute('data-openbitfun-component')).toBe('window-controls');
    expect(dom.window.document.querySelector('.splash-screen')?.hasAttribute('aria-hidden')).toBe(false);
    await Promise.resolve();

    const minimizeButton = dom.window.document.querySelector<HTMLButtonElement>('[data-startup-window-action="minimize"]');
    expect(minimizeButton?.className).toBe('window-controls__btn window-controls__btn--minimize');
    expect(minimizeButton?.querySelector('.lucide-minus')).not.toBeNull();
    expect(minimizeButton?.querySelectorAll('svg')).toHaveLength(1);

    const maximizeButton = dom.window.document.querySelector<HTMLButtonElement>('[data-startup-window-action="toggle_maximize"]');
    const visibleMaximizeGlyph = () => Array.from(maximizeButton?.querySelectorAll('svg') ?? [])
      .find(glyph => glyph.style.display !== 'none')
      ?.getAttribute('class');
    expect(controls?.getAttribute('data-openbitfun-state')).toBe('maximized');
    expect(maximizeButton?.getAttribute('aria-label')).toBe('还原');
    expect(visibleMaximizeGlyph()).toContain('lucide-copy');

    dom.window.document.documentElement.lang = 'zh-TW';
    await Promise.resolve();
    expect(hint?.textContent).toBe(readLoadingMessage('zh-TW'));
    expect(maximizeButton?.getAttribute('aria-label')).toBe('還原');
    dom.window.document.documentElement.lang = 'zh-CN';
    await Promise.resolve();

    maximizeButton?.click();
    await Promise.resolve();
    expect(controls?.hasAttribute('data-openbitfun-state')).toBe(false);
    expect(maximizeButton?.getAttribute('aria-label')).toBe('最大化');
    expect(visibleMaximizeGlyph()).toContain('lucide-square');

    const closeButton = dom.window.document.querySelector<HTMLButtonElement>('[data-startup-window-action="close"]');
    expect(closeButton?.getAttribute('aria-label')).toBe('关闭');
    closeButton?.click();

    expect(invoke).toHaveBeenCalledWith('startup_window_control', {
      request: { action: 'close' },
    });
    expect(invoke).toHaveBeenCalledWith('startup_window_control', {
      request: { action: 'get_state' },
    });

    const html = readIndexHtml();
    expect(html).toContain('href="/src/app/components/WindowControls/WindowControls.scss"');
    expect(html).toContain('.window-controls.openbitfun-startup-window-controls');
    expect(html).not.toContain('openbitfun-startup-window-controls__btn');
    expect(readWindowControlsSource()).not.toContain("import './WindowControls.scss'");
    dom.window.close();
  });

  it('updates a system-language hint when the app resolves its saved language', async () => {
    const dom = new JSDOM(readIndexHtml(), {
      url: 'http://localhost:1422/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'language', { value: 'en-US' });
      },
    });
    const hint = dom.window.document.querySelector('.splash-screen__message');
    expect(hint?.textContent).toBe(readLoadingMessage('en-US'));

    dom.window.document.documentElement.lang = 'zh-CN';
    await Promise.resolve();
    expect(hint?.textContent).toBe(readLoadingMessage('zh-CN'));

    dom.window.dispatchEvent(new dom.window.Event('openbitfun:startup-overlay-hidden'));
    dom.window.document.documentElement.lang = 'en-US';
    await Promise.resolve();
    expect(hint?.textContent).toBe(readLoadingMessage('zh-CN'));
    dom.window.close();
  });

  it.each([
    { maximized: true, fullscreen: false, showControls: true },
    { maximized: false, fullscreen: true, showControls: true },
    { maximized: true, fullscreen: true, showControls: true },
    { maximized: true, fullscreen: false, showControls: false },
  ])('guards pre-React dragging with maximized=$maximized/fullscreen=$fullscreen/controls=$showControls', async ({ maximized, fullscreen, showControls }) => {
    const state = { maximized, fullscreen };
    const invoke = vi.fn(async (command: string, payload: { request?: { action: string } }) => {
      if (command === 'plugin:window|is_maximized') return state.maximized;
      if (command === 'plugin:window|is_fullscreen') return state.fullscreen;
      if (command === 'startup_window_control') {
        if (payload.request?.action === 'toggle_maximize') state.maximized = !state.maximized;
        return { isMaximized: state.maximized };
      }
      if (command === 'plugin:window|start_dragging') return;
      throw new Error(`Unexpected window command: ${command}`);
    });
    const dom = new JSDOM(readIndexHtml(), {
      url: 'http://localhost:1422/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          __OPENBITFUN_SHOW_STARTUP_WINDOW_CONTROLS__: showControls,
          __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'main' } } },
        });
      },
    });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const dragCalls = () => invoke.mock.calls.filter(([command]) => command === 'plugin:window|start_dragging');
    const overlay = dom.window.document.getElementById('openbitfun-startup-overlay')!;
    const mouseDown = (target: Element, options: MouseEventInit = {}) => target.dispatchEvent(
      new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1, ...options }),
    );

    try {
      expect(dom.window.document.getElementById('root')?.childElementCount).toBe(0);
      expect(dom.window.document.querySelector('[data-tauri-drag-region]')).toBeNull();
      mouseDown(overlay);
      await flush();
      expect(dragCalls()).toHaveLength(0);

      // Restore through the static shell, without React or a cached resize update.
      state.fullscreen = false;
      state.maximized = true;
      overlay.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2 }));
      await flush();
      expect(state.maximized).toBe(false);
      mouseDown(overlay);
      await flush();
      expect(dragCalls()).toEqual([['plugin:window|start_dragging', { label: 'main' }]]);

      mouseDown(overlay, { button: 1 });
      mouseDown(overlay, { button: 2 });
      mouseDown(overlay, { detail: 2 });
      mouseDown(overlay.querySelector('[data-startup-window-action="toggle_maximize"] svg')!);
      await flush();
      expect(dragCalls()).toHaveLength(1);

      // A pending state read must not start dragging after the startup handoff.
      mouseDown(overlay);
      overlay.setAttribute('inert', '');
      await flush();
      expect(dragCalls()).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('shows the independent pet preload for the companion window', () => {
    const html = readIndexHtml();
    const dom = new JSDOM(html, {
      url: 'http://localhost:1422/?openbitfunWindow=agent-companion',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          __OPENBITFUN_BOOTSTRAP_LOCALE__: 'en-US',
        });
      },
    });

    expect(dom.window.document.body.classList.contains('openbitfun-pet-preload-body')).toBe(true);
    expect(dom.window.document.getElementById('openbitfun-startup-overlay')).toBeNull();
    expect(dom.window.document.querySelector('.openbitfun-pet-preload__sprite')).not.toBeNull();
    expect(dom.window.document.querySelector('.splash-screen__logo')).toBeNull();
    expect(dom.window.document.querySelector('.openbitfun-sr-only')?.textContent).toBe('Loading companion...');
    const spriteCss = html.match(/\.openbitfun-pet-preload__sprite \{(?<css>[\s\S]*?)\n      \}/)?.groups?.css;
    expect(spriteCss).toBeDefined();
    expect(spriteCss).not.toContain('background:');
    expect(spriteCss).not.toContain('border:');
    expect(spriteCss).not.toContain('box-shadow:');
    dom.window.close();
  });
});
