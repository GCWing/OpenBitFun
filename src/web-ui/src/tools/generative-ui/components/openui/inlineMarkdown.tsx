import { Fragment, type ReactNode } from "react";
import { webUrl } from "./style";

// A small Markdown renderer that builds React elements and never injects HTML.
// Inline: **bold**, *italic*, ~~strike~~, `code`, [text](https://...).
// Blocks: paragraphs, # headings, - and 1. lists, > quotes, ``` code, ---, | tables |.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(~~[^~\n]+?~~)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)|(\[[^\]\n]+\]\([^)\s]+\))/;

export function inline(text: string, key = "i"): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index) out.push(rest.slice(0, m.index));
    const token = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k} className="iui-code">{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<s key={k}>{inline(token.slice(2, -2), k)}</s>);
    else if (m[4]) out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = webUrl(token.slice(close + 2, -1));
      out.push(
        href ? (
          <a key={k} className="iui-link" href={href} target="_blank" rel="noopener noreferrer">
            {inline(label, k)}
          </a>
        ) : (
          <Fragment key={k}>{inline(label, k)}</Fragment>
        ),
      );
    }
    rest = rest.slice(m.index + token.length);
  }
  return out.length === 1 ? out[0] : out;
}
