import { expect, it } from 'vitest';
import { latexOutline, latexRoot, latexRootHint, latexVisibleLine, LATEX_SNIPPETS } from './latexDocument';
it('ignores commented sections and preserves escaped percent signs', () => {
  expect(latexVisibleLine('A \\% value % comment')).toBe('A \\% value ');
  expect(latexOutline('% \\section{Hidden}\n\\section{Introduction}\n\\subsection*{A \\textbf{result}}')).toEqual([
    { line: 2, level: 2, title: 'Introduction' }, { line: 3, level: 3, title: 'A result' },
  ]);
});
it('resolves project roots without using controller OS path semantics', () => {
  expect(latexRoot('/paper/chapters/section.tex', '../main.tex')).toBe('/paper/main.tex');
  expect(latexRoot('C:\\paper\\section.tex', 'main.tex')).toBe('C:/paper/main.tex');
  expect(latexRoot('/paper/section.tex', '')).toBe('/paper/section.tex');
  expect(latexRoot('/main.tex', '../paper.tex')).toBe('/paper.tex');
  expect(latexOutline('\\section{Title}\\label{sec:title}')[0]?.title).toBe('Title');
  expect(latexRootHint('% !TeX root = ../main.tex')).toBe('../main.tex');
});
it('provides editable snippets rather than inserting fixed placeholder content', () => {
  expect(LATEX_SNIPPETS.equation).toContain('${1:E = mc^2}');
  expect(LATEX_SNIPPETS.table).toContain('\\end{tabular}');
});
