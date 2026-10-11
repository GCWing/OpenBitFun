const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The rich copy path is exercised against a stubbed pasteboard kit so the
// documented plain-primary + html-record sequence is host-verifiable; device
// paste behavior stays a device-level check.
function loadEts(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(name => dependencies[name] || {}, exported);
  return exported;
}

const serviceDir = path.join(__dirname, '../../entry/src/main/ets/services');
const { OhosError } = loadEts(path.join(serviceDir, 'OhosError.ets'));

// Official flavor identifiers: createData takes the plain primary record and
// each extra flavor is added with addRecord(createRecord(...)).
function pasteboardStub(options = {}) {
  const calls = { order: [], createData: [], createRecord: [], addRecord: [], setData: [] };
  const api = {
    MIMETYPE_TEXT_PLAIN: 'text/plain',
    MIMETYPE_TEXT_HTML: 'text/html',
    createData(mimeType, value) {
      calls.order.push('createData');
      calls.createData.push({ mimeType, value });
      if (options.createDataError) throw options.createDataError;
      const records = [];
      return {
        records,
        addRecord(record) { calls.order.push('addRecord'); records.push(record); calls.addRecord.push(record); return this; },
      };
    },
    createRecord(mimeType, value) {
      calls.order.push('createRecord');
      const record = { mimeType, value };
      calls.createRecord.push(record);
      return record;
    },
    getSystemPasteboard() {
      return {
        async setData(data) {
          calls.order.push('setData');
          calls.setData.push(data);
          if (options.setDataError) throw options.setDataError;
        },
      };
    },
  };
  return { api, calls };
}

function loadClipboard(stub) {
  return loadEts(path.join(serviceDir, 'ClipboardService.ets'), {
    '@ohos.pasteboard': { default: stub.api }, './OhosError': { OhosError },
  });
}

const MARKDOWN = '# Title\n\nPlain **markdown** source.\n';
const HTML = '<h1>Title</h1><p>Plain <strong>markdown</strong> source.</p>';

test('rich payload keeps the markdown plain record primary and appends html second', () => {
  const { api, calls } = pasteboardStub();
  const { ClipboardRichPayload } = loadClipboard({ api, calls });
  const specs = ClipboardRichPayload.build(MARKDOWN, HTML);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0], { mimeType: api.MIMETYPE_TEXT_PLAIN, value: MARKDOWN });
  assert.deepEqual(specs[1], { mimeType: api.MIMETYPE_TEXT_HTML, value: HTML });
  // Building a payload is pure: it must not touch the pasteboard.
  assert.deepEqual(calls.order, []);
});

test('rich payload passes both flavors through verbatim', () => {
  const { api } = pasteboardStub();
  const { ClipboardRichPayload } = loadClipboard({ api, calls: {} });
  const markdown = '# Heading\n\n| a | b |\n| - | - |\n\n```ts\nconst value = "<&>";\n```\n\n';
  const html = '<pre><code>const value = &quot;&lt;&amp;&gt;&quot;;</code></pre>';
  const specs = ClipboardRichPayload.build(markdown, html);
  assert.strictEqual(specs[0].value, markdown);
  assert.strictEqual(specs[1].value, html);
});

test('empty flavors degrade to a plain-only payload and never promote html', () => {
  const { api } = pasteboardStub();
  const { ClipboardRichPayload } = loadClipboard({ api, calls: {} });
  assert.deepEqual(ClipboardRichPayload.build(MARKDOWN, ''), [
    { mimeType: api.MIMETYPE_TEXT_PLAIN, value: MARKDOWN },
  ]);
  // A missing markdown source still leaves the guaranteed plain flavor in
  // charge so plain receivers never read an html-only clipboard.
  assert.deepEqual(ClipboardRichPayload.build('', HTML), [
    { mimeType: api.MIMETYPE_TEXT_PLAIN, value: '' },
    { mimeType: api.MIMETYPE_TEXT_HTML, value: HTML },
  ]);
  assert.deepEqual(ClipboardRichPayload.build('', ''), [
    { mimeType: api.MIMETYPE_TEXT_PLAIN, value: '' },
  ]);
});

test('copyRich writes the plain record first and adds the html record before setting data', async () => {
  const stub = pasteboardStub();
  const { ClipboardService, ClipboardRichPayload } = loadClipboard(stub);
  await new ClipboardService().copyRich(MARKDOWN, HTML);
  assert.deepEqual(stub.calls.order, ['createData', 'createRecord', 'addRecord', 'setData']);
  assert.deepEqual(stub.calls.createData, [
    { mimeType: ClipboardRichPayload.MIMETYPE_TEXT_PLAIN, value: MARKDOWN },
  ]);
  assert.deepEqual(stub.calls.createRecord, [
    { mimeType: ClipboardRichPayload.MIMETYPE_TEXT_HTML, value: HTML },
  ]);
  assert.equal(stub.calls.setData.length, 1);
  assert.deepEqual(stub.calls.setData[0].records, stub.calls.addRecord);
});

test('copyRich with no html flavor performs the plain-only write', async () => {
  const stub = pasteboardStub();
  const { ClipboardService } = loadClipboard(stub);
  await new ClipboardService().copyRich(MARKDOWN, '');
  assert.deepEqual(stub.calls.order, ['createData', 'setData']);
  assert.deepEqual(stub.calls.createData, [{ mimeType: 'text/plain', value: MARKDOWN }]);
  assert.deepEqual(stub.calls.createRecord, []);
  assert.deepEqual(stub.calls.addRecord, []);
});

test('writeText remains a single plain record write', async () => {
  const stub = pasteboardStub();
  const { ClipboardService } = loadClipboard(stub);
  await new ClipboardService().writeText(MARKDOWN);
  assert.deepEqual(stub.calls.order, ['createData', 'setData']);
  assert.deepEqual(stub.calls.createData, [{ mimeType: 'text/plain', value: MARKDOWN }]);
  assert.deepEqual(stub.calls.addRecord, []);
});

test('copyRich surfaces pasteboard failures as clipboard errors', async () => {
  const rpcError = pasteboardStub({ setDataError: new Error('denied') });
  await assert.rejects(new (loadClipboard(rpcError).ClipboardService)().copyRich(MARKDOWN, HTML),
    error => error instanceof Error && error.message === 'denied');
  const businessError = pasteboardStub({ setDataError: { code: 401, message: 'not permitted' } });
  await assert.rejects(new (loadClipboard(businessError).ClipboardService)().copyRich(MARKDOWN, HTML),
    error => error instanceof Error && /^clipboard rich write failed: /.test(error.message));
});

test('copyRich wraps record construction failures inside the guarded block', async () => {
  const stub = pasteboardStub({ createDataError: { code: 12900001, message: 'system error' } });
  await assert.rejects(new (loadClipboard(stub).ClipboardService)().copyRich(MARKDOWN, HTML),
    error => error instanceof Error && /^clipboard rich write failed: /.test(error.message));
});
