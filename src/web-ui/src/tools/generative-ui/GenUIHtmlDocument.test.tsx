// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GENUI_HTML_RUNTIME, inspectGenUIHtmlSource, sanitizeGenUIHtmlSource } from './GenUIHtmlDocument';
import { genUICatalog } from './genUIContract';

describe('GenUI HTML documents', () => {
  it('uses the catalogued host runtime revisions', () => {
    expect(GENUI_HTML_RUNTIME).toEqual(genUICatalog.htmlRuntime);
  });

  it('keeps HTML/SVG content while removing active and unsafe host paths', () => {
    const result = sanitizeGenUIHtmlSource({
      kind: 'html-document',
      html: '<section onclick="alert(1)"><svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><path /></a></svg><script>window.bad = true</script></section>',
      css: '@import url(https://example.invalid/style.css); section { width: 100%; }',
      script: 'window.openbitfunWidget.send({ kind: "event" })',
    });
    expect(result.document).toContain('<svg');
    expect(result.document).not.toContain('<script');
    expect(result.document).not.toContain('onclick');
    expect(result.document).not.toContain('javascript:');
    expect(result.document).toContain('section { width: 100%; }');
    expect(result.document).toContain("Content-Security-Policy");
    expect(result.document).toContain("script-src 'none'");
    expect(result.diagnostics).toContain('Controlled script execution is disabled on this host');
  });

  it('only emits executable script and the bridge CSP when the owner enables it', () => {
    const source = { kind: 'html-document' as const, html: '<p>bridge</p>', script: 'window.openbitfunWidget.request("echo", {value: 1}); eval("blocked")' };
    const disabled = sanitizeGenUIHtmlSource(source, genUICatalog.designSpecs?.['openbitfun.desktop.v1']);
    expect(disabled.document).toContain("script-src 'none'");
    expect(disabled.diagnostics).toContain('Controlled script execution is disabled on this host');
    const enabled = sanitizeGenUIHtmlSource(source, genUICatalog.designSpecs?.['openbitfun.desktop.v1'], '', true);
    expect(enabled.document).toContain('openbitfunWidget');
    expect(enabled.document).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(enabled.document).toMatch(/<script nonce="[0-9a-f]+">/);
    expect(enabled.document).toContain('blocked eval');
    expect(enabled.diagnostics).not.toContain('Controlled script execution is disabled on this host');
  });




  it('can opt HtmlView into a local inline animation script without opening a host bridge', () => {
    const source = sanitizeGenUIHtmlSource(
      { kind: 'html-document', html: '<canvas id="pendulum"></canvas><script>requestAnimationFrame(() => {}); eval("blocked")</script>' },
      undefined,
      '',
      true,
      false,
      true,
    );
    expect(source.document).toContain('<canvas id="pendulum"></canvas>');
    expect(source.document).toContain('requestAnimationFrame');
    expect(source.document).toContain('blocked eval');
    expect(source.document).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(source.document).not.toContain('<script>requestAnimationFrame');
    expect(source.diagnostics).not.toContain('Controlled script execution is disabled on this host');
  });

  it('adds only a host-owned inspection probe when delivery checking is enabled', () => {
    const result = sanitizeGenUIHtmlSource(
      { kind: 'html-document', html: '<section><svg viewBox="0 0 10 10" /></section>', script: 'window.bad = true' },
      genUICatalog.designSpecs?.['openbitfun.desktop.v1'],
      '',
      false,
      true,
    );
    expect(result.document).toContain('openbitfun.genui.inspection.report');
    expect(result.document).not.toContain('window.bad = true');
    expect(result.document).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(result.document).toMatch(/<script nonce="[0-9a-f]+">/);
    expect(result.diagnostics).toContain('Controlled script execution is disabled on this host');
  });
});
