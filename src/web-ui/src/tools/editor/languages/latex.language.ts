import type * as Monaco from 'monaco-editor';
import { LATEX_SNIPPETS, latexOutline, latexVisibleLine } from '../utils/latexDocument';

const COMMANDS = ['documentclass', 'usepackage', 'title', 'author', 'date', 'maketitle', 'abstract',
  'section', 'subsection', 'subsubsection', 'paragraph', 'textbf', 'textit', 'emph', 'footnote',
  'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'include', 'input', 'includegraphics', 'caption',
  'bibliography', 'bibliographystyle', 'frac', 'sqrt', 'sum', 'int', 'alpha', 'beta', 'gamma', 'theta', 'lambda'];
const ENVIRONMENTS = ['document', 'abstract', 'equation', 'align', 'align*', 'figure', 'table', 'tabular',
  'itemize', 'enumerate', 'description', 'theorem', 'proof', 'verbatim'];
export function registerLatexLanguage(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'] });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' }, brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '$', close: '$' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '$', close: '$' }],
    indentationRules: { increaseIndentPattern: /\\begin\{(?!document)[^}]+\}|\{\s*$/, decreaseIndentPattern: /^\s*(\\end\{|\})/ },
  });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: { root: [[/\\(?:[A-Za-z@]+|.)/, 'keyword'], [/%.*$/, 'comment'], [/\$\$?/, 'delimiter'], [/[{}[\]]/, '@brackets']] },
  });
  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\', '{', ','],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const startColumn = before.endsWith('\\') ? word.startColumn - 1 : word.startColumn;
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn, endColumn: word.endColumn };
      const source = model.getValue().split('\n').map(latexVisibleLine).join('\n');
      const labels = [...source.matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1]!);
      const citations = [...source.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(match => match[1]!);
      const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (/\\(begin|end)\{[^}]*$/.test(prefix)) {
        const opening = /\\begin\{[^}]*$/.test(prefix);
        const trailingBrace = model.getLineContent(position.lineNumber)[position.column - 1] === '}';
        return { suggestions: ENVIRONMENTS.map(environment => ({ label: environment,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: opening ? `${environment}}\n  \u0024{0}\n\\end{${environment}}` : environment,
          range: opening && trailingBrace ? { ...range, endColumn: range.endColumn + 1 } : range,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })) };
      }
      const references = /\\(?:ref|eqref|autoref)\{[^}]*$/.test(prefix) ? labels
        : /\\cite[a-z]*\{[^}]*$/.test(prefix) ? citations : [];
      if (references.length) return { suggestions: [...new Set(references)].map(label => ({ label,
        kind: monaco.languages.CompletionItemKind.Reference, insertText: label, range })) };
      return { suggestions: [
        ...Object.entries(LATEX_SNIPPETS).map(([label, insertText]) => ({ label: `\\${label}`,
          kind: monaco.languages.CompletionItemKind.Snippet, insertText, range,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
        ...COMMANDS.map(command => ({ label: `\\${command}`, kind: monaco.languages.CompletionItemKind.Function,
          insertText: `\\${command}{\u0024{1}}`, range, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
        ...ENVIRONMENTS.map(environment => ({ label: `\\begin{${environment}}`, kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `\\begin{${environment}}\n  \u0024{0}\n\\end{${environment}}`, range,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
      ] };
    },
  });
  monaco.languages.registerDocumentSymbolProvider('latex', {
    provideDocumentSymbols(model) {
      const headings = latexOutline(model.getValue());
      return headings.map((heading, index) => {
        const endLine = (headings.slice(index + 1).find(next => next.level <= heading.level)?.line ?? model.getLineCount() + 1) - 1;
        return { name: heading.title, detail: '', kind: monaco.languages.SymbolKind.Namespace, tags: [],
          range: { startLineNumber: heading.line, startColumn: 1, endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine) },
          selectionRange: { startLineNumber: heading.line, endLineNumber: heading.line, startColumn: 1, endColumn: model.getLineMaxColumn(heading.line) },
        };
      });
    },
  });
  monaco.languages.registerFoldingRangeProvider('latex', {
    provideFoldingRanges(model) {
      const stack: Array<{ name: string; line: number }> = [];
      const ranges: Monaco.languages.FoldingRange[] = [];
      for (let line = 1; line <= model.getLineCount(); line++) {
        const text = latexVisibleLine(model.getLineContent(line));
        for (const match of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
          if (match[1] === 'begin') stack.push({ name: match[2]!, line });
          else if (stack.at(-1)?.name === match[2]) {
            const open = stack.pop()!;
            if (line > open.line) ranges.push({ start: open.line, end: line, kind: monaco.languages.FoldingRangeKind.Region });
          }
        }
      }
      return ranges;
    },
  });
}
