// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTitlebar } from '../../../../../../shared/miniapp-chrome/titlebar';
import icons from '../../../../../../shared/miniapp-chrome/icons.generated.json';
import windowLabels from '../../../../../../shared/miniapp-chrome/labels.generated.json';
import { mountMiniAppChat } from '../../../../../../apps/miniapp-shell/src/miniapp-chat';
import chatLabels from '../../../../../../apps/miniapp-shell/src/chat-labels.json';

const html = readFileSync(resolve(process.cwd(), '../apps/miniapp-shell/src/shell.html'), 'utf8');
const source = html.slice(html.indexOf('(() => {'), html.indexOf('</script>'));
const labels = { ...windowLabels['en-US'], titlebar: 'Window controls', openTab: 'Return to app', retry: 'Retry', transferWarning: 'Save first', transferring: 'Opening', transferFailed: 'Transfer failed' };
const bootstrap = {
  presentationCapabilities: ['miniapp_custom_chrome_v1'], locale: 'en-US', appearanceMode: 'dark', ui: labels,
  instance: { primaryView: { kind: 'window' } },
  app: { name: 'Notes', compiled_html: '<html>Notes</html>', chrome: { titlebar: { title: 'Custom Notes' } } },
};
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
let listeners: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = html.split('</head><body>')[1].split('<script')[0];
  listeners = vi.spyOn(window, 'addEventListener');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:miniapp', revokeObjectURL: vi.fn() });
});
afterEach(() => {
  for (const [name, handler] of listeners.mock.calls) window.removeEventListener(name, handler);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __MINIAPP_PLATFORM__?: unknown }).__MINIAPP_PLATFORM__;
});

function run(overrides: Record<string, (request: { operation: string; params?: Record<string, unknown> }) => unknown> = {}, platform = 'windows') {
  const call = vi.fn(async (_command, { request }: { request: { operation: string; params?: Record<string, unknown> } }) => {
    if (overrides[request.operation]) return overrides[request.operation](request);
    if (request.operation === 'bootstrap') return bootstrap;
    if (request.operation === 'windowState') return { maximized: false, fullscreen: false };
    if (request.operation === 'poll') return new Promise(() => {});
    return null;
  });
  Object.assign(window, { __TAURI__: { core: { invoke: call } }, __MINIAPP_PLATFORM__: platform });
  new Function('mountTitlebar', 'icons', 'windowLabels', 'mountMiniAppChat', 'chatLabels', source)(mountTitlebar, icons, windowLabels, mountMiniAppChat, chatLabels);
  return call;
}

