import { describe, expect, it } from 'vitest';
import { projectGrepSearchResults } from '../src/search';

describe('Grep result presentation', () => {
  it('groups consecutive results by file and preserves code, indentation and empty snippets', () => {
    expect(projectGrepSearchResults([
      'src/app/App.tsx:1:import { lazy } from "react";',
      'src/app/App.tsx:13:  const url = "http://localhost:1420";',
      'src/lib.ts:99:',
    ].join('\n'))).toEqual([
      { kind: 'file', path: 'src/app/App.tsx', lines: [
        { kind: 'match', lineNumber: 1, text: 'import { lazy } from "react";' },
        { kind: 'match', lineNumber: 13, text: '  const url = "http://localhost:1420";' },
      ] },
      { kind: 'file', path: 'src/lib.ts', lines: [
        { kind: 'match', lineNumber: 99, text: '' },
      ] },
    ]);
  });

  it.each([
    'C:\\work space\\src\\app.ts',
    '/remote/work space/src/app.ts',
    '//server/share/src/app.ts',
    '"src/colon:name.ts"',
    '"src/line\\nbreak.ts"',
  ])('keeps the display path intact: %s', path => {
    expect(projectGrepSearchResults(path + ':42:\tlet label = "搜索";  \r\n' + path + ':43:next()')).toEqual([
      { kind: 'file', path, lines: [
        { kind: 'match', lineNumber: 42, text: '\tlet label = "搜索";  ' },
        { kind: 'match', lineNumber: 43, text: 'next()' },
      ] },
    ]);
  });

  it('keeps native context lines and represents an internal context break as spacing', () => {
    expect(projectGrepSearchResults([
      'src/a.ts-9:  before()',
      'src/a.ts:10:  needle()',
      '--',
      'src/a.ts-40:  beforeAgain()',
      'src/a.ts:41:  needleAgain()',
    ].join('\n'), { outputMode: 'content' })).toEqual([
      { kind: 'file', path: 'src/a.ts', lines: [
        { kind: 'context', lineNumber: 9, text: '  before()' },
        { kind: 'match', lineNumber: 10, text: '  needle()' },
        { kind: 'context', lineNumber: 40, text: '  beforeAgain()', gapBefore: true },
        { kind: 'match', lineNumber: 41, text: '  needleAgain()' },
      ] },
    ]);
  });

  it('retains notices, unfamiliar lines, truncated previews and source order', () => {
    const blocks = projectGrepSearchResults([
      'Note: results may predate the latest edit.',
      '',
      'src/a.ts:1:first()',
      'unfamiliar output',
      'src/b.ts:2:second()',
      'src/a.ts:3:third()',
      '...[truncated for session view]',
    ].join('\n'));
    expect(blocks).toEqual([
      { kind: 'text', text: 'Note: results may predate the latest edit.\n' },
      { kind: 'file', path: 'src/a.ts', lines: [{ kind: 'match', lineNumber: 1, text: 'first()' }] },
      { kind: 'text', text: 'unfamiliar output' },
      { kind: 'file', path: 'src/b.ts', lines: [{ kind: 'match', lineNumber: 2, text: 'second()' }] },
      { kind: 'file', path: 'src/a.ts', lines: [{ kind: 'match', lineNumber: 3, text: 'third()' }] },
      { kind: 'text', text: '... Output truncated for session preview' },
    ]);
  });

  it.each([
    { outputMode: 'count' },
    { outputMode: 'files_with_matches' },
    { outputMode: 'future-format' },
    { showLineNumbers: false },
    { multiline: true },
  ])('does not interpret another output format as numbered content: %j', options => {
    const text = 'src/a.ts:12:body\ncontinued text';
    expect(projectGrepSearchResults(text, options)).toEqual([{ kind: 'text', text }]);
  });

  it.each([
    'src/index.ts:12',
    'src/index.ts',
    'No matches found',
    'src/file-12:23:ambiguous',
    'src/index.ts:9007199254740992:unsafe line number',
  ])('preserves unstructured and ambiguous historical output: %s', text => {
    expect(projectGrepSearchResults(text)).toEqual([{ kind: 'text', text }]);
  });

  it('preserves a trailing context separator and standalone truncation notice', () => {
    expect(projectGrepSearchResults('src/a.ts:1:hit\n--').at(-1)).toEqual({ kind: 'text', text: '--' });
    expect(projectGrepSearchResults('[truncated for session view]')).toEqual([
      { kind: 'text', text: 'Output omitted from session preview' },
    ]);
    expect(projectGrepSearchResults('')).toEqual([]);
  });
});
