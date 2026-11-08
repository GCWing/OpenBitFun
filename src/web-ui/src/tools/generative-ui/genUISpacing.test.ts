// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const sheets = [readSource('./components/components.scss'), readSource('./components/openui/components.css')];

describe('generated content spacing selector equivalence', () => {
  it('keeps gaps on the same mixed element children through insertion, hiding and removal', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="gen-ui-oi-flow"><p hidden>Hidden first</p>text
        <section class="gen-ui-oi-flow"><button>A</button><!-- comment --><div>B</div></section>
        <div class="gen-ui-oi-markdown"><h2>Heading</h2>text<p>Paragraph</p><ul><li>List</li></ul><pre>Code</pre><table><tbody><tr><td>Cell</td></tr></tbody></table></div>
      </div>
      <div class="iui-flow"><div class="iui-title">Title</div><p class="iui-text">Text</p>
        <section class="iui-card iui-flow"><p hidden>Hidden</p><input><button>Action</button></section>
        <div class="iui-flow"><div>A</div><hr><div>B</div></div>
        <div class="iui-markdown"><p>Prose</p><h2 class="iui-md-h">Heading</h2><ul><li>A</li></ul><blockquote>Quote</blockquote><div>Raw block</div></div>
      </div>`;
    const rules = sheets.flatMap(source => [...source.matchAll(/([^{}\n]+)\{\s*margin-top:\s*([^;}]+);?\s*\}/g)])
      .filter(match => match[1].includes(':where(:not(:first-child))'));
    expect(rules).toHaveLength(5);
    const verify = () => {
      // Query a fresh tree: jsdom caches structural-pseudo matches across
      // queries on mutated nested stacks. Native mutation coverage is separate.
      const snapshot = host.cloneNode(true) as HTMLElement;
      for (const [, selector] of rules) {
        const legacy = selector.replace('> :where(:not(:first-child))', '> * + *');
        expect(new Set(snapshot.querySelectorAll(selector.trim()))).toEqual(new Set(snapshot.querySelectorAll(legacy.trim())));
      }
    };
    verify();
    for (const parent of host.querySelectorAll('.iui-flow, .gen-ui-oi-flow, .iui-markdown, .gen-ui-oi-markdown')) {
      const node = document.createElement('aside');
      parent.prepend(node); verify();
      node.hidden = true; verify();
      node.remove(); verify();
    }
  });
});
