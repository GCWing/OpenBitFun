/**
 * Cangjie language definition for Monaco Editor.
 *
 * Derived from the TextMate grammar shipped with the CodeArts Agent Cangjie
 * extension (`huaweicloud.cangjie`, language id `Cangjie`, scope `source.cj`).
 * Monaco's standalone build has no Oniguruma runtime, so TextMate grammars
 * cannot be loaded directly; this module rewrites the same lexical rules as a
 * Monarch tokenizer and exposes a Prism/refractor grammar for markdown code
 * fences, both built from the same keyword tables.
 *
 * Scope mapping:
 * - `keyword.control.Cangjie`   -> `keyword`
 * - `support.class.Cangjie`     -> `type.identifier` (declared / PascalCase types)
 * - builtin type keywords       -> `type.builtin`  (deviation: the reference
 *   grammar classes `Int64`/`Bool`/... as keywords; a type token keeps the
 *   builtin types visually distinct from control flow)
 * - `support.function.Cangjie`  -> `function` (declaration names and call sites)
 * - `support.variable.Cangjie`  -> `variable` (declared names, parameters)
 * - `constant.numeric.*`        -> `number` / `number.hex` / `number.float`
 * - `string.*`                  -> `string` (plus `${...}` interpolation)
 * - `comment.*`                 -> `comment` (nested block comments)
 * - everything else             -> default foreground (the reference grammar
 *   paints every identifier as `support.variable`; leaving free identifiers
 *   uncolored keeps whole files readable)
 *
 * @module languages/cangjie
 */

import type * as Monaco from 'monaco-editor';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('cangjie.language');

export const CANGJIE_LANGUAGE_ID = 'cangjie';

/** Declaration / control keywords (`keyword.control.Cangjie` in the reference grammar). */
export const CANGJIE_KEYWORDS = [
  'package', 'import',
  'class', 'interface', 'struct', 'enum', 'extend', 'func', 'let', 'var', 'const', 'type',
  'init', 'this', 'super',
  'if', 'else', 'case', 'try', 'catch', 'finally', 'for', 'do', 'while',
  'throw', 'return', 'continue', 'break', 'is', 'as', 'in', 'match', 'where',
  'spawn', 'synchronized', 'macro', 'quote', 'static',
  'public', 'internal', 'private', 'protected', 'override', 'abstract', 'open',
  'redef', 'sealed', 'external', 'foreign', 'inout', 'mut', 'unsafe', 'operator', 'prop',
  'main', 'This', 'Nothing', 'true', 'false',
  // Experimental / research-feature keywords present in the reference grammar.
  'VArray', 'differentiable', 'grad', 'vjp', 'valWithGrad', 'adjoint', 'adjointOf',
  'when', 'except', 'include', 'primal', 'stage',
] as const;

/** Builtin value and collection types. */
export const CANGJIE_BUILTIN_TYPES = [
  'Int8', 'Int16', 'Int32', 'Int64', 'IntNative',
  'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UIntNative',
  'Float16', 'Float32', 'Float64',
  'Rune', 'Bool', 'Unit', 'String', 'Option', 'Byte', 'Array', 'Range',
] as const;

const ID_START = 'A-Za-z_\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const ID_PART = `${ID_START}0-9`;
const IDENT = `[${ID_START}][${ID_PART}]*`;
const ESCAPED_IDENT = '`[^`\\r\\n]+`';
const IDENT_OR_ESCAPED = `(?:${ESCAPED_IDENT}|${IDENT})`;

/**
 * Longest-first alternation so `UIntNative` wins over `UInt8`, `adjointOf` over
 * `adjoint`, and similar prefix pairs.
 */
function wordRegex(words: readonly string[]): RegExp {
  const alternation = [...words]
    .sort((left, right) => right.length - left.length)
    .join('|');
  return new RegExp(`\\b(?:${alternation})\\b`);
}

const KEYWORD_REGEX = wordRegex(CANGJIE_KEYWORDS);
const BUILTIN_TYPE_REGEX = wordRegex(CANGJIE_BUILTIN_TYPES);

const INTEGER_SUFFIX = '(?:u8|u16|u32|u64|i8|i16|i32|i64)?';
const FLOAT_SUFFIX = '(?:f16|f32|f64)?';

