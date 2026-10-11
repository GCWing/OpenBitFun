const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The serializer is pure string work over the parsed tree, so the host runner
// exercises the real .ets source: the parser is transpiled too and injected as
// the serializer's './MarkdownParser' dependency.
const SERVICES = path.join(__dirname, '../../entry/src/main/ets/services');

function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(SERVICES, `${name}.ets`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const moduleObject = { exports: {} };
  new Function('require', 'exports', 'module', compiled)(
    (specifier) => {
      const resolved = dependencies[specifier];
      if (!resolved) {
        throw new Error(`unexpected import ${specifier}`);
      }
      return resolved;
    },
    moduleObject.exports,
    moduleObject
  );
  return moduleObject.exports;
}

const parserModule = load('MarkdownParser');
const serializerModule = load('MarkdownHtmlSerializer', { './MarkdownParser': parserModule });
const { MarkdownParser } = parserModule;
const { MarkdownHtmlSerializer } = serializerModule;
const html = (text) => MarkdownHtmlSerializer.toHtml(text);

test('empty and whitespace-only input produce no payload', () => {
  assert.equal(html(''), '');
  assert.equal(html('   '), '');
  assert.equal(html('\n\n\t\n'), '');
  assert.equal(MarkdownHtmlSerializer.blocksToHtml([]), '');
});

test('every heading level maps to h1..h6 and clamps out-of-range levels', () => {
  const markers = ['#', '##', '###', '####', '#####', '######'];
  markers.forEach((marker, index) => {
    const level = index + 1;
    assert.equal(html(`${marker} Title`), `<h${level}>Title</h${level}>`);
  });
  assert.equal(html('Setext\n==='), '<h1>Setext</h1>');
  assert.equal(html('Setext\n---'), '<h2>Setext</h2>');
  assert.equal(
    MarkdownHtmlSerializer.blocksToHtml([block({ type: 'heading', level: 9, text: 'x' })]),
    '<h6>x</h6>'
  );
  assert.equal(
    MarkdownHtmlSerializer.blocksToHtml([block({ type: 'heading', level: 0, text: 'x' })]),
    '<h1>x</h1>'
  );
});

test('paragraphs render the parser inline tree', () => {
  assert.equal(html('plain paragraph'), '<p>plain paragraph</p>');
  assert.equal(
    html('plain **bold** and *em* and `code` and ~~gone~~'),
    '<p>plain <strong>bold</strong> and <em>em</em> and <code>code</code> and <del>gone</del></p>'
  );
  assert.equal(
    html('**bold** then `code` in one paragraph'),
    '<p><strong>bold</strong> then <code>code</code> in one paragraph</p>'
  );
});

test('inline markers nested inside a styled run stay literal text', () => {
  // The parser keeps a flat inline list: strong/emphasis/delete carry their raw
  // inner text, so the serializer escapes it instead of re-parsing markup.
  assert.equal(html('**bold `code`**'), '<p><strong>bold `code`</strong></p>');
});

test('text nodes and attribute values are HTML escaped', () => {
  assert.equal(html('a <b>bold</b> tag'), '<p>a &lt;b&gt;bold&lt;/b&gt; tag</p>');
  assert.equal(html('a & b "c"'), '<p>a &amp; b &quot;c&quot;</p>');
  assert.equal(
    html('[a & b](https://example.com/?x=1&y=2)'),
    '<p><a href="https://example.com/?x=1&amp;y=2">a &amp; b</a></p>'
  );
  assert.equal(
    html('[say "hi"](https://example.com)'),
    '<p><a href="https://example.com">say &quot;hi&quot;</a></p>'
  );
});

test('only allowlisted URL schemes render as anchors', () => {
  assert.equal(html('[docs](https://example.com/a)'), '<p><a href="https://example.com/a">docs</a></p>');
  assert.equal(html('[l](computer://node/path)'), '<p><a href="computer://node/path">l</a></p>');
  assert.equal(html('[f](file:///tmp/a.txt)'), '<p><a href="file:///tmp/a.txt">f</a></p>');
  assert.equal(
    html('[u](HTTPS://EXAMPLE.COM/A)'),
    '<p><a href="HTTPS://EXAMPLE.COM/A">u</a></p>'
  );
  assert.equal(
    html('<https://example.com/x>'),
    '<p><a href="https://example.com/x">https://example.com/x</a></p>'
  );
});

test('unsafe URL schemes degrade to plain text instead of an anchor', () => {
  // The parser stops the URL at the first ')', so the leftover paren survives as
  // literal text: the label renders, the scheme never reaches an attribute.
  const injected = html('[bad](javascript:alert(1))');
  assert.equal(injected, '<p>bad)</p>');
  assert.doesNotMatch(injected, /javascript/i);
  assert.equal(html('[drop](ftp://example.com/a)'), '<p>drop</p>');
  assert.equal(html('[data](data:text/html,<b>x</b>)'), '<p>data</p>');
});

