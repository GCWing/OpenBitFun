// Adapted from harmony-genui hm-plot.ts. MIT; see HARMONY-LICENSE.txt.
// Pure compiler/renderer; no sandbox installer or generated executable code.
/**
 * Declarative function plots and point charts: the model lists axis ranges and what to
 * draw; the runtime evaluates the expressions with a tiny whitelist parser (never eval),
 * lays the chart out at the width it is shown at, and writes the SVG.
 *
 * <figure class="hm-plot" aria-label="y = x² from -2 to 2"><pre class="hm-spec">
 * x -2..2 label=x
 * y 0..4 label=y
 * grid
 * fn y=x^2 label="y = x²"
 * point 0,0 label="vertex (0,0)"
 * </pre></figure>
 *
 * One directive per line:
 *   x A..B [label="…"]      horizontal range (numbers or constant expressions such as -2*pi..2*pi)
 *   y A..B [label="…"]      vertical range; omit it to fit the curves
 *   grid                    light grid lines at the ticks
 *   legend                  force the legend (it shows by itself for labelled series)
 *   fn y=EXPR [id=f] [label="…"] [dashed]   a curve of x; EXPR may use x pi e + - * / ^ ( )
 *                           and sin cos tan asin acos atan sinh cosh tanh sqrt abs exp ln log
 *                           log2 floor ceil round sign; 2x and 3(x+1) multiply
 *   series x,y x,y … [label="…"] [join] [dashed]   measured points, joined by a line with join
 *   point x,y [label="…"]   or  point x=A on=f [label="…"]   a labelled point (on a curve)
 * y grows upward (the vertex of y=x^2 is the lowest point). Text is never smaller than 12px:
 * the SVG is drawn at the pixel width the figure has.
 *
 * Self-contained: hmPlotJs embeds it with toString.
 */
export interface HmPlotBuild {
  svg: string;
  /** Visually hidden table of values for assistive tech. */
  table: string;
  /** Plain-language summary, used as the figure's accessible name when none is given. */
  summary: string;
  issues: string[];
}

