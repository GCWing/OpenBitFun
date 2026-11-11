export interface LatexHeading { title: string; line: number; level: number }
export function latexVisibleLine(line: string): string {
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '%') continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && line[before] === '\\'; before--) escapes++;
    if (escapes % 2 === 0) return line.slice(0, index);
  }
  return line;
}
export function latexOutline(source: string): LatexHeading[] {
  const levels = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
  return source.split('\n').flatMap((raw, index) => {
    const line = latexVisibleLine(raw);
    const match = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{/.exec(line);
    if (!match) return [];
    const start = match.index + match[0].length;
    let depth = 1, end = start;
    for (; end < line.length; end++) {
      if (line[end] === '\\') { end++; continue; }
      if (line[end] === '{') depth++;
      if (line[end] === '}' && --depth === 0) break;
    }
    return depth === 0 ? [{ line: index + 1, level: levels.indexOf(match[1]!),
      title: line.slice(start, end).replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1') }] : [];
  });
}
export function latexRoot(sourcePath: string, hint: string): string {
  if (!hint.trim()) return sourcePath;
  const normalized = hint.trim().replace(/\\/g, '/');
  const base = sourcePath.replace(/\\/g, '/').replace(/[^/]*$/, '');
  const combined = /^(\/|[a-z]:\/)/i.test(normalized) ? normalized : base + normalized;
  const prefix = combined.startsWith('//') ? '//' : combined.startsWith('/') ? '/' : /^[a-z]:\//i.exec(combined)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of combined.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && parts.at(-1) !== '..') parts.pop(); else if (!prefix) parts.push(part); }
    else parts.push(part);
  }
  return prefix + parts.join('/');
}
export function latexRootHint(source: string): string | undefined {
  return /^%\s*!\s*TeX\s+root\s*=\s*(.+)$/im.exec(source)?.[1]?.trim();
}
export const LATEX_SNIPPETS = {
  section: '\\section{${1:Title}}\n${0}',
  equation: '\\begin{equation}\n  ${1:E = mc^2}\n  \\label{eq:${2:energy}}\n\\end{equation}\n${0}',
  figure: '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${1:0.8}\\linewidth]{${2:figure.pdf}}\n  \\caption{${3:Caption}}\n  \\label{fig:${4:example}}\n\\end{figure}\n${0}',
  table: '\\begin{table}[htbp]\n  \\centering\n  \\caption{${1:Caption}}\n  \\label{tab:${2:example}}\n  \\begin{tabular}{${3:ll}}\n    \\hline\n    ${4:Column A & Column B} \\\\\n    \\hline\n    ${5:Value A & Value B} \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}\n${0}',
  cite: '\\cite{${1:key}}${0}',
  reference: '\\ref{${1:label}}${0}',
  bibliography: '\\bibliographystyle{${1:plain}}\n\\bibliography{${2:refs}}\n${0}',
  itemize: '\\begin{itemize}\n  \\item ${1:Item}\n\\end{itemize}\n${0}',
} as const;
export type LatexSnippetName = keyof typeof LATEX_SNIPPETS;
