import { describe, expect, it } from 'vitest';
import type { ParsedNode, TableNode } from 'stream-markdown-parser';
import { stabilizeThinkingNodes } from './stabilizeThinkingNodes';

describe('thinking node stabilization', () => {
  const code: ParsedNode = {
    type: 'code_block', raw: '```ts\nvalue', code: 'value', language: 'ts', loading: true,
  };

  it('retains equal trees without mutating parser output and drops removed nodes', () => {
    const previous: ParsedNode[] = [code, { type: 'paragraph', raw: 'tail', children: [] }];
    const parsed = structuredClone(previous);
    expect(stabilizeThinkingNodes(parsed, previous)).toBe(previous);
    expect(parsed[0]).not.toBe(code);
    const shortened = stabilizeThinkingNodes([structuredClone(code)], previous);
    expect(shortened).toHaveLength(1);
    expect(shortened[0]).toBe(code);
    expect(stabilizeThinkingNodes([], previous)).toEqual([]);
  });

  it.each([
    { loading: false },
    { language: 'js' },
    { code: 'different' },
    { diff: true },
    { sourceMap: { startLine: 3, endLine: 5 } },
  ])('does not freeze code state when raw text is unchanged: %j', change => {
    const next = { ...code, ...change } as ParsedNode;
    expect(stabilizeThinkingNodes([next], [code])[0]).toBe(next);
  });

  it('compares nested table state even when the table raw text is unchanged', () => {
    const previous: TableNode = {
      type: 'table', raw: '| link |', header: { type: 'table_row', raw: '', cells: [] },
      rows: [{ type: 'table_row', raw: '', cells: [{
        type: 'table_cell', raw: '[link][ref]', header: false, align: 'left',
        children: [{ type: 'link', raw: '[link][ref]', href: '/first', title: null, text: 'link', children: [] }],
      }] }],
    };
    const next = structuredClone(previous);
    next.rows[0].cells[0].align = 'right';
    expect(stabilizeThinkingNodes([next], [previous])[0]).toBe(next);
  });
});