/** Cangjie language configuration for Monaco (comments, pairs, word pattern). */
export const cangjieLanguageConfig: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  wordPattern: /(-?\d*\.\d\w*)|([^\s~$!@#%^&*()\-=+{}[\]\\|;:'",.<>/?]+)/,
};

/** Cangjie Monarch tokenizer definition. */
export const cangjieLanguageTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ''],

      // Comments: Cangjie allows nested block comments.
      [/\/\/.*$/, 'comment'],
      [/\/\*/, { token: 'comment', next: '@blockComment' }],

      // Macro invocation: `@Name` / `@std.collection.Name`.
      [new RegExp(`(@)(${IDENT}(?:\\.${IDENT})*)`), ['keyword', 'function']],

      // Declarations, so the declared name gets its own token.
      [new RegExp(`\\b(func)(\\s+)(${IDENT_OR_ESCAPED})`), ['keyword', '', 'function']],
      [new RegExp(`\\b(macro)(\\s+)(${IDENT_OR_ESCAPED})`), ['keyword', '', 'function']],
      [new RegExp(`\\b(class|interface|struct|enum|extend|type)(\\s+)(${IDENT_OR_ESCAPED})`), ['keyword', '', 'type.identifier']],
      [new RegExp(`\\b(let|var|const|prop)(\\s+)(${IDENT_OR_ESCAPED})`), ['keyword', '', 'variable']],

      // Parameter and field names of the form `name: Type` after `(` or `,`.
      [new RegExp(`([,(])(\\s*)(${IDENT_OR_ESCAPED})(\\s*)(:)`), ['delimiter', '', 'variable', '', 'operator']],

      [BUILTIN_TYPE_REGEX, 'type.builtin'],
      [KEYWORD_REGEX, 'keyword'],

      // Numbers.
      [new RegExp(`0[xX][0-9a-fA-F_]*\\.[0-9a-fA-F_]*[pP][+-]?\\d[\\d_]*${FLOAT_SUFFIX}`), 'number.float'],
      [new RegExp(`0[xX][0-9a-fA-F][0-9a-fA-F_]*${INTEGER_SUFFIX}`), 'number.hex'],
      [new RegExp(`0[bB][01][01_]*${INTEGER_SUFFIX}`), 'number.binary'],
      [new RegExp(`0[oO][0-7][0-7_]*${INTEGER_SUFFIX}`), 'number.octal'],
      [new RegExp(`\\.\\d[\\d_]*(?:[eE][+-]?\\d[\\d_]*)?${FLOAT_SUFFIX}`), 'number.float'],
      [new RegExp(`\\d[\\d_]*\\.\\d[\\d_]*(?:[eE][+-]?\\d[\\d_]*)?${FLOAT_SUFFIX}`), 'number.float'],
      [new RegExp(`\\d[\\d_]*[eE][+-]?\\d[\\d_]*${FLOAT_SUFFIX}`), 'number.float'],
      [new RegExp(`\\d[\\d_]*${INTEGER_SUFFIX}`), 'number'],

      // Raw multiline strings: #"..."#, ##'...'##. Raw strings take no escapes.
      [/#+"/, { token: 'string.quote', next: '@rawHashDouble' }],
      [/#+'/, { token: 'string.quote', next: '@rawHashSingle' }],
      // Raw and prefixed single-line strings.
      [/r"[^"\r\n]*"/, 'string'],
      [/r'[^'\r\n]*'/, 'string'],
      [/b"(?:[^"\\\r\n]|\\.)*"/, 'string'],
      [/b'(?:[^'\\\r\n]|\\.)*'/, 'string'],
      [/J"(?:[^"\\\r\n]|\\.)*"/, 'string'],
      // Multiline strings.
      [/"""/, { token: 'string.quote', next: '@tripleDouble' }],
      [/'''/, { token: 'string.quote', next: '@tripleSingle' }],
      // Single-line strings. The lookahead keeps a quote that ends the line from
      // opening a state that would leak into the next line.
      [/"(?=.)/, { token: 'string.quote', next: '@singleDouble' }],
      [/'(?=.)/, { token: 'string.quote', next: '@singleSingle' }],
      [/["']/, 'string.invalid'],

      [/[{}[\]()]/, '@brackets'],
      [/[,;]/, 'delimiter'],
      [/(?:=>|->|==|!=|<=|>=|&&|\|\||\.\.=|\?\?|\.\.|<<|>>|\*\*|[+\-*/%=<>!&|^~?:])/, 'operator'],
      [/\./, 'delimiter'],

      // Declared types, call sites, then plain identifiers.
      [/[A-Z][A-Za-z0-9_]*/, 'type.identifier'],
      [new RegExp(`${IDENT}(?=\\s*\\()`), 'function'],
      [new RegExp(ESCAPED_IDENT), 'variable'],
      [new RegExp(IDENT), ''],
      [/./, ''],
    ],
    blockComment: [
      [/\*\//, { token: 'comment', next: '@pop' }],
      [/\/\*/, { token: 'comment', next: '@push' }],
      [/[^/*]+/, 'comment'],
      [/[/*]/, 'comment'],
    ],
    singleDouble: [
      [/\$\{/, { token: 'delimiter.curly', next: '@interpolation' }],
      [/\\./, 'string.escape'],
      [/[^"\\$]+$/, { token: 'string', next: '@pop' }],
      [/[^"\\$]+/, 'string'],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/\$/, 'string'],
      [/\\/, { token: 'string.invalid', next: '@pop' }],
    ],
    singleSingle: [
      [/\$\{/, { token: 'delimiter.curly', next: '@interpolation' }],
      [/\\./, 'string.escape'],
      [/[^'\\$]+$/, { token: 'string', next: '@pop' }],
      [/[^'\\$]+/, 'string'],
      [/'/, { token: 'string.quote', next: '@pop' }],
      [/\$/, 'string'],
      [/\\/, { token: 'string.invalid', next: '@pop' }],
    ],
    tripleDouble: [
      [/\$\{/, { token: 'delimiter.curly', next: '@interpolation' }],
      [/\\./, 'string.escape'],
      [/"""/, { token: 'string.quote', next: '@pop' }],
      [/[^"\\$]+/, 'string'],
      [/["$]/, 'string'],
      [/\\/, 'string.escape.invalid'],
    ],
    tripleSingle: [
      [/\$\{/, { token: 'delimiter.curly', next: '@interpolation' }],
      [/\\./, 'string.escape'],
      [/'''/, { token: 'string.quote', next: '@pop' }],
      [/[^'\\$]+/, 'string'],
      [/'|\$/, 'string'],
      [/\\/, 'string.escape.invalid'],
    ],
    rawHashDouble: [
      [/"#+/, { token: 'string.quote', next: '@pop' }],
      [/[^"]+/, 'string'],
      [/"/, 'string'],
    ],
    rawHashSingle: [
      [/'#+/, { token: 'string.quote', next: '@pop' }],
      [/[^']+/, 'string'],
      [/'/, 'string'],
    ],
    interpolation: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      [/\{/, { token: 'delimiter.curly', next: '@push' }],
      { include: '@root' },
    ],
  },
};

/**
 * Prism/refractor grammar for markdown code fences, so `cangjie` fenced blocks
 * in chat highlight with the same vocabulary as the editor.
 */
export const cangjiePrismGrammar = {
  comment: [
    { pattern: /\/\*[\s\S]*?\*\//, greedy: true },
    { pattern: /\/\/[^\r\n]*/, greedy: true },
  ],
  string: [
    { pattern: /#+["'][\s\S]*?["']#+/, greedy: true },
    { pattern: /(?:r|b|J)?"""[\s\S]*?"""/, greedy: true },
    { pattern: /(?:r|b|J)?'''[\s\S]*?'''/, greedy: true },
    { pattern: /r"[^"\r\n]*"|r'[^'\r\n]*'/ },
    { pattern: /b"(?:[^"\\\r\n]|\\.)*"|b'(?:[^'\\\r\n]|\\.)*'/ },
    { pattern: /J"(?:[^"\\\r\n]|\\.)*"/ },
    { pattern: /"(?:[^"\\\r\n]|\\.)*"/ },
    { pattern: /'(?:[^'\\\r\n]|\\.)*'/ },
  ],
  annotation: {
    pattern: /@[A-Za-z_][A-Za-z0-9_.]*/,
    alias: 'function',
  },
  keyword: KEYWORD_REGEX,
  builtin: BUILTIN_TYPE_REGEX,
  'class-name': /\b[A-Z][A-Za-z0-9_]*\b/,
  function: new RegExp(`${IDENT}(?=\\s*\\()`),
  number: [
    { pattern: new RegExp(`0[xX][0-9a-fA-F][0-9a-fA-F_]*${INTEGER_SUFFIX}`), alias: 'constant' },
    { pattern: new RegExp(`0[bB][01][01_]*${INTEGER_SUFFIX}`), alias: 'constant' },
    { pattern: new RegExp(`0[oO][0-7][0-7_]*${INTEGER_SUFFIX}`), alias: 'constant' },
    { pattern: new RegExp(`\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?${FLOAT_SUFFIX}`) },
  ],
  operator: /(?:=>|->|==|!=|<=|>=|&&|\|\||\.\.=|\?\?|\.\.|<<|>>|\*\*|[+\-*/%=<>!&|^~?:])/,
  punctuation: /[{}[\];(),.]/,
};

/** Register the Cangjie language, configuration and tokenizer with Monaco. */
export function registerCangjieLanguage(monaco: typeof Monaco): void {
  try {
    const exists = monaco.languages.getLanguages().some((language) => language.id === CANGJIE_LANGUAGE_ID);

    if (!exists) {
      monaco.languages.register({
        id: CANGJIE_LANGUAGE_ID,
        extensions: ['.cj', '.cj.macrocall'],
        aliases: ['Cangjie', 'cangjie', 'cj'],
        mimetypes: ['text/x-cangjie'],
      });
    }

    monaco.languages.setLanguageConfiguration(CANGJIE_LANGUAGE_ID, cangjieLanguageConfig);
    monaco.languages.setMonarchTokensProvider(CANGJIE_LANGUAGE_ID, cangjieLanguageTokens);
  } catch (error) {
    log.error('Failed to register Cangjie language', error);
    throw error;
  }
}
