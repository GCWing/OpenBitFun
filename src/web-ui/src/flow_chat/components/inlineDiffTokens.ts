import Prism from 'prismjs';
// Prism's base bundle only includes JavaScript, markup, CSS, and C-like syntax.
// Register these small extensions so TS/TSX previews do not depend on an editor
// or a separate Markdown highlighter having loaded earlier in the session.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

export type PrismToken = string | Prism.Token;
export type LineTokens = PrismToken[];

function childrenOf(token: Prism.Token): PrismToken[] {
  return Array.isArray(token.content) ? token.content : [token.content];
}

/** Preserve nested syntax scopes even when a token spans several lines. */
export function splitTokensByNewlines(tokens: LineTokens): LineTokens[] {
  const lines: LineTokens[] = [[]];
  for (const token of tokens) {
    const tokenLines = typeof token === 'string'
      ? token.split('\n').map(part => part ? [part] : [])
      : splitTokensByNewlines(childrenOf(token)).map(children =>
          children.length > 0 ? [new Prism.Token(token.type, children, token.alias)] : []);

    tokenLines.forEach((parts, index) => {
      if (index > 0) lines.push([]);
      lines[lines.length - 1].push(...parts);
    });
  }
  return lines;
}
