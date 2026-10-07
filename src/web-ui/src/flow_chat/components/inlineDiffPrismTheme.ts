import type { CSSProperties } from 'react';
import type Prism from 'prismjs';

type SyntaxRole = 'comment' | 'punctuation' | 'keyword' | 'declaration' | 'function'
  | 'string' | 'number' | 'property' | 'variable' | 'operator';

const syntaxColors: Record<SyntaxRole, string> = {
  comment: 'var(--openbitfun-color-code-diff-syntax-comment)',
  punctuation: 'var(--openbitfun-color-code-diff-syntax-punctuation)',
  keyword: 'var(--openbitfun-color-code-diff-syntax-keyword)',
  declaration: 'var(--openbitfun-color-code-diff-syntax-declaration)',
  function: 'var(--openbitfun-color-code-diff-syntax-function)',
  string: 'var(--openbitfun-color-code-diff-syntax-string)',
  number: 'var(--openbitfun-color-code-diff-syntax-number)',
  property: 'var(--openbitfun-color-code-diff-syntax-property)',
  variable: 'var(--openbitfun-color-code-diff-syntax-variable)',
  operator: 'var(--openbitfun-color-code-diff-syntax-operator)',
};

// Prism uses kebab-case token names. Keep HTML attributes and type names
// explicit so nested scopes do not accidentally inherit their parent's color.
const tokenRoles: Record<string, SyntaxRole> = {
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment',
  punctuation: 'punctuation',
  keyword: 'keyword', tag: 'keyword', important: 'keyword', atrule: 'keyword',
  builtin: 'declaration', 'class-name': 'declaration',
  function: 'function', 'function-variable': 'function',
  string: 'string', char: 'string', regex: 'string', url: 'string',
  'attr-value': 'string', 'template-string': 'string',
  boolean: 'number', number: 'number',
  property: 'property', 'attr-name': 'property', 'literal-property': 'property',
  'property-access': 'property',
  variable: 'variable', constant: 'variable', symbol: 'variable', namespace: 'variable',
  operator: 'operator', entity: 'operator', selector: 'keyword',
};

const declarations = new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace']);
const constants = new Set(['null', 'undefined', 'true', 'false']);

function tokenText(content: Prism.TokenStream): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(tokenText).join('');
  return tokenText(content.content);
}

export function getInlineDiffTokenStyle(token: Prism.Token): CSSProperties {
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  let role = tokenRoles[token.type];
  for (const alias of aliases) role = tokenRoles[alias] ?? role;
  if (token.type === 'keyword') {
    const text = tokenText(token.content);
    if (declarations.has(text)) role = 'declaration';
    if (constants.has(text)) role = 'number';
  }
  // Weight and size belong to the design-system code role, never a syntax theme.
  return role ? { color: syntaxColors[role] } : {};
}
