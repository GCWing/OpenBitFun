import { inline } from './inlineMarkdown';

type Block =
  | { kind: "p" | "quote"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "hr" }
  | { kind: "table"; head: string[]; rows: string[][] };

const LIST_ITEM = /^\s{0,3}([-*+]|(\d+)[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: "code", text: body.join("\n") });
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: "h", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = !!item[2];
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next && !!next[2] === ordered) items.push(next[3]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      out.push({ kind: "list", ordered, start: ordered ? Number(item[2]) : 1, items });
      continue;
    }
    const body: string[] = [];
    for (; i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !/^(#{1,4})\s|^\s*```|^\s*>/.test(lines[i]); i++) body.push(lines[i].trim());
    out.push({ kind: "p", text: body.join(" ") });
  }
  return out;
}

export function MarkdownBlocks({ text }: { text: string }) {
  return (
    <>
      {blocks(text).map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "p":
            return <p key={k}>{inline(b.text, k)}</p>;
          case "quote":
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
          case "h":
            return (
              <div key={k} role="heading" aria-level={b.level + 1} className={`iui-md-h iui-md-h${b.level}`}>
                {inline(b.text, k)}
              </div>
            );
          case "code":
            return (
              <pre key={k} className="iui-code-block">
                <code>{b.text}</code>
              </pre>
            );
          case "hr":
            return <hr key={k} className="iui-divider" />;
          case "list": {
            const items = b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>);
            return b.ordered ? (
              <ol key={k} start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={k}>{items}</ul>
            );
          }
          case "table":
            return (
              <div key={k} className="iui-table-scroll">
                <table className="iui-table">
                  <thead>
                    <tr>{b.head.map((h, j) => <th key={j}>{inline(h, `${k}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, m) => <td key={m}>{inline(c, `${k}-${j}-${m}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
