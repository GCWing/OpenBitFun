import { expect, it } from 'vitest';
import { latexBodyInsertionOffset, latexOutline, latexRoot, latexRootHint, latexVisibleLine, LATEX_SNIPPETS } from './latexDocument';
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
it.each(['\n', '\r\n'])('finds the real body marker after commented and escaped examples with %j line endings', eol => {
  const source = ['% \\begin{document}', '\\\\begin{document}', '\\documentclass{article}', '\\begin{document} % body', 'Existing text', '\\end{document}'].join(eol);
  const body = source.indexOf(' % body');
  expect(latexBodyInsertionOffset(source, 0)).toBe(body);
  expect(latexBodyInsertionOffset(source, source.indexOf('Existing text'))).toBeUndefined();
});
it('keeps chapter fragments and body selections at their original position', () => {
  expect(latexBodyInsertionOffset('\\section{Chapter}\nText', 0)).toBeUndefined();
  const source = '\\documentclass{article}\\begin{document}Text\\end{document}';
  const body = source.indexOf('Text');
  expect(latexBodyInsertionOffset(source, 0)).toBe(body);
  expect(latexBodyInsertionOffset(source, body)).toBeUndefined();
  expect(latexBodyInsertionOffset('\\begin{document}', 0)).toBe('\\begin{document}'.length);
});