describe('MiniApp Shell presentation handoff', () => {
  it('gates the dedicated launcher on the existing authorized SDK claim', async () => {
    run({ local: () => Promise.reject(new Error('MiniApp lacks permission')) });
    await flush();
    const frame = document.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { id: 'foreign', method: 'chat.claimComposer' } }));
    expect(document.querySelector<HTMLElement>('#miniapp-chat')!.hidden).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: 'claim', method: 'chat.claimComposer' } }));
    await flush();
    expect(document.querySelector<HTMLElement>('#miniapp-chat')!.hidden).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 'claim', error: expect.objectContaining({ message: expect.stringContaining('lacks permission') }) }), '*');
  });

  it('keeps the old SDK message route and does not request snapshots from an old host', async () => {
    const call = run();
    await flush();
    const frame = document.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const rpc = async (method: string, params = {}) => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: method, method, params } }));
      await flush();
    };
    await rpc('chat.claimComposer');
    expect(document.querySelector<HTMLElement>('#miniapp-chat')!.hidden).toBe(false);
    await rpc('chat.setComposerDraft', { text: 'Build an outline' });
    document.querySelector<HTMLFormElement>('#miniapp-chat form')!.requestSubmit();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'openbitfun:event', event: 'chat:userMessage', payload: expect.objectContaining({ text: 'Build an outline', requestId: expect.any(String) }) }), '*');
    await rpc('chat.focusSession', { sessionId: 'owned' });
    expect(call.mock.calls.some(([, { request }]) => request.operation === 'chatSnapshot')).toBe(false);
    await rpc('chat.releaseComposer');
    expect(document.querySelector<HTMLElement>('#miniapp-chat')!.hidden).toBe(true);
  });

  it('does not let a late authorization restore a released composer', async () => {
    let authorize!: () => void;
    run({ local: () => new Promise<void>(resolve => { authorize = resolve; }) });
    await flush();
    const frame = document.querySelector('iframe')!;
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: 'claim', method: 'chat.claimComposer' } }));
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: 'release', method: 'chat.releaseComposer' } }));
    authorize(); await flush();
    expect(document.querySelector<HTMLElement>('#miniapp-chat')!.hidden).toBe(true);
  });

  it('requests an app-owned snapshot only when the host advertises it', async () => {
    const snapshot = vi.fn(() => ({ sessionId: 'owned', turns: [{ id: 'turn', user: 'Saved question', status: 'completed', rounds: [{ id: 'round', text: 'Saved answer' }] }] }));
    run({ bootstrap: () => ({ ...bootstrap, presentationCapabilities: ['miniapp_custom_chrome_v1', 'miniapp_chat_snapshot_v1'] }), chatSnapshot: snapshot });
    await flush();
    const frame = document.querySelector('iframe')!;
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: 'claim', method: 'chat.claimComposer' } }));
    await flush();
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { id: 'focus', method: 'chat.focusSession', params: { sessionId: 'owned' } } }));
    await flush();
    expect(snapshot).toHaveBeenCalledWith({ operation: 'chatSnapshot', params: { sessionId: 'owned' } });
    expect(document.querySelector('#miniapp-chat')!.textContent).toContain('Saved answer');
  });

  it('keeps the source open until the host releases it and coalesces return clicks', async () => {
    let release!: (value: unknown) => void;
    const call = run({ tab: () => new Promise(() => {}), poll: () => new Promise(resolve => { release = resolve; }) });
    await flush();
    document.querySelector('iframe')!.dispatchEvent(new Event('load'));
    await flush();
    const transfer = document.querySelector<HTMLButtonElement>('[data-window-action="tab"]')!;
    transfer.click(); transfer.click();
    await flush();
    const operations = () => call.mock.calls.map(([, value]) => value.request.operation);
    expect(operations().filter(operation => operation === 'tab')).toHaveLength(1);
    expect(operations()).not.toContain('close');
    release({ released: true });
    await flush();
    expect(operations()).toContain('close');
  });

  it('retains and re-enables the source when the destination fails', async () => {
    const call = run({ tab: () => Promise.reject(new Error('Destination unavailable')) });
    await flush();
    document.querySelector('iframe')!.dispatchEvent(new Event('load'));
    await flush();
    const transfer = document.querySelector<HTMLButtonElement>('[data-window-action="tab"]')!;
    transfer.click();
    await flush();
    expect(transfer.disabled).toBe(false);
    expect(document.querySelector('#status-text')?.textContent).toContain('Destination unavailable');
    expect(call.mock.calls.map(([, value]) => value.request.operation)).not.toContain('close');
  });

  it('uses the default custom titlebar when an older host does not advertise chrome support', async () => {
    run({ bootstrap: () => ({ ...bootstrap, presentationCapabilities: undefined }) });
    await flush();
    expect(document.querySelector('.miniapp-titlebar__title')?.textContent).toBe('Notes');
    expect(document.querySelector<HTMLButtonElement>('[data-window-action="close"]')?.disabled).toBe(false);
  });

  it('keeps close usable on connection failure', async () => {
    const call = run({ bootstrap: () => Promise.reject(new Error('Host offline')) });
    await flush();
    const close = document.querySelector<HTMLButtonElement>('[data-window-action="close"]')!;
    expect(close.disabled).toBe(false);
    close.click();
    await flush();
    expect(call.mock.calls.map(([, value]) => value.request.operation)).toContain('close');
  });

  it('preserves native macOS controls and resize while keeping the return icon on host failure', async () => {
    const call = run({ bootstrap: () => Promise.reject(new Error('Host offline')) }, 'macos');
    await flush();
    expect(document.querySelector('.miniapp-titlebar')?.getAttribute('data-platform')).toBe('macos');
    expect(document.querySelector('.window-controls')).toBeNull();
    expect(document.querySelector('#resize-borders')?.childElementCount).toBe(0);
    expect(document.querySelector<HTMLElement>('#resize-borders')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-window-action="tab"]')?.disabled).toBe(true);
    document.querySelector('#titlebar')!.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    await flush();
    expect(call.mock.calls.map(([, value]) => value.request.operation)).toContain('titlebarDoubleClick');
  });
});
