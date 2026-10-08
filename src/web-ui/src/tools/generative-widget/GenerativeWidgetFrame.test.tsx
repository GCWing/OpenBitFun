/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import GenerativeWidgetFrame, { GENERATIVE_WIDGET_SHELL_HTML } from './GenerativeWidgetFrame';
import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';

describe('GenerativeWidgetFrame shell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    widgetAppearanceAdapter.apply(
      { id: 'test.widget', mode: 'dark', vars: {} },
      undefined,
      { revision: 1, appearanceId: 'test', mode: 'dark', globals: {}, assets: {} },
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps iframe-local small text aligned with the host default token', () => {
    const values = [...GENERATIVE_WIDGET_SHELL_HTML.matchAll(/--openbitfun-font-size-sm:\s*([^;]+);/g)].map(
      (match) => match[1]?.trim()
    );

    expect(values).toEqual(['13px']);
  });

  it('acknowledges each applied code version and runs completed scripts only once', () => {
    const postMessage = vi.fn();
    const dom = new JSDOM(GENERATIVE_WIDGET_SHELL_HTML, {
      runScripts: 'dangerously',
      beforeParse(window) {
        window.postMessage = postMessage;
        window.requestAnimationFrame = () => 0;
      },
    });
    const streamedCode = '<p>Partial</p>';
    const completedCode = '<p>Complete</p><script>window.executionCount = (window.executionCount || 0) + 1;</script>';
    const update = (html: string, runScripts: boolean) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: { type: 'openbitfun-widget:update', widgetId: 'widget_1', html, runScripts },
      }));
    };
    try {
      expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual(['openbitfun-widget:ready']);
      update(streamedCode, false);
      expect(dom.window.document.querySelector('#root')?.textContent).toBe('Partial');
      expect(postMessage).toHaveBeenLastCalledWith({
        source: 'openbitfun-widget', type: 'openbitfun-widget:rendered',
        widgetId: 'widget_1', widgetCode: streamedCode,
      }, '*');
      update(completedCode, true);
      expect(dom.window.document.querySelector('#root > p')?.textContent).toBe('Complete');
      expect(postMessage).toHaveBeenLastCalledWith({
        source: 'openbitfun-widget', type: 'openbitfun-widget:rendered',
        widgetId: 'widget_1', widgetCode: completedCode,
      }, '*');
      update(completedCode, true);
      expect(Reflect.get(dom.window, 'executionCount')).toBe(1);
    } finally {
      dom.window.close();
    }
  });

  it('writes the widget shell into about:blank instead of relying on srcdoc', async () => {
    await act(async () => {
      root.render(
        <GenerativeWidgetFrame
          widgetId="widget_1"
          title="Widget"
          widgetCode="<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4' /></svg>"
        />,
      );
    });

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    expect(iframe.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(iframe.contentDocument?.documentElement.outerHTML).toContain('openbitfun-widget');
  });
});
