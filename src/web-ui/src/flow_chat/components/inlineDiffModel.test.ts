import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './inlineDiffModel';

describe('inline diff presentation', () => {
  it('preserves complete replacement lines and their source numbers', () => {
    const before = '  if (!res) throw new Error("User not found");';
    const after = '  if (!res) return null;';
    const lines = computeLineDiff(`async function fetchUser() {\n${before}\n}`, `async function fetchUser() {\n${after}\n}`);

    expect(lines.map(line => line.type)).toEqual(['unchanged', 'removed', 'added', 'unchanged']);
    expect(lines[1].content).toBe(before);
    expect(lines[2].content).toBe(after);
    expect(lines[1].originalLineNumber).toBe(2);
    expect(lines[2].modifiedLineNumber).toBe(2);
    expect(lines[3].modifiedLineNumber).toBe(3);
  });

  it('keeps source line numbers after additions instead of using the rendered row index', () => {
    const lines = computeLineDiff('first\nlast\n', 'first\ninserted\nlast\n');
    expect(lines.map(line => [line.originalLineNumber, line.modifiedLineNumber])).toEqual([
      [1, 1], [undefined, 2], [2, 3],
    ]);
  });

  it('preserves both sides of a replacement with an extra inserted line', () => {
    const lines = computeLineDiff(
      'const first = 1;\nconst second = 2;',
      'const first = 10;\nlog(first);\nconst second = 20;',
    );
    const removed = lines.filter(line => line.type === 'removed');
    const added = lines.filter(line => line.type === 'added');
    expect(removed.map(line => line.content)).toEqual(['const first = 1;', 'const second = 2;']);
    expect(added.map(line => line.content)).toEqual(['const first = 10;', 'log(first);', 'const second = 20;']);
    expect(added.map(line => line.modifiedLineNumber)).toEqual([1, 2, 3]);
  });

  it('preserves whitespace and Unicode in changed lines', () => {
    const lines = computeLineDiff('  return "你好 🌍";', '\treturn "你好 🌏";');
    expect(lines.map(line => line.type)).toEqual(['removed', 'added']);
    expect(lines[0].content).toBe('  return "你好 🌍";');
    expect(lines[1].content).toBe('\treturn "你好 🌏";');
  });

  it('uses only the line treatment for complete file creation or deletion', () => {
    expect(computeLineDiff('', 'one\ntwo\n').map(line => line.type)).toEqual(['added', 'added']);
    expect(computeLineDiff('one\ntwo\n', '').map(line => line.type)).toEqual(['removed', 'removed']);
    expect(computeLineDiff('', '')).toEqual([]);
  });

  it('keeps long replacement lines intact', () => {
    const before = 'before '.repeat(2_000);
    const after = 'after '.repeat(2_000);
    const lines = computeLineDiff(before, after);
    expect(lines.map(line => line.content)).toEqual([before, after]);
    expect(lines.map(line => line.type)).toEqual(['removed', 'added']);
  });

  it('retains unchanged context between separate change blocks', () => {
    const lines = computeLineDiff('left(1);\nkeep();\nright(2);', 'left(3);\nkeep();\nright(4);');
    expect(lines.map(line => line.type)).toEqual(['removed', 'added', 'unchanged', 'removed', 'added']);
    expect(lines[2]).toMatchObject({ content: 'keep();', originalLineNumber: 2, modifiedLineNumber: 2 });
  });
});
