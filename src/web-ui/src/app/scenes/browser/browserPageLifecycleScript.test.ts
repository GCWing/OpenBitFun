import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { BROWSER_WEBVIEW_DOCUMENT_READY_EVENT, createBrowserPageLifecycleScript } from './browserPageLifecycleScript';

function fixture(readyState = 'loading') {
  const invoke = vi.fn(async (..._args: unknown[]) => {});
  const page = Object.assign(new EventTarget(), { top: null as unknown, __TAURI_INTERNALS__: { invoke } });
  page.top = page;
  const document = Object.assign(new EventTarget(), { readyState });
  const location = { href: 'https://example.com/first' };
  const inject = (sequence = 1) => runInNewContext(createBrowserPageLifecycleScript('browser-test', sequence), {
    window: page, document, location,
  });
  const payload = () => (invoke.mock.lastCall?.[1] as { payload: unknown }).payload;
  return { invoke, page, document, location, inject, payload };
}

it('waits for the document to complete and deduplicates its lifecycle signals', () => {
  const view = fixture();
  view.inject();
  view.page.dispatchEvent(new Event('popstate'));
  expect(view.invoke).not.toHaveBeenCalled();
  view.document.readyState = 'complete';
  view.document.dispatchEvent(new Event('readystatechange'));
  view.page.dispatchEvent(new Event('load'));
  view.page.dispatchEvent(new Event('pageshow'));
  expect(view.invoke).toHaveBeenCalledExactlyOnceWith('plugin:event|emit', {
    event: BROWSER_WEBVIEW_DOCUMENT_READY_EVENT,
    payload: { label: 'browser-test', sequence: 1, url: 'https://example.com/first' },
  });
});

it('reports a completed cached document when the native commit arrives after pageshow', () => {
  const view = fixture('complete');
  const subscribe = vi.spyOn(view.page, 'addEventListener');
  view.inject();
  view.page.dispatchEvent(new Event('pageshow'));
  view.inject(2);
  expect(view.payload()).toEqual({ label: 'browser-test', sequence: 2, url: view.location.href });
  expect(view.invoke).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledTimes(4);
});

it('reports same-document back/forward and fragment navigation without requiring load', () => {
  const view = fixture('complete');
  view.inject();
  view.location.href = 'https://example.com/previous';
  view.page.dispatchEvent(new Event('popstate'));
  expect(view.payload()).toEqual({ label: 'browser-test', sequence: 1, url: view.location.href });
  view.location.href += '#section';
  view.page.dispatchEvent(new Event('hashchange'));
  expect(view.payload()).toEqual({ label: 'browser-test', sequence: 1, url: view.location.href });
  expect(view.invoke).toHaveBeenCalledTimes(3);
});

it('does not let a delayed script replace a newer navigation sequence', () => {
  const view = fixture('complete');
  view.inject(2);
  view.inject(1);
  view.location.href = 'https://example.com/next';
  view.page.dispatchEvent(new Event('popstate'));
  expect(view.payload()).toEqual({ label: 'browser-test', sequence: 2, url: view.location.href });
  expect(view.invoke).toHaveBeenCalledTimes(2);
});

it('ignores subframes so their readiness cannot settle the top-level page', () => {
  const view = fixture('complete');
  view.page.top = {};
  view.inject();
  view.page.dispatchEvent(new Event('pageshow'));
  expect(view.invoke).not.toHaveBeenCalled();
});

it('can retry on the next lifecycle event if the event bridge rejects a report', async () => {
  const view = fixture('complete');
  view.invoke.mockRejectedValueOnce(new Error('Bridge unavailable'));
  view.inject();
  await new Promise(resolve => setImmediate(resolve));
  view.page.dispatchEvent(new Event('pageshow'));
  expect(view.invoke).toHaveBeenCalledTimes(2);
});
