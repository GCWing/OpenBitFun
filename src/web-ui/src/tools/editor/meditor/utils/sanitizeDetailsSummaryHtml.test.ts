// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { sanitizeDetailsSummaryHtml } from './sanitizeDetailsSummaryHtml';

function preview(source: string): HTMLSpanElement {
  const span = document.createElement('span');
  // Reparse at the same kind of sink as the production details summary.
  span.innerHTML = sanitizeDetailsSummaryHtml(source);
  return span;
}

describe('details summary HTML security', () => {
  it.each([
    '<img src="x" onerror="window.__security_probe=1">',
    '<span><img src="x" onerror="window.__security_probe=1"></span>',
    '<div><span><img src="x" onerror="window.__security_probe=1"></span></div>',
    '<strong><span><img src="x" onerror="window.__security_probe=1"></span></strong>',
  ])('removes event handlers at every wrapper depth: %s', (source) => {
    const result = preview(source);
    expect(result.querySelector('img')?.getAttribute('src')).toBe('x');
    expect(result.querySelector('[onerror]')).toBeNull();
    expect(result.querySelector('div, span')).toBeNull();
  });

  it.each([
    'javascript:window.__security_probe=1',
    'java&#x09;script:window.__security_probe=1',
    'java&#x0a;script:window.__security_probe=1',
    'java&#x0d;script:window.__security_probe=1',
    ' &#x01;JaVaScRiPt:window.__security_probe=1',
    'vbscript:msgbox(1)',
    'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;',
    'blob:https://example.com/attacker-document',
    'unknown-app:command',
  ])('removes active or unapproved link protocols: %s', (href) => {
    const result = preview(`<span><a href="${href}">Open</a></span>`);
    expect(result.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(result.textContent).toBe('Open');
  });

  it.each(['java&#x09;script:alert(1)', 'vbscript:alert(1)', 'unknown-app:command'])(
    'removes active or unapproved image protocols: %s', (src) => {
      expect(preview(`<img src="${src}">`).querySelector('img')?.hasAttribute('src')).toBe(false);
    },
  );

  it.each([
    '<svg onload="alert(1)"><foreignObject><img src="x" onerror="alert(1)"></foreignObject></svg>',
    '<span><svg><a href="javascript:alert(1)">Open</a></svg></span>',
    '<math><mtext><img src="x" onerror="alert(1)"></mtext></math>',
    '<template><img src="x" onerror="alert(1)"></template>',
    '<script>alert(1)</script><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
  ])('does not retain active elements or foreign namespaces: %s', (source) => {
    const result = preview(source);
    expect(result.querySelector('svg, math, template, script, iframe, [onerror], [onload]')).toBeNull();
  });

  it('preserves existing safe formatting and image metadata while dropping unsafe attributes', () => {
    const result = preview('<span>Text <strong class="highlight" style="color:red">bold</strong> '
      + '<b>B</b><em>E</em><i>I</i><code class="language-text">&lt;code&gt;</code><br>'
      + '<a href="https://example.com" title="Docs" target="_blank" onclick="alert(1)">Docs</a>'
      + '<img src="../image.png" alt="Image" title="Title" width="32" height="24" align="left" srcset="bad" id="location"></span>');
    expect(result.querySelector('strong')?.className).toBe('highlight');
    expect(result.querySelector('code')?.textContent).toBe('<code>');
    expect(result.querySelectorAll('b, em, i, br')).toHaveLength(4);
    expect(result.querySelector('a')?.getAttribute('title')).toBe('Docs');
    expect(result.querySelector('img')?.outerHTML).toBe('<img src="../image.png" alt="Image" title="Title" width="32" height="24" align="left">');
    expect(result.querySelector('[style], [onclick], [target], [srcset], [id]')).toBeNull();
  });

  it.each(['https://example.com/docs', 'mailto:dev@example.com', '#section', '../README.md',
    '/workspace/README.md', 'file:///workspace/README.md', 'tab:example'])(
    'preserves supported links: %s', (href) => {
      expect(preview(`<a href="${href}">Open</a>`).querySelector('a')?.getAttribute('href')).toBe(href);
    },
  );

  it.each(['https://example.com/a.png', '../a.png', '/workspace/a.png', 'asset://localhost/a.png',
    'tauri://localhost/a.png', 'file:///workspace/a.png', 'blob:https://example.com/id', 'data:image/png;base64,aGVsbG8='])(
    'preserves supported image sources: %s', (src) => {
      expect(preview(`<img src="${src}">`).querySelector('img')?.getAttribute('src')).toBe(src);
    },
  );

  it('fails closed without a DOM', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(sanitizeDetailsSummaryHtml('<img onerror="alert(1)">&lt;'))
        .toBe('&lt;img onerror="alert(1)"&gt;&amp;lt;');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
