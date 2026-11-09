import type * as Monaco from 'monaco-editor';

export function registerLatexLanguage(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'] });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }],
  });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/\\(?:[A-Za-z@]+|.)/, 'keyword'],
        [/%.*$/, 'comment'],
        [/\$\$?/, 'delimiter'],
        [/[{}\[\]]/, '@brackets'],
      ],
    },
  });
}