export function hmPlotKit() {
  type Pt = [number, number];
  type Fn = { id: string; src: string; f: ((x: number) => number) | null; label: string; dashed: boolean };
  type Series = { label: string; pts: Pt[]; join: boolean; dashed: boolean };
  type Mark = { x: number; y: number; label: string };
  type Rule = { v: 'x' | 'y'; at: number; label: string; dashed: boolean };
  type Cross = { a: string; b: string; label: string };
  type Plan = {
    x: Pt | null; y: Pt | null; xl: string; yl: string; grid: boolean; legend: boolean; equal: boolean;
    fns: Fn[]; series: Series[]; marks: Mark[]; rules: Rule[]; crosses: Cross[]; issues: string[];
  };

  const MAX_SRC = 200, MAX_FNS = 6, MAX_PTS = 400, SAMPLES = 240;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const r1 = (v: number) => Math.round(v * 10) / 10;

  // ─── Expressions: recursive descent over a fixed grammar and function whitelist ───
  const FUNCS: Record<string, (v: number) => number> = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  };
  const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

  /** Compile one expression of x. Throws an Error naming what is wrong; never evaluates code. */
  function compile(raw: string, vars: string[]): (x: number) => number {
    const src = raw.trim()
      .replace(/[−–]/g, "-").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/π/g, "pi")
      .replace(/²/g, "^2").replace(/³/g, "^3").replace(/\*\*/g, "^");
    if (!src) throw new Error("empty expression");
    if (src.length > MAX_SRC) throw new Error("expression is longer than " + MAX_SRC + " characters");
    let i = 0, depth = 0;
    type Node = (x: number) => number;
    const ws = () => { while (src[i] === " ") i++; };
    const peek = () => { ws(); return src[i]; };
    const fail = (m: string): never => { throw new Error(m + ' in "' + raw.trim().slice(0, 40) + '"'); };
    function primary(): Node {
      const c = peek();
      if (c === "(") {
        if (++depth > 24) fail("too many nested parentheses");
        i++; const v = sum(); if (peek() !== ")") fail('missing ")"'); i++; depth--; return v;
      }
      const n = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (n) { i += n[0].length; const v = parseFloat(n[0]); return () => v; }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (!m) return fail(c === undefined ? "the expression ends early" : 'unexpected "' + c + '"');
      const word = m[0].toLowerCase();
      i += m[0].length;
      if (FUNCS[word] && peek() === "(") {
        const f = FUNCS[word];
        if (++depth > 24) fail("too many nested parentheses");
        i++; const a = sum(); if (peek() !== ")") fail('missing ")"'); i++; depth--;
        return (x) => f(a(x));
      }
      if (FUNCS[word] && peek() !== undefined && peek() !== "(" ) {
        // "ln x" and "sin 2x" without parentheses: the function takes the next factor.
        const f = FUNCS[word], a = power();
        return (x) => f(a(x));
      }
      if (vars.indexOf(word) >= 0) return (x) => x;
      if (Object.prototype.hasOwnProperty.call(CONSTS, word)) { const v = CONSTS[word]; return () => v; }
      return fail('"' + m[0] + '" is not allowed (use x, pi, e or one of ' + Object.keys(FUNCS).join(" ") + ")");
    }
    function power(): Node {
      const base = primary();
      if (peek() === "^") {
        i++;
        const neg = peek() === "-"; if (neg) i++;
        const ex = power();
        return (x) => Math.pow(base(x), neg ? -ex(x) : ex(x));
      }
      return base;
    }
    function unary(): Node {
      const c = peek();
      if (c === "-") { i++; const v = unary(); return (x) => -v(x); }
      if (c === "+") { i++; return unary(); }
      return power();
    }
    function product(): Node {
      let v = unary();
      for (;;) {
        const c = peek();
        if (c === "*" || c === "/") {
          i++; const a = v, b = unary();
          v = c === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
        } else if (c !== undefined && (c === "(" || /[A-Za-z0-9.]/.test(c))) {
          // Implicit multiplication: 2x, 3(x+1), 2sin(x), (x+1)(x-1).
          const a = v, b = power(); v = (x) => a(x) * b(x);
        } else return v;
      }
    }
    function sum(): Node {
      let v = product();
      for (;;) {
        const c = peek();
        if (c !== "+" && c !== "-") return v;
        i++; const a = v, b = product();
        v = c === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
      }
    }
    const out = sum();
    if (peek() !== undefined) fail('unexpected "' + src.slice(i, i + 6) + '"');
    return out;
  }
  const constant = (s: string) => { const v = compile(s, [])(0); if (!isFinite(v)) throw new Error('"' + s + '" is not a finite number'); return v; };

  // ─── Spec text → plan ───
  function parse(text: string): Plan {
    const plan: Plan = { x: null, y: null, xl: "", yl: "", grid: false, legend: false, equal: false, fns: [], series: [], marks: [], rules: [], crosses: [], issues: [] };
    const bad = (line: string, m: string) => plan.issues.push("hm-plot: " + m + " (line: " + line.trim().slice(0, 50) + ")");
    // A model that JSON-escapes the listing twice writes a literal backslash-n
    // between lines. Models also commonly use semicolons between directives
    // after seeing compact examples, so accept those separators outside quoted
    // labels/spec fragments instead of feeding the semicolon into an axis or
    // series value.
    const normalized = text.replace(/\\n/g, "\n");
    const rawLines: string[] = [];
    let line = "";
    let quote = "";
    for (const char of normalized) {
      if ((char === '"' || char === '“' || char === '”') && (quote === "" || quote === char || (quote === '“' && char === '”'))) {
        quote = quote === "" ? char : "";
        line += char;
      } else if (!quote && (char === "\n" || char === ";" || char === "\r")) {
        if (line.trim()) rawLines.push(line);
        line = "";
      } else {
        line += char;
      }
    }
    if (line.trim()) rawLines.push(line);
    const lines = rawLines.map((l) => l.trim()).filter((l) => l && l[0] !== "#");
    const need: [string, Mark][] = [];
    lines.forEach((line) => {
      try {
        const strings: string[] = [];
        const body = line.replace(/"([^"]*)"|“([^”]*)”/g, (_m, a, b) => { strings.push(a ?? b ?? ""); return "\u0001" + (strings.length - 1) + "\u0001"; });
        const kindM = /^[A-Za-z]+/.exec(body);
        if (!kindM) return bad(line, "each line starts with x, y, grid, legend, fn, series or point");
        const alias: Record<string, string> = { curve: "fn", func: "fn", function: "fn", plot: "fn", line: "fn", points: "series", data: "series", dot: "point", marker: "point", axes: "grid", asymptote: "rule", vline: "rule", hline: "rule", rule: "rule", guide: "rule", refline: "rule", intersection: "intersect", intersections: "intersect", cross: "intersect", crossing: "intersect" };
        let kind = alias[kindM[0].toLowerCase()] || kindM[0].toLowerCase();
        let rest = body.slice(kindM[0].length).trim();
        let lead = false;
        // "dashed line x=0" / "dashed vline x=0": the style word may come first.
        if (kind === "dashed" || kind === "dotted") {
          const k2 = /^[A-Za-z]+/.exec(rest);
          if (k2) { lead = true; kind = alias[k2[0].toLowerCase()] || k2[0].toLowerCase(); rest = rest.slice(k2[0].length).trim(); }
        }
        if (kindM[0].toLowerCase() === "hline") rest = "y=" + rest.replace(/^y\s*=\s*/i, "");
        else if (kindM[0].toLowerCase() === "vline") rest = "x=" + rest.replace(/^x\s*=\s*/i, "");
        // "y = x^2" written as a line of its own is a curve.
        if (kind === "y" && rest[0] === "=") { kind = "fn"; rest = "y" + rest; }
        // key=value tokens; a token without "=" continues the previous value (expressions may contain spaces) unless it is a flag.
        const kv: Record<string, string> = {}, flags: string[] = [];
        const FLAGS = ["join", "dashed", "dotted", "solid", "grid", "legend"];
        if (lead) flags.push("dashed");
        let label = "";
        rest = rest.replace(/\blabel\s*=\s*(\u0001\d+\u0001|[^\s]+)/i, (_m, v: string) => { label = v; return " "; });
        label = label.replace(/\u0001(\d+)\u0001/, (_m, n: string) => strings[+n]);
        let last = "";
        rest.split(/\s+/).filter(Boolean).forEach((tok) => {
          const eq = /^([A-Za-z_]+)=(.*)$/.exec(tok);
          if (eq && (kind !== "fn" || eq[1].toLowerCase() !== "y" || last === "")) { last = eq[1].toLowerCase(); kv[last] = eq[2]; }
          else if (FLAGS.indexOf(tok.toLowerCase()) >= 0) flags.push(tok.toLowerCase());
          else if (last) kv[last] += " " + tok;
          else kv["_"] = (kv["_"] ? kv["_"] + " " : "") + tok;
        });
        // "on=f (0,0)": a curve id is one word; whatever follows it is the point's own coordinates.
        if (kv["on"] !== undefined) {
          const parts = kv["on"].trim().split(/\s+/);
          kv["on"] = parts[0];
          if (parts.length > 1) kv["_"] = (kv["_"] ? kv["_"] + " " : "") + parts.slice(1).join(" ");
          if (/^(none|null|-)?$/i.test(kv["on"])) delete kv["on"];
        }
        if (kind === "point" && kv["_"]) kv["_"] = kv["_"].replace(/[()（）\s]/g, "");
        // fn: "y=x^2" has key y; "id=f" sets the id.
        if (kind === "fn" && kv["x"] !== undefined && kv["y"] === undefined && kv["_"] === undefined && kv["f"] === undefined && kv["expr"] === undefined) kind = "rule";
        if (kind === "grid") { plan.grid = true; return; }
        if (kind === "legend") { plan.legend = true; return; }
        if (kind === "equal" || kind === "square" || kind === "aspect") { plan.equal = true; return; }
        if (flags.indexOf("grid") >= 0) plan.grid = true;
        if (flags.indexOf("legend") >= 0) plan.legend = true;
        if (kind === "x" || kind === "y") {
          const rng = kv["_"] || kv["range"] || "";
          const cut = rng.indexOf("..");
          if (cut < 0) return bad(line, kind + " needs a range such as " + kind + " -2..2");
          const a = constant(rng.slice(0, cut)), b = constant(rng.slice(cut + 2));
          if (!(a < b)) return bad(line, "the " + kind + " range must increase (from < to)");
          if (kind === "x") { plan.x = [a, b]; plan.xl = label; } else { plan.y = [a, b]; plan.yl = label; }
        } else if (kind === "rule") {
          // An asymptote or guide: x=0 draws a vertical line, y=0 a horizontal one.
          const xv = kv["x"] !== undefined ? "x" : kv["y"] !== undefined ? "y" : "";
          if (!xv) return bad(line, "rule needs x=A (vertical line) or y=B (horizontal line)");
          // y=x or y=2x+1 as an asymptote or guide is a slanted line: draw it as a dashed curve.
          if (xv === "y" && /[A-Za-z]/.test(kv["y"].replace(/\b(pi|e)\b/gi, "").replace(/\b(sin|cos|tan|exp|ln|log2?|sqrt|abs)\b/gi, "")) ) {
            if (plan.fns.length >= MAX_FNS) return bad(line, "at most " + MAX_FNS + " curves");
            plan.fns.push({ id: (kv["id"] || "g" + (plan.fns.length + 1)).toLowerCase(), src: kv["y"].trim(), f: compile(kv["y"], ["x"]), label, dashed: true });
            return;
          }
          plan.rules.push({ v: xv as "x" | "y", at: constant(kv[xv]), label, dashed: flags.indexOf("solid") < 0 });
        } else if (kind === "intersect") {
          const ids = (kv["_"] || kv["of"] || kv["between"] || kv["id"] || "").split(/[\s,;&]+/).filter(Boolean).map((t) => t.toLowerCase());
          if (ids.length < 2) return bad(line, "intersect needs two curve ids, e.g. intersect f g");
          plan.crosses.push({ a: ids[0], b: ids[1], label });
        } else if (kind === "fn") {
          if (plan.fns.length >= MAX_FNS) return bad(line, "at most " + MAX_FNS + " curves");
          const src = kv["y"] ?? kv["f"] ?? kv["expr"] ?? kv["_"] ?? "";
          const f = compile(src, ["x"]);
          plan.fns.push({ id: (kv["id"] || "f" + (plan.fns.length + 1)).toLowerCase(), src: src.trim(), f, label, dashed: flags.indexOf("dashed") >= 0 });
        } else if (kind === "series") {
          const pts: Pt[] = [];
          (kv["_"] || "").split(/\s+/).filter(Boolean).forEach((p) => {
            const m = /^(.+),(.+)$/.exec(p);
            if (!m) throw new Error('"' + p + '" is not an x,y pair');
            pts.push([constant(m[1]), constant(m[2])]);
          });
          if (!pts.length) return bad(line, "series needs x,y pairs");
          if (pts.length > MAX_PTS) return bad(line, "at most " + MAX_PTS + " points");
          plan.series.push({ label, pts, join: flags.indexOf("join") >= 0, dashed: flags.indexOf("dashed") >= 0 });
        } else if (kind === "point") {
          const on = kv["on"];
          const pair = /^(.+),(.+)$/.exec(kv["_"] || "");
          if (kv["x"] !== undefined && kv["y"] !== undefined) {
            plan.marks.push({ x: constant(kv["x"]), y: constant(kv["y"]), label });
          } else if (on !== undefined && pair) {
            plan.marks.push({ x: constant(pair[1]), y: constant(pair[2]), label });
          } else if (on !== undefined) {
            const x = constant(kv["x"] ?? kv["at"] ?? kv["_"] ?? "");
            need.push([on.toLowerCase(), { x, y: NaN, label }]);
          } else {
            const m = /^(.+),(.+)$/.exec(kv["_"] || "");
            // "point x=0 label=undefined" with no y is a labelled vertical guide.
            if (!m && kv["x"] !== undefined && kv["y"] === undefined) { plan.rules.push({ v: "x", at: constant(kv["x"]), label, dashed: true }); return; }
            if (!m) return bad(line, "point needs x,y or x=A on=curve");
            plan.marks.push({ x: constant(m[1]), y: constant(m[2]), label });
          }
        } else bad(line, 'unknown directive "' + kindM[0] + '" (x y grid legend fn series point)');
      } catch (e) {
        bad(line, (e as Error).message);
      }
    });
    need.forEach(([id, m]) => {
      const fn = plan.fns.find((f) => f.id === id) || (/^\d+$/.test(id) ? plan.fns[+id - 1] : undefined);
      if (!fn || !fn.f) { plan.issues.push('hm-plot: point on="' + id + '" names no curve (give the fn id=' + id + ")"); return; }
      const y = fn.f(m.x);
      if (!isFinite(y)) return; // a point on a pole or gap cannot be drawn; the rule line or the curve gap already shows it
      plan.marks.push({ x: m.x, y, label: m.label });
    });
    plan.crosses.forEach((c) => {
      // Ids as written, then "1"/"2", then the textbook names f g h by order, then a label that starts with the word.
      const find = (id: string) => plan.fns.find((f) => f.id === id) || (/^\d+$/.test(id) ? plan.fns[+id - 1] : undefined)
        || (/^[fghk]$/.test(id) ? plan.fns["fghk".indexOf(id)] : undefined)
        || plan.fns.find((f) => f.label.toLowerCase().replace(/\s/g, "").indexOf(id) === 0 || f.src.toLowerCase().replace(/\s/g, "") === id);
      const A = find(c.a), B = find(c.b);
      if (!A || !B || !A.f || !B.f || !plan.x) { plan.issues.push('hm-plot: intersect names a curve that does not exist (give each fn an id=, then: intersect id1 id2)'); return; }
      const fa = A.f, fb = B.f, d = (x: number) => fa(x) - fb(x), [lo, hi] = plan.x, N = 600;
      let found = 0, px = lo, pd = d(lo);
      for (let k = 1; k <= N; k++) {
        const x = lo + ((hi - lo) * k) / N, dv = d(x);
        if (isFinite(pd) && isFinite(dv) && (pd === 0 || pd * dv < 0) && Math.abs(pd) + Math.abs(dv) < 1e6) {
          let a = px, b = x, da = pd;
          for (let it = 0; it < 50; it++) { const m = (a + b) / 2, dm = d(m); if (da * dm <= 0) b = m; else { a = m; da = dm; } }
          const rx = (a + b) / 2, ry = fa(rx);
          if (isFinite(ry) && Math.abs(d(rx)) < 1e-6 * (1 + Math.abs(ry)) && !plan.marks.some((m) => Math.abs(m.x - rx) < 1e-6)) {
            plan.marks.push({ x: rx, y: ry, label: c.label || "(" + String(+rx.toPrecision(3)) + ", " + String(+ry.toPrecision(3)) + ")" });
            found++;
          }
        }
        px = x; pd = dv;
      }
      // Many crossings (sin and cos over several periods) would bury the plot in labels: keep the dots, drop the text.
      if (found > 3 && !c.label) plan.marks.forEach((m) => { if (/^\(-?[\d.e+-]+, -?[\d.e+-]+\)$/.test(m.label)) m.label = ""; });
      // No crossing is a valid answer (e^x and ln x never meet): nothing is marked.
    });
    if (!lines.length) plan.issues.push("hm-plot has no spec lines");
    else if (!plan.x) plan.issues.push("hm-plot needs an x range, e.g. x -2..2");
    if (!plan.fns.length && !plan.series.length && !plan.marks.length && !plan.rules.length && lines.length) plan.issues.push("hm-plot draws nothing: add fn, series or point lines");
    return plan;
  }

  // ─── Geometry ───
  function niceStep(span: number, target: number) {
    const raw = span / Math.max(target, 1), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
  }
  function ticks(a: number, b: number, target: number): number[] {
    const step = niceStep(b - a, target), out: number[] = [];
    for (let k = Math.ceil(a / step - 1e-9); k * step <= b + step * 1e-9; k++) out.push(Math.round(k * step * 1e9) / 1e9);
    return out;
  }
  const fmt = (v: number) => { const s = String(+v.toPrecision(4)); return s === "-0" ? "0" : s; };
  const tw = (s: string, size: number) => { let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? size : size * 0.58; return w; };
  function sample(f: (x: number) => number, a: number, b: number, n: number): Pt[] {
    const out: Pt[] = [];
    for (let k = 0; k <= n; k++) { const x = a + ((b - a) * k) / n; let y = NaN; try { y = f(x); } catch (_e) { /* undefined here */ } out.push([x, y]); }
    return out;
  }
  const niceRange = (lo: number, hi: number): Pt => {
    if (!(hi > lo)) { const d = Math.abs(lo) * 0.5 || 1; return [lo - d, hi + d]; }
    const pad = (hi - lo) * 0.06, step = niceStep(hi - lo + 2 * pad, 5);
    return [Math.floor((lo - pad) / step) * step, Math.ceil((hi + pad) / step) * step];
  };

  /**
   * Draw a plan at a pixel width. The SVG's viewBox is that width, so one unit is one
   * screen pixel and the 12px text stays 12px.
   */
  function render(plan: Plan, width: number, title = ""): HmPlotBuild {
    const issues = plan.issues.slice();
    const none: HmPlotBuild = { svg: "", table: "", summary: "", issues };
    if (!plan.x || issues.length && !plan.fns.length && !plan.series.length && !plan.marks.length) return none;
    const W = Math.max(240, Math.round(width)), FS = 12;
    const [x0, x1] = plan.x;
    const curves = plan.fns.map((fn) => ({ fn, pts: sample(fn.f as (x: number) => number, x0, x1, SAMPLES) }));
    const fin = (v: number) => isFinite(v) && Math.abs(v) < 1e7;
    curves.forEach((c) => { if (!c.pts.some((p) => fin(p[1]))) issues.push('hm-plot: "' + c.fn.src + '" has no value for x in ' + fmt(x0) + ".." + fmt(x1)); });
    let y: Pt;
    if (plan.y) y = plan.y;
    else {
      const ys: number[] = [];
      curves.forEach((c) => c.pts.forEach((p) => fin(p[1]) && ys.push(p[1])));
      plan.series.forEach((s) => s.pts.forEach((p) => ys.push(p[1])));
      plan.marks.forEach((m) => ys.push(m.y));
      if (!ys.length) return { ...none, issues };
      ys.sort((a, b) => a - b);
      // Trim extreme asymptote spikes so one pole does not flatten the rest.
      const lo = ys[0], hi = ys[ys.length - 1], q = (p: number) => ys[Math.floor((ys.length - 1) * p)];
      const iqr = q(0.9) - q(0.1);
      y = iqr > 0 && hi - lo > iqr * 6 ? niceRange(q(0.02), q(0.98)) : niceRange(lo, hi);
    }
    const [y0, y1] = y;
    plan.marks.forEach((m) => {
      if (m.x < x0 - 1e-9 || m.x > x1 + 1e-9 || m.y < y0 - 1e-9 || m.y > y1 + 1e-9) issues.push("hm-plot: the point " + (m.label ? '"' + m.label + '" ' : "") + "(" + fmt(m.x) + ", " + fmt(m.y) + ") lies outside the plot (x " + fmt(x0) + ".." + fmt(x1) + ", y " + fmt(y0) + ".." + fmt(y1) + "); widen the range or drop the point");
    });
    const labelled = [
      ...plan.fns.map((f, i) => ({ label: f.label, i, dashed: f.dashed })),
      ...plan.series.map((s, i) => ({ label: s.label, i: plan.fns.length + i, dashed: s.dashed })),
    ].filter((s) => s.label);
    const showLegend = labelled.length > 0 && (labelled.length > 1 || plan.legend || plan.marks.length === 0);
    // Legend rows wrap by estimated text width.
    const legendRows: { label: string; i: number; dashed: boolean; x: number; row: number }[] = [];
    let lx = 0, lrow = 0;
    if (showLegend) labelled.forEach((s) => {
      const w = 30 + tw(s.label, FS) + 16;
      if (lx > 0 && lx + w > W - 8) { lx = 0; lrow++; }
      legendRows.push({ ...s, x: lx, row: lrow }); lx += w;
    });
    const legendH = showLegend ? (lrow + 1) * 20 + 4 : 0;
    // Reserve the widest possible intermediate tick, not only the coarse
    // integer ticks: narrower plots can produce 0.5 labels after layout.
    const yt0 = ticks(y0, y1, 10);
    const left = Math.max(...yt0.map((v) => tw(fmt(v), FS)), 8) + 14;
    const top = 8 + (plan.yl ? 18 : 0) + legendH, bottom = 24 + (plan.xl ? 20 : 0), right = 14;
    let H = Math.round(Math.min(Math.max(W * 0.7, 200), 340));
    let pw = W - left - right, ph = H - top - bottom;
    let off = 0;
    if (plan.equal) {
      // One unit is as long on y as on x: the mirror line y=x is a true 45-degree line.
      const want = (pw * (y1 - y0)) / (x1 - x0), ph2 = Math.max(120, Math.min(want, 420));
      const pw2 = ph2 < want ? (ph2 * (x1 - x0)) / (y1 - y0) : pw;
      // A range ratio so lopsided that equal scale would leave a sliver (x 0..3 against y 0..20) keeps the normal shape.
      if (pw2 >= pw * 0.6 && ph2 >= 120) { off = (pw - pw2) / 2; pw = pw2; ph = ph2; H = Math.round(ph + top + bottom); }
    }
    const pl = left + off;
    const X = (v: number) => pl + ((v - x0) / (x1 - x0)) * pw;
    const Y = (v: number) => top + (1 - (v - y0) / (y1 - y0)) * ph;
    // Ranges that run between multiples of pi/2 get ticks and labels in pi.
    const HP = Math.PI / 2, onHp = (v: number) => Math.abs(v / HP - Math.round(v / HP)) < 1e-6;
    const piAxis = onHp(x0) && onHp(x1) && x1 - x0 >= Math.PI * 1.99 && (x0 !== 0 || x1 !== 0);
    let xt: number[];
    if (piAxis) {
      const unit = (x1 - x0) / HP <= Math.max(2, Math.floor(pw / 56)) ? HP : Math.PI;
      xt = [];
      for (let k = Math.ceil(x0 / unit - 1e-9); k * unit <= x1 + 1e-9; k++) xt.push(k * unit);
    } else xt = ticks(x0, x1, Math.max(2, Math.floor(pw / 64)));
    const fmtPi = (v: number) => {
      const n = Math.round(v / HP);
      if (n === 0) return "0";
      const sign = n < 0 ? "\u2212" : "", a = Math.abs(n);
      const num = a === 1 ? "\u03c0" : a === 2 ? "\u03c0" : a % 2 === 0 ? a / 2 + "\u03c0" : a + "\u03c0";
      return a % 2 === 0 ? sign + (a === 2 ? "\u03c0" : a / 2 + "\u03c0") : sign + (a === 1 ? "\u03c0/2" : num + "/2");
    };
    const fmtX = (v: number) => (piAxis ? fmtPi(v) : fmt(v));
    const yt = ticks(y0, y1, Math.max(2, Math.floor(ph / 40)));
    let s = '<svg class="hm-pl" data-hm-plot="" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" role="img"><defs><clipPath id="hm-pl-clip"><rect x="' + pl + '" y="' + top + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>';
    if (plan.grid) {
      s += '<g class="hm-pl-grid">';
      xt.forEach((v) => (s += '<line x1="' + r1(X(v)) + '" y1="' + top + '" x2="' + r1(X(v)) + '" y2="' + (top + ph) + '"/>'));
      yt.forEach((v) => (s += '<line x1="' + pl + '" y1="' + r1(Y(v)) + '" x2="' + (pl + pw) + '" y2="' + r1(Y(v)) + '"/>'));
      s += "</g>";
    }
    // Axes: the zero lines when zero is in range, else the frame edges.
    const ax = x0 <= 0 && x1 >= 0 ? X(0) : pl, ay = y0 <= 0 && y1 >= 0 ? Y(0) : top + ph;
    s += '<g class="hm-pl-axes"><line x1="' + pl + '" y1="' + r1(ay) + '" x2="' + (pl + pw) + '" y2="' + r1(ay) + '"/><line x1="' + r1(ax) + '" y1="' + top + '" x2="' + r1(ax) + '" y2="' + (top + ph) + '"/></g>';
    s += '<g class="hm-pl-ticks">';
    xt.forEach((v) => (s += '<text x="' + r1(X(v)) + '" y="' + (top + ph + 17) + '" text-anchor="middle">' + fmtX(v) + "</text>"));
    yt.forEach((v) => (s += '<text x="' + (pl - 6) + '" y="' + r1(Y(v)) + '" text-anchor="end" dominant-baseline="central">' + fmt(v) + "</text>"));
    s += "</g>";
    if (plan.xl) s += '<text class="hm-pl-axis" x="' + (pl + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(plan.xl) + "</text>";
    if (plan.yl) s += '<text class="hm-pl-axis" x="' + pl + '" y="' + (8 + legendH + 10) + '" text-anchor="start">' + esc(plan.yl) + "</text>";
    // Asymptotes and guide lines, dashed, drawn under the curves.
    s += '<g clip-path="url(#hm-pl-clip)"><g class="hm-pl-rules">';
    plan.rules.forEach((r) => {
      if (r.v === "x") { if (r.at < x0 || r.at > x1) return; const xx = r1(X(r.at)); s += '<line class="hm-pl-rule' + (r.dashed ? " hm-pl-dash" : "") + '" x1="' + xx + '" y1="' + top + '" x2="' + xx + '" y2="' + (top + ph) + '"/>'; }
      else { if (r.at < y0 || r.at > y1) return; const yy = r1(Y(r.at)); s += '<line class="hm-pl-rule' + (r.dashed ? " hm-pl-dash" : "") + '" x1="' + pl + '" y1="' + yy + '" x2="' + (pl + pw) + '" y2="' + yy + '"/>'; }
    });
    s += "</g>";
    // Curves, broken at gaps and poles.
    curves.forEach((c, k) => {
      let d = "", pen = false, prev = NaN;
      c.pts.forEach(([px, py]) => {
        if (!fin(py)) { pen = false; return; }
        const sy = Y(py);
        if (pen && Math.abs(sy - prev) > ph * 1.5) pen = false;
        d += (pen ? "L" : "M") + r1(X(px)) + " " + r1(sy);
        pen = true; prev = sy;
      });
      s += '<path class="hm-pl-s hm-pl-s' + (k % 6) + (c.fn.dashed ? " hm-pl-dash" : "") + '" data-series="' + esc(c.fn.id) + '" d="' + d + '"/>';
    });
    plan.series.forEach((sr, k) => {
      const n = plan.fns.length + k, cls = "hm-pl-s" + (n % 6);
      const pts = sr.pts.map((p) => r1(X(p[0])) + " " + r1(Y(p[1])));
      if (sr.join && pts.length > 1) s += '<path class="hm-pl-s ' + cls + (sr.dashed ? " hm-pl-dash" : "") + '" d="M' + pts.join("L") + '"/>';
      sr.pts.forEach((p) => (s += '<circle class="hm-pl-dot ' + cls + '" cx="' + r1(X(p[0])) + '" cy="' + r1(Y(p[1])) + '" r="4"/>'));
    });
    s += "</g>";
    // Labelled points, each label placed where it stays inside the plot and clear of earlier labels.
    const taken: [number, number, number, number][] = [];
    const ink: Pt[] = [];
    curves.forEach((c) => c.pts.forEach(([px, py]) => { if (fin(py)) ink.push([X(px), Y(py)]); }));
    plan.series.forEach((sr) => sr.pts.forEach((p) => ink.push([X(p[0]), Y(p[1])])));
    const hits = (l: number, t: number, w: number) => ink.reduce((n, q) => n + (q[0] > l - 3 && q[0] < l + w + 3 && q[1] > t - 3 && q[1] < t + 17 ? 1 : 0), 0);
    plan.marks.forEach((m) => {
      if (m.x < x0 - 1e-9 || m.x > x1 + 1e-9 || m.y < y0 - 1e-9 || m.y > y1 + 1e-9) return;
      const px = X(m.x), py = Y(m.y);
      s += '<circle class="hm-pl-mark" cx="' + r1(px) + '" cy="' + r1(py) + '" r="5"/>';
      if (!m.label) return;
      const w = tw(m.label, FS) + 2;
      const spots: [number, number, string][] = [[px + 9, py - 9, "start"], [px - 9, py - 9, "end"], [px + 9, py + 18, "start"], [px - 9, py + 18, "end"], [px, py - 12, "middle"], [px, py + 20, "middle"]];
      const fits = (c: [number, number, string]) => {
        const l = c[2] === "start" ? c[0] : c[2] === "end" ? c[0] - w : c[0] - w / 2;
        return l >= pl - 2 && l + w <= W - 2 && c[1] - 12 >= top - 6 && c[1] + 4 <= top + ph + 2 && !taken.some((t) => l < t[2] && l + w > t[0] && c[1] - 12 < t[3] && c[1] + 4 > t[1]);
      };
      const left0 = (c: [number, number, string]) => (c[2] === "start" ? c[0] : c[2] === "end" ? c[0] - w : c[0] - w / 2);
      const ok = spots.filter(fits);
      const at = (ok.length ? ok : spots).map((c, k) => ({ c, k, h: hits(left0(c), c[1] - 12, w) })).sort((a, b) => a.h - b.h || a.k - b.k)[0].c;
      const l = at[2] === "start" ? at[0] : at[2] === "end" ? at[0] - w : at[0] - w / 2;
      taken.push([l, at[1] - 12, l + w, at[1] + 4]);
      s += '<text class="hm-pl-mlabel" x="' + r1(at[0]) + '" y="' + r1(at[1]) + '" text-anchor="' + at[2] + '">' + esc(m.label) + "</text>";
    });
    plan.rules.forEach((r) => {
      if (!r.label) return;
      const w = tw(r.label, FS);
      const spots: [number, number, string][] = [];
      if (r.v === "x" && r.at >= x0 && r.at <= x1) {
        const xx = X(r.at);
        [top + 14, top + ph - 8, top + ph / 2].forEach((yy) => { spots.push([xx + 6, yy, "start"], [xx - 6, yy, "end"]); });
      } else if (r.v === "y" && r.at >= y0 && r.at <= y1) {
        const yy = Y(r.at);
        [-6, 16].forEach((dy) => { spots.push([pl + pw - 4, yy + dy, "end"], [pl + 4, yy + dy, "start"], [pl + pw / 2, yy + dy, "middle"]); });
      }
      const lft = (c: [number, number, string]) => (c[2] === "start" ? c[0] : c[2] === "end" ? c[0] - w : c[0] - w / 2);
      const inside = spots.filter((c) => lft(c) >= pl && lft(c) + w <= pl + pw + 2 && c[1] - 12 >= top && c[1] + 4 <= top + ph + 2);
      const free = (c: [number, number, string]) => !taken.some((t) => lft(c) < t[2] && lft(c) + w > t[0] && c[1] - 12 < t[3] && c[1] + 4 > t[1]);
      const pool = inside.filter(free).length ? inside.filter(free) : inside;
      if (!pool.length) return;
      const at = pool.map((c, k) => ({ c, k, h: hits(lft(c), c[1] - 12, w) })).sort((u, v) => u.h - v.h || u.k - v.k)[0].c;
      taken.push([lft(at), at[1] - 12, lft(at) + w, at[1] + 4]);
      s += '<text class="hm-pl-rlabel" x="' + r1(at[0]) + '" y="' + r1(at[1]) + '" text-anchor="' + at[2] + '">' + esc(r.label) + "</text>";
    });
    if (showLegend) {
      const base = 8 + (plan.yl ? 0 : 0);
      legendRows.forEach((l) => {
        const yy = base + l.row * 20 + 8, cls = "hm-pl-s" + (l.i % 6);
        s += '<line class="hm-pl-s ' + cls + (l.dashed ? " hm-pl-dash" : "") + '" x1="' + (l.x + 2) + '" y1="' + yy + '" x2="' + (l.x + 24) + '" y2="' + yy + '"/><text class="hm-pl-legend" x="' + (l.x + 30) + '" y="' + yy + '" dominant-baseline="central">' + esc(l.label) + "</text>";
      });
    }
    s += "</svg>";
    // Accessible values.
    const cols = curves.map((c) => c.fn);
    const rows = 9;
    let t = '<table class="hm-plot-data"><caption>' + esc(title || "Plot values") + "</caption>";
    if (cols.length) {
      t += "<thead><tr><th scope=\"col\">x</th>" + cols.map((f) => '<th scope="col">' + esc(f.label || "y = " + f.src) + "</th>").join("") + "</tr></thead><tbody>";
      for (let k = 0; k < rows; k++) {
        const xv = x0 + ((x1 - x0) * k) / (rows - 1);
        t += '<tr><th scope="row">' + fmt(xv) + "</th>" + cols.map((f) => { let v = NaN; try { v = (f.f as (x: number) => number)(xv); } catch (_e) { /* none */ } return "<td>" + (isFinite(v) ? fmt(v) : "undefined") + "</td>"; }).join("") + "</tr>";
      }
      t += "</tbody>";
    }
    plan.series.forEach((sr) => { t += "<tbody><tr><th scope=\"rowgroup\" colspan=\"2\">" + esc(sr.label || "data") + "</th></tr>" + sr.pts.map((p) => "<tr><td>" + fmt(p[0]) + "</td><td>" + fmt(p[1]) + "</td></tr>").join("") + "</tbody>"; });
    if (plan.marks.length) t += "<tbody><tr><th scope=\"rowgroup\" colspan=\"2\">points</th></tr>" + plan.marks.map((m) => "<tr><td>" + esc(m.label || "point") + "</td><td>(" + fmt(m.x) + ", " + fmt(m.y) + ")</td></tr>").join("") + "</tbody>";
    t += "</table>";
    const summary = (title ? title + ". " : "") + "Plot, x from " + fmt(x0) + " to " + fmt(x1) + ", y from " + fmt(y0) + " to " + fmt(y1) + ". " +
      [...plan.fns.map((f) => f.label || "y = " + f.src), ...plan.series.map((q) => (q.label || "data") + " (" + q.pts.length + " points)"), ...plan.marks.map((m) => (m.label || "point") + " at (" + fmt(m.x) + ", " + fmt(m.y) + ")")].join("; ") + ".";
    return { svg: s, table: t, summary, issues };
  }

  return { compile, parse, render, ticks };
}
