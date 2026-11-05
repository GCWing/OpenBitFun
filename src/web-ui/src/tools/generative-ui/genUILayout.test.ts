import { describe, expect, it } from 'vitest';
import { inspectGenUIHtmlFrame } from './genUILayout';
import { genUICatalog } from './genUIContract';

describe('GenUI HTML frame inspection', () => {
  const specification = {
    viewport: { mode: 'fixed', width: 360, height: 764, unit: 'css-px' },
    shell: { kind: 'phone', statusBarHeight: 36, contentInsets: { top: 0, right: 16, bottom: 0, left: 16 } },
    acceptance: { checks: ['no-horizontal-overflow', 'content-boundary'] },
  } as typeof genUICatalog.designSpecs[string];
  it('accepts visible content in the fixed screen viewport', () => {
    expect(inspectGenUIHtmlFrame({
      viewportWidth: 328,
      viewportHeight: 696,
      clientWidth: 328,
      clientHeight: 696,
      scrollWidth: 328,
      scrollHeight: 696,
      visibleElementCount: 2,
      contentBounds: { left: 0, top: 0, right: 120, bottom: 80 },
    }, specification)).toEqual([]);
  });
  it('rejects blank, overflowing, and out-of-bounds documents', () => {
    expect(inspectGenUIHtmlFrame({
      viewportWidth: 328,
      viewportHeight: 696,
      clientWidth: 328,
      clientHeight: 696,
      scrollWidth: 400,
      scrollHeight: 696,
      visibleElementCount: 0,
      contentBounds: null,
    }, specification)).toEqual(expect.arrayContaining([
      'HTML document has no visible rendered content',
      'HTML document overflows horizontally inside the target viewport',
    ]));
    expect(inspectGenUIHtmlFrame({
      viewportWidth: 328,
      viewportHeight: 696,
      clientWidth: 328,
      clientHeight: 696,
      scrollWidth: 328,
      scrollHeight: 696,
      visibleElementCount: 1,
      contentBounds: { left: -2, top: 0, right: 329, bottom: 40 },
    }, specification)).toContain('HTML document content exceeds the iframe width');
  });
});
