// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import { createGenerativeWidgetHtml, exportGenerativeWidgetHtml } from './widgetHtmlExport';

const saveHtmlFile = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/file-export/saveHtmlFile', () => ({ saveHtmlFile }));
const appearance = { id: 'test.widget', mode: 'dark', vars: {
  '--openbitfun-color-content-primary': '#eeeeee',
  '--openbitfun-color-surface-canvas': '#111111',
} };
const options = {
  title: 'Chart <script>unsafe</script> & 比较', language: 'zh-CN',
  widgetCode: '<p>Widget</p>', hostUnavailableMessage: 'Requires OpenBitFun', appearance,
};

beforeEach(() => saveHtmlFile.mockReset());

describe('standalone generative widget HTML', () => {
  it('embeds the theme and shared styles, escapes the title and permits page scrolling', () => {
    const html = createGenerativeWidgetHtml(options);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(doc.title).toBe(options.title);
    expect(doc.documentElement.lang).toBe('zh-CN');
    expect(doc.documentElement.style.getPropertyValue('--openbitfun-color-content-primary')).toBe('#eeeeee');
    expect(doc.documentElement.style.colorScheme).toBe('dark');
    expect(doc.head.querySelectorAll('script')).toHaveLength(0);
    expect(doc.head.textContent).toContain('.openbitfun-card');
    expect(doc.head.textContent).toContain('overflow-y: auto');
    expect(doc.getElementById('root')?.innerHTML).toBe('<p>Widget</p>');
    expect(html).not.toContain('openbitfun-widget:update');
    expect(html).not.toContain('morphdom');
  });

  it('runs widget scripts and local interactions independently of the application', () => {
    const html = createGenerativeWidgetHtml({ ...options, widgetCode: `
      <button id="increment">0</button>
      <script>
        document.getElementById('increment').onclick = function () {
          this.textContent = String(Number(this.textContent) + 1);
        };
      </script>
    ` });
    const postMessage = vi.fn();
    const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) { window.postMessage = postMessage; } });
    try {
      dom.window.document.querySelector<HTMLButtonElement>('#increment')!.click();
      expect(dom.window.document.getElementById('increment')?.textContent).toBe('1');
      expect(postMessage).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });

  it('reports host-only actions clearly and escapes localized bridge text', () => {
    const message = 'Unavailable </script><script>window.injected = true</script>';
    const html = createGenerativeWidgetHtml({ ...options, hostUnavailableMessage: message,
      widgetCode: '<button data-file-path="src/main.rs">File</button>',
    });
    const alert = vi.fn();
    const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) { window.alert = alert; } });
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-file-path]')!.click();
      const sendPrompt = Reflect.get(dom.window, 'sendPrompt') as (text: string) => void;
      sendPrompt('Follow up');
      const bridge = Reflect.get(dom.window, 'openbitfunWidget') as { send: (data: unknown) => void };
      bridge.send({ action: 'test' });
      expect(alert).toHaveBeenCalledTimes(3);
      expect(alert).toHaveBeenLastCalledWith(message);
      expect(Reflect.get(dom.window, 'injected')).toBeUndefined();
    } finally { dom.window.close(); }
  });

  it('preserves SVG and external references without claiming to bundle network resources', () => {
    const html = createGenerativeWidgetHtml({ ...options, appearance: null, widgetCode:
      '<svg viewBox="0 0 10 10"><circle r="4" /></svg><script src="https://example.com/chart.js"></script>',
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(doc.querySelector('#root script')?.getAttribute('src')).toBe('https://example.com/chart.js');
  });

  it('captures the current appearance when exporting and preserves cancellation', async () => {
    widgetAppearanceAdapter.apply(appearance, undefined,
      { revision: 1, appearanceId: 'test', mode: 'dark', globals: {}, assets: {} });
    saveHtmlFile.mockResolvedValue(false);
    expect(await exportGenerativeWidgetHtml({ ...options, dialogTitle: 'Export HTML' })).toBe(false);
    const saved = saveHtmlFile.mock.calls[0][0];
    expect(saved.title).toBe(options.title);
    expect(saved.dialogTitle).toBe('Export HTML');
    const doc = new DOMParser().parseFromString(saved.html, 'text/html');
    expect(doc.documentElement.style.getPropertyValue('--openbitfun-color-surface-canvas')).toBe('#111111');
  });
});