test('unordered, ordered and nested list markers pick their list element', () => {
  assert.equal(html('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(html('1) a'), '<ol><li>a</li></ol>');
  assert.equal(html('- **bold** item'), '<ul><li><strong>bold</strong> item</li></ul>');
  assert.equal(html('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
});

test('task list items carry a disabled checkbox with their checked state', () => {
  assert.equal(
    html('- [x] done\n- [ ] todo'),
    '<ul><li><input type="checkbox" checked disabled> done</li>' +
      '<li><input type="checkbox" disabled> todo</li></ul>'
  );
  assert.equal(
    html('- [X] upper\n- plain'),
    '<ul><li><input type="checkbox" checked disabled> upper</li><li>plain</li></ul>'
  );
});

test('quotes nest one blockquote per parser depth', () => {
  assert.equal(html('> quoted'), '<blockquote>quoted</blockquote>');
  assert.equal(html('> > deep'), '<blockquote><blockquote>deep</blockquote></blockquote>');
  assert.equal(html('> **bold** quote'), '<blockquote><strong>bold</strong> quote</blockquote>');
});

test('dividers render as hr', () => {
  assert.equal(html('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(html('***'), '<hr>');
  assert.equal(html('___'), '<hr>');
});

test('code blocks keep their language class and escape the body', () => {
  assert.equal(
    html('```ts\nconst a = 1 < 2;\n```'),
    '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>'
  );
  assert.equal(html('```\nplain\n```'), '<pre><code>plain</code></pre>');
  assert.equal(
    html('```a"b\nx\n```'),
    '<pre><code class="language-a&quot;b">x</code></pre>'
  );
});

test('frontmatter renders as an escaped pre block', () => {
  assert.equal(
    html('---\ntitle: a & b\n---\n\nbody'),
    '<pre>title: a &amp; b</pre><p>body</p>'
  );
});

test('tables render thead/tbody with per-column alignment styles', () => {
  const document = [
    '| left | center | right |',
    '| --- | :---: | ---: |',
    '| a | b | c |'
  ].join('\n');
  assert.equal(
    html(document),
    '<table><thead><tr><th>left</th><th style="text-align: center">center</th>' +
      '<th style="text-align: right">right</th></tr></thead><tbody>' +
      '<tr><td>a</td><td style="text-align: center">b</td>' +
      '<td style="text-align: right">c</td></tr></tbody></table>'
  );
  const inlineCells = ['| n | m |', '| --- | --- |', '| **x** | `y` |'].join('\n');
  assert.equal(
    html(inlineCells),
    '<table><thead><tr><th>n</th><th>m</th></tr></thead><tbody>' +
      '<tr><td><strong>x</strong></td><td><code>y</code></td></tr></tbody></table>'
  );
});

test('a full document serializes every block type in order', () => {
  const document = [
    '---',
    'title: Doc',
    '---',
    '',
    '# Heading',
    '',
    'Some **bold** text with a [link](https://example.com) and `code`.',
    '',
    '> quoted line',
    '',
    '- [x] done',
    '- plain item',
    '',
    '1. first',
    '2. second',
    '',
    '```ts',
    'const a = 1 < 2;',
    '```',
    '',
    '| left | right |',
    '| --- | ---: |',
    '| 1 | 2 |',
    '',
    '---'
  ].join('\n');
  assert.equal(
    html(document),
    '<pre>title: Doc</pre>' +
      '<h1>Heading</h1>' +
      '<p>Some <strong>bold</strong> text with a ' +
      '<a href="https://example.com">link</a> and <code>code</code>.</p>' +
      '<blockquote>quoted line</blockquote>' +
      '<ul><li><input type="checkbox" checked disabled> done</li><li>plain item</li></ul>' +
      '<ol><li>first</li><li>second</li></ol>' +
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>' +
      '<table><thead><tr><th>left</th><th style="text-align: right">right</th></tr></thead>' +
      '<tbody><tr><td>1</td><td style="text-align: right">2</td></tr></tbody></table>' +
      '<hr>'
  );
});

test('blocksToHtml serializes a parsed tree without reparsing', () => {
  const blocks = MarkdownParser.parse('# Title\n\nbody');
  assert.equal(MarkdownHtmlSerializer.blocksToHtml(blocks), '<h1>Title</h1><p>body</p>');
  assert.deepEqual(blocks.map((entry) => entry.type), ['heading', 'paragraph']);
});

/** Builds a parser-shaped block so a single field can be probed in isolation. */
function block(fields) {
  return Object.assign({
    id: 'md-0',
    renderKey: 'md-0',
    type: 'paragraph',
    level: 0,
    language: '',
    text: '',
    items: [],
    inlines: [],
    tableRows: []
  }, fields);
}
