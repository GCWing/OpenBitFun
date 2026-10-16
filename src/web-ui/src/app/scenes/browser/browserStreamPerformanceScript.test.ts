// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { STREAM_RENDER_OPTIMIZATION_SCRIPT } from './browserStreamPerformanceScript';

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('openbitfun-stream-render-optimization')?.remove();
  Reflect.deleteProperty(window, '__openbitfun_stream_render_optimized');
  vi.unstubAllGlobals();
});

it('applies stream styles without installing permanent sampling loops or debug uploads', () => {
  document.body.innerHTML = '<div id="stage"><canvas id="screen"></canvas></div>';
  vi.stubGlobal('location', { hostname: '127.0.0.1', port: '41953' });
  const raf = vi.fn();
  const interval = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('setInterval', interval);
  vi.stubGlobal('fetch', fetch);
  new Function(STREAM_RENDER_OPTIMIZATION_SCRIPT)();
  expect(document.getElementById('openbitfun-stream-render-optimization')).not.toBeNull();
  expect(raf).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
