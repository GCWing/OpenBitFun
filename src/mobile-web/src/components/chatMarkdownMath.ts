/**
 * Mobile chat math activation and delimiter normalization.
 *
 * Math is rendered from a lazily loaded module, so this detection decides
 * whether the browser downloads KaTeX at all. Keep the single-dollar boundary
 * checks aligned with desktop MarkdownRenderer.mayContainMarkdownMath: a
 * closing dollar directly followed by a digit is ordinary currency text
 * (`$5 and $10`), not math.
 */
export function mayContainMarkdownMath(content: string): boolean {
  if (!content) return false;
  if (content.includes('$$') || content.includes('\\(') || content.includes('\\[')) {
    return true;
  }
  return /(^|[^\\$])\$[^$\n]{1,240}\$(?!\d)/.test(content);
}

const CODE_FENCE =
  /(^|\n)((?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:(?:[ \t]*>[ \t]?)*[ \t]*)\3[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE = /(`+)((?:[^\n`]|(?!\1)`)*?)\1/g;
const PROPER_DISPLAY_MATH = /(^|\n)([ \t]{0,3}\$\$[^\n]*\n[\s\S]*?\n[ \t]{0,3}\$\$[^\n]*)(?=\n|$)/g;
const SINGLE_LINE_DISPLAY_MATH = /(^|[^\\])\$\$([^\n]+?)\$\$/g;
const BRACKET_DISPLAY_MATH = /(^|[^\\])\\\[([\s\S]*?)\\\]/g;
const BRACKET_INLINE_MATH = /(^|[^\\])\\\(([\s\S]*?)\\\)/g;

type Span = { key: string; content: string };

function placeholder(spans: Span[], kind: string, content: string): string {
  const key = `@@MATH_${kind}_${spans.length}@@`;
  spans.push({ key, content });
  return key;
}

/** True when the delimiter owns a top-level line; indented/container math stays inline. */
function startsLine(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return before === '' || before.endsWith('\n');
}

/**
 * A bare identifier of one or two characters is commonly a formula (`$x$`,
 * `$n$th`). Longer shell-style names, brace expansions, and text containing
 * whitespace without operators stay literal.
 */
function looksLikeInlineMath(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return false;
  if (/[\\^_=+*/<>|{}()[\]]/.test(value)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value.length <= 2;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9.,'+-]+$/.test(value);
}

/**
 * `remark-math` is configured with `singleDollarTextMath: false`, so a lone
 * `$` always stays literal. Recognized inline formulas are widened to
 * `$$...$$`, which `remark-math` treats as inline math, and every other dollar
 * pair (currency, shell variables, paths) is left alone.
 */
function convertInlineDollarMath(text: string, spans: Span[]): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character !== '$') {
      output += character;
      index += 1;
      continue;
    }
    // Proper `$$` fences are already placeholders; keep any stray pair intact
    // rather than pairing it with a later single dollar.
    if (text[index + 1] === '$') {
      output += '$$';
      index += 2;
      continue;
    }
    // `${VAR}` is a shell expansion, not a math delimiter.
    if (text[index + 1] === '{') {
      output += '$';
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let closing = -1;
    while (cursor < text.length) {
      const next = text[cursor];
      if (next === '\n') break;
      if (next === '\\') {
        cursor += 2;
        continue;
      }
      if (next === '$') {
        closing = cursor;
        break;
      }
      cursor += 1;
    }
    if (closing > index + 1) {
      const content = text.slice(index + 1, closing);
      if (looksLikeInlineMath(content)) {
        output += placeholder(spans, 'INLINE', `$$${content.trim()}$$`);
        index = closing + 1;
        continue;
      }
    }
    output += '$';
    index += 1;
  }
  return output;
}

/**
 * Convert the LaTeX delimiter styles that common models emit into the
 * `$$...$$` forms remark-math parses. Code fences and inline code are replaced
 * with placeholders first, so literal `\[`/`$$` examples survive.
 *
 * Display delimiters only become a block when they own their line. Inside a
 * list item, table row, or blockquote they stay inline so the surrounding
 * container is not torn apart.
 */
export function normalizeMathDelimiters(content: string): string {
  if (!content) return content;
  const hasDisplayBracket = content.includes('\\[');
  const hasInlineBracket = content.includes('\\(');
  const hasDollar = content.includes('$');
  if (!hasDisplayBracket && !hasInlineBracket && !hasDollar) {
    return content;
  }

  const spans: Span[] = [];

  // Protect code fences (including blockquoted and list-indented fences).
  let transformed = content.replace(CODE_FENCE, (match) =>
    placeholder(spans, 'CODE_BLOCK', match),
  );

  // Protect inline code spans.
  transformed = transformed.replace(INLINE_CODE, (match) =>
    placeholder(spans, 'CODE_INLINE', match),
  );

  // Leave well-formed block math untouched; it already has the shape
  // remark-math expects, and its body must not be scanned for `$`.
  transformed = transformed.replace(PROPER_DISPLAY_MATH, (match) =>
    placeholder(spans, 'DISPLAY', match),
  );

  // remark-math only treats `$$` as a display fence when it owns its line.
  // A single-line `$$...$$` is a display fence at line start and inline math
  // everywhere else.
  transformed = transformed.replace(
    SINGLE_LINE_DISPLAY_MATH,
    (match, prefix: string, math: string, offset: number) => {
      const display = startsLine(transformed, offset + prefix.length);
      const rendered = display
        ? `\n\n$$\n${math.trim()}\n$$\n\n`
        : `$$${math.trim()}$$`;
      return prefix + placeholder(spans, display ? 'BLOCK' : 'INLINE', rendered);
    },
  );

  // \[ ... \] is display math when it owns its line, inline math otherwise.
  transformed = transformed.replace(
    BRACKET_DISPLAY_MATH,
    (match, prefix: string, math: string, offset: number) => {
      const delimiterIndex = offset + prefix.length;
      // `C:\[dir\]\file` is a Windows path, not display math.
      if (prefix === ':' && /[A-Za-z]/.test(transformed[delimiterIndex - 2] ?? '')) {
        return match;
      }
      const display = startsLine(transformed, delimiterIndex);
      const rendered = display
        ? `\n\n$$\n${math.trim()}\n$$\n\n`
        : `$$${math.trim()}$$`;
      return prefix + placeholder(spans, display ? 'BLOCK' : 'INLINE', rendered);
    },
  );

  // \( ... \) is inline math.
  transformed = transformed.replace(BRACKET_INLINE_MATH, (match, prefix: string, math: string) =>
    prefix + placeholder(spans, 'INLINE', `$$${math.trim()}$$`),
  );

  // Remaining single-dollar pairs are only math when they clearly are.
  transformed = convertInlineDollarMath(transformed, spans);

  // Restore protected content. Math spans are restored before code spans so a
  // code placeholder inside a formula still resolves; reverse order also keeps
  // nested placeholders stable.
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const { key, content: value } = spans[index];
    transformed = transformed.replace(key, () => value);
  }

  return transformed;
}
