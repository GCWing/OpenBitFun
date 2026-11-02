/* 死码审计：每项都用两种独立方法交叉验证，单一方法的结论不算数。
   用法：node audit.mjs <html 文件> */
import fs from 'node:fs';

const file = process.argv[2] || 'device-hub-popout.html';
const src = fs.readFileSync(file, 'utf8');

const styleBlocks = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const scriptBlocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const css = styleBlocks.join('\n');
const js = scriptBlocks.join('\n');
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const jsNoComment = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const countLiteral = (hay, needle) => hay.split(needle).length - 1;
const uniq = (a) => [...new Set(a)];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── 1. CSS 变量：方法 A = var() 引用；方法 B = 直接字符串出现次数 ── */
const declaredVars = uniq([...cssNoComment.matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/gm)].map((m) => m[1]));
const varRows = declaredVars.map((v) => {
  const viaVarRef = countLiteral(src, `var(${v}`);
  const viaRawString = countLiteral(src, v) - 1; /* 减掉声明本身 */
  return { v, viaVarRef, viaRawString, dead: viaVarRef === 0 && viaRawString <= 0 };
});

/* ── 2. CSS 类：方法 A = 类名出现在 style 之外；方法 B = 排除注释后再看 ── */
const outsideStyle = src
  .replace(/<style>[\s\S]*?<\/style>/g, '\u0000STYLE\u0000')
  .replace(/<!--[\s\S]*?-->/g, '');
const declaredClasses = uniq([...cssNoComment.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const clsRows = declaredClasses.map((c) => {
  const inMarkup = countLiteral(outsideStyle, c);
  /* 动态拼接：只认「前缀 + 插值」这种真实形式，例如 hub--${mode}。
     早先的写法里带了个 x${...}y 分支，会匹配到全文任意模板插值，等于恒为真。 */
  const stem = c.split(/--|__/)[0];
  const dyn = new RegExp(`\\b${esc(stem)}(?:--|__)?\\$\\{`).test(jsNoComment);
  return { c, inMarkup, dyn, dead: inMarkup === 0 && !dyn };
});

/* ── 3. JS 顶层符号：方法 A = 词法边界计数；方法 B = 去掉声明行后是否还出现 ── */
const declRe = /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
const topNames = uniq([...jsNoComment.matchAll(declRe)].map((m) => m[1]));
const symRows = topNames.map((n) => {
  const boundary = new RegExp(`(^|[^\\w$])${esc(n)}([^\\w$]|$)`, 'g');
  const hits = (jsNoComment.match(boundary) || []).length;
  /* 方法 B：把 `const/let/var/function <name>` 声明整行删掉，再看名字还剩几次 */
  const declLine = new RegExp(`^.*\\b(?:const|let|var|function)\\s+${esc(n)}\\b.*$`, 'gm');
  const withoutDecl = jsNoComment.replace(declLine, '');
  const remaining = (withoutDecl.match(boundary) || []).length;
  return { n, hits, remaining, dead: hits <= 1 && remaining === 0 };
});

/* ── 4. 重复 SVG ── */
const svgTally = (t) => {
  const m = new Map();
  [...t.matchAll(/<svg[\s\S]*?<\/svg>/g)].forEach((x) => m.set(x[0], (m.get(x[0]) || 0) + 1));
  return [...m.entries()].filter(([, n]) => n > 1);
};

/* ── 输出 ── */
const line = (s) => console.log(s);
line(`文件 ${file}：${src.length} 字符 / ${src.split('\n').length} 行`);
line(`  style ${styleBlocks.length} 块 / script ${scriptBlocks.length} 块`);

line(`\n[1] CSS 变量 ${declaredVars.length} 个`);
const deadVars = varRows.filter((r) => r.dead);
deadVars.length
  ? deadVars.forEach((r) => line(`    ✗ 死: ${r.v}  (var() 引用 ${r.viaVarRef} / 裸串 ${r.viaRawString})`))
  : line('    ✓ 无死变量');
const suspectVars = varRows.filter((r) => !r.dead && r.viaVarRef === 0);
if (suspectVars.length) suspectVars.forEach((r) => line(`    ! 未被 var() 引用但裸串出现 ${r.viaRawString} 次: ${r.v}`));

line(`\n[2] CSS 类 ${declaredClasses.length} 个`);
const deadCls = clsRows.filter((r) => r.dead);
deadCls.length
  ? deadCls.forEach((r) => line(`    ✗ 待人工确认: ${r.c}  (markup ${r.inMarkup} / 动态疑似 ${r.dyn})`))
  : line('    ✓ 无死类');
const dynCls = clsRows.filter((r) => !r.dead && r.dyn && r.inMarkup === 0);
if (dynCls.length) dynCls.forEach((r) => line(`    ~ 判为动态拼接，保留: ${r.c}`));

line(`\n[3] JS 顶层符号 ${topNames.length} 个`);
const deadSyms = symRows.filter((r) => r.dead);
deadSyms.length
  ? deadSyms.forEach((r) => line(`    ✗ 待人工确认: ${r.n}  (边界计数 ${r.hits} / 去掉声明后 ${r.remaining})`))
  : line('    ✓ 无死符号');

line(`\n[4] 重复 SVG`);
const dj = svgTally(js);
const dh = svgTally(src.replace(/<script>[\s\S]*?<\/script>/g, ''));
line(`    script 内重复组 ${dj.length}，markup 内重复组 ${dh.length}`);
dj.forEach(([s, n]) => line(`    script ×${n} 可省 ${s.length * (n - 1)} 字符`));
dh.forEach(([s, n]) => line(`    markup ×${n} 可省 ${s.length * (n - 1)} 字符`));

line(`\n[5] 内联 style 属性 ${countLiteral(src, 'style="')} 处`);
[...src.matchAll(/style="([^"]*)"/g)].forEach((m) => line(`    - ${m[1].slice(0, 70)}`));

line(
  `\n合计：死变量 ${deadVars.length} / 可疑死类 ${deadCls.length} / 可疑死符号 ${deadSyms.length}` +
    `  → 可疑项都必须先用 grep 复核再删`
);
