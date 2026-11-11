import { expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { registerLatexLanguage } from './latex.language';
it('completes an environment inside its braces and keeps symbol selections inside their ranges', () => {
  const complete = vi.fn(), symbols = vi.fn();
  registerLatexLanguage({ languages: {
    register: vi.fn(), setLanguageConfiguration: vi.fn(), setMonarchTokensProvider: vi.fn(),
    registerCompletionItemProvider: complete, registerDocumentSymbolProvider: symbols, registerFoldingRangeProvider: vi.fn(),
    CompletionItemKind: { Snippet: 27, Function: 1, Reference: 18 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    SymbolKind: { Namespace: 2 },
  } } as unknown as typeof Monaco);
  const model = {
    getLineContent: () => '\\begin{fig}', getWordUntilPosition: () => ({ word: 'fig', startColumn: 8, endColumn: 11 }),
    getValue: () => '\\begin{fig}',
  } as unknown as Monaco.editor.ITextModel;
  const suggestions = complete.mock.calls[0]![1].provideCompletionItems(model, { lineNumber: 1, column: 11 }).suggestions;
  expect(suggestions.find((item: { label: string }) => item.label === 'figure')).toMatchObject({
    insertText: 'figure}\n  ${0}\n\\end{figure}', range: { startColumn: 8, endColumn: 12 },
  });
  const source = '\\section{One}\n\\section{Two}';
  const symbolModel = { getValue: () => source, getLineCount: () => 2, getLineMaxColumn: (line: number) => source.split('\n')[line - 1]!.length + 1 };
  const headings = symbols.mock.calls[0]![1].provideDocumentSymbols(symbolModel);
  expect(headings).toHaveLength(2);
  expect(headings[0].range.endColumn).toBe(headings[0].selectionRange.endColumn);
});
