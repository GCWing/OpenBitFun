// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const source = readSource('../../../../../../design-system/packages/ui/src/flow-chat/conversation/FlowItemRhythm.css');
const selector = source.split('flex: 0 0 100%;')[0].split('}').at(-1)!.split('{')[0].trim();
const previous = `${selector.slice(0, selector.indexOf('> :where('))}> *`;

describe('mixed agent-card row composition', () => {
  it.each(['data-flow-item-stack', 'explore-region__content', 'flow-group-content-segment'])(
    'preserves full-width children in %s without selecting unrelated shell nodes', stack => {
      const host = document.createElement('div');
      host.innerHTML = `<nav><button>Unrelated</button></nav><main>
        <div ${stack === 'data-flow-item-stack' ? 'data-flow-item-stack=""' : `class="${stack}"`}>
          <div class="model-round-item__meta">Routing</div>
          <div class="model-round-item__continuation">Continuation</div>
          <div class="model-round-item__retry-history">Previous attempt</div>
          <div class="flow-thinking-item" data-thinking-attachment="side">Reasoning</div>
          <div class="flowchat-flow-item"><div class="flow-tool-card-wrapper"><div data-openbitfun-tool-card="agent-control">Agent</div></div></div>
          <div class="flowchat-flow-item" hidden>Hidden tool</div>
          <span class="flowchat-capsule-row-break"></span>
          <div class="flow-text-block"><p>Text</p><pre>Code</pre></div>
          <div class="explore-region">Collapsed collection</div>
          <div class="flow-group-content-segment">Deferred segment</div>
          <div class="subagent-projection-text--truncated">Subagent preview</div>
          <div class="model-round-item__footer">Metrics</div>
        </div></main>`;
      const matched = new Set(host.querySelectorAll(selector));
      expect(matched).toEqual(new Set(host.querySelectorAll(previous)));
      expect(matched.size).toBe(12);
      expect(matched.has(host.querySelector('nav')!)).toBe(false);
      host.querySelector('[data-openbitfun-tool-card]')!.remove();
      const fresh = host.cloneNode(true) as HTMLElement;
      expect(fresh.querySelectorAll(selector)).toHaveLength(0);
    },
  );
});
