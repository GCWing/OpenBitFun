const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const cache = new Map();

/**
 * The two platform primitives the file chain really calls.
 *
 * `Encoding.ets` detaches bytes with `new Uint8Array(value.buffer)` and expects
 * that buffer to hold only the value's own bytes, so the shim hands back an
 * exactly sized ArrayBuffer instead of Node's pooled Buffer. A default import of
 * a kit is compiled to `kit.default.member`, so each stub answers both shapes.
 */
function platformStub(module) {
  return Object.assign({ default: module }, module);
}

const PLATFORM = {
  '@ohos.buffer': platformStub({
    from(value, encoding) {
      const bytes = typeof value === 'string'
        ? Uint8Array.from(Buffer.from(value, encoding || 'utf8'))
        : Uint8Array.from(value);
      return {
        buffer: bytes.buffer,
        toString: (enc) => Buffer.from(bytes).toString(enc || 'utf8')
      };
    }
  }),
  '@kit.PerformanceAnalysisKit': platformStub({
    hilog: { info() {}, warn() {}, error() {}, debug() {} }
  })
};

/** Loads one .ets module and resolves its relative imports from the source tree. */
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(path.join(ROOT, relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exported = {};
  cache.set(relative, exported);
  new Function('require', 'exports', js)(name => {
    if (!name.startsWith('.')) return PLATFORM[name] || {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name))
      .split(path.sep).join('/');
    return fs.existsSync(path.join(ROOT, `${target}.ets`)) ? load(target) : {};
  }, exported);
  return exported;
}

const { MarkdownParser } = load('services/MarkdownParser');
const { RemoteUiState } = load('services/RemoteUiState');
const { FileTargetResolver, FileReferenceKind } = load('pages/policy/FileTargetResolver');
const { MessageFileReferenceProjector } = load('pages/policy/MessageFileReferenceProjector');
const { RemoteFilePreviewController } = load('pages/viewmodel/RemoteFilePreviewController');
const { FilePreviewPolicy } = load('services/FilePreviewPolicy');
const { FilePreviewPhase, FilePreviewRendererKind, FilePreviewState } = load('pages/state/FilePreviewState');
const { FilePreviewTarget, FilePreviewTargetContext } = load('model/FilePreviewTarget');
const { RemoteCommandFactory } = load('services/RemoteCommandFactory');
const { FilePreviewController } = load('pages/viewmodel/FilePreviewController');

const SESSION = 'session-1';
const WORKSPACE = '/home/user/project';

/**
 * Writes the link shapes the host actually produces into an assistant answer.
 *
 * `remote_file_delivery.rs:16` tells the model to write
 * `[report.md](computer://artifacts/report.md)`; the bare form is what the model
 * writes when it names the file again in prose. Four references is the whole
 * card budget of one message, so this answer is exactly at the cap.
 */
const ANSWER = [
  'Generated the brand asset and the report.',
  '',
  '- [openbitfun-wordmark.png](computer://png/openbitfun-wordmark.png)',
  '- [REPORT.md](computer://artifacts/REPORT.md)',
  '- [bundle.zip](computer://artifacts/bundle.zip)',
  '',
  'The plain-text log is at computer://artifacts/run.log and the raw export is png/openbitfun-wordmark.png.',
  '',
  '<computer://artifacts/diagram.svg>'
].join('\n');

function projections(source, limit) {
  return limit === undefined
    ? MessageFileReferenceProjector.project(source)
    : MessageFileReferenceProjector.project(source, limit);
}

function resolve(reference, label = '') {
  return FileTargetResolver.resolve(
    reference,
    label,
    new FilePreviewTargetContext(SESSION, WORKSPACE, 1)
  );
}

/* ------------------------------------------------------------------ stage 1 */

test('stage 1: the parser reads explicit links and bare file references as links', () => {
  const blocks = MarkdownParser.parse(ANSWER);
  const links = blocks.flatMap(block => block.inlines.concat(
    block.items.flatMap(item => item.inlines)
  )).filter(inline => inline.type === 'link');

  const urls = links.map(link => link.url);
  assert.ok(urls.includes('computer://png/openbitfun-wordmark.png'),
    'an explicit markdown link keeps its computer:// url');
  assert.ok(urls.includes('computer://artifacts/run.log'),
    'a bare computer:// reference in prose is an autolink');
  assert.ok(urls.includes('computer://artifacts/diagram.svg'),
    'an angle-bracket autolink keeps its computer:// url');
  assert.ok(!urls.includes('png/photo.jpg'),
    'a bare relative file name carries no scheme, so it is plain text');
});

/* ------------------------------------------------------------------ stage 2 */

test('stage 2: a computer:// link becomes a RemoteWorkspaceFile card', () => {
  const reference = projections('[openbitfun-wordmark.png](computer://png/openbitfun-wordmark.png)')[0];
  assert.ok(reference, 'the linked png is projected');
  assert.equal(reference.path, 'computer://png/openbitfun-wordmark.png');
  assert.equal(reference.remotePath, 'png/openbitfun-wordmark.png');
  assert.equal(reference.label, 'openbitfun-wordmark.png');
});

test('stage 2: every file type the assistant links earns a card', () => {
  const byPath = new Map(projections(ANSWER).map(item => [item.remotePath, item]));
  for (const remotePath of [
    'png/openbitfun-wordmark.png',
    'artifacts/REPORT.md',
    'artifacts/bundle.zip',
    'artifacts/run.log'
  ]) {
    assert.ok(byPath.has(remotePath), `a card is projected for ${remotePath}`);
  }
  assert.equal(byPath.get('png/openbitfun-wordmark.png').label, 'openbitfun-wordmark.png',
    'the card is named by the link label');
});

test('stage 2: the card budget is bounded, and the surplus keeps its link', () => {
  const source = '- [a.png](computer://artifacts/a.png)\n- [b.md](computer://artifacts/b.md)\n' +
    '- [c.zip](computer://artifacts/c.zip)\n- [d.txt](computer://artifacts/d.txt)\n' +
    '- [e.png](computer://artifacts/e.png)';
  const references = projections(source);
  assert.equal(references.length, 4, 'one message draws at most four cards');
  assert.deepEqual(references.map(item => item.remotePath), [
    'artifacts/a.png', 'artifacts/b.md', 'artifacts/c.zip', 'artifacts/d.txt'
  ]);
  assert.equal(projections(source, 1).length, 1, 'the limit is a parameter, not a constant of the answer');
});

test('stage 2: a relative link is a card only for an output-shaped extension', () => {
  // A bare path in prose carries no scheme, so it is never resolved (see below).
  // A *relative link target* is different: the projector accepts it when its
  // extension is one of the turn's output shapes, which is the same rule the
  // shared Android/iOS projector applies (MessageFileReferences.kt:38).
  assert.equal(projections('[Preview](artifacts/preview.png)')[0].remotePath, 'artifacts/preview.png',
    'a relative image link is a workspace file');
  assert.equal(projections('[Bundle](artifacts/bundle.zip)')[0].remotePath, 'artifacts/bundle.zip');
  assert.equal(projections('[Report](artifacts/REPORT.md)').length, 0,
    'a relative markdown link is not an output shape, so it stays prose');
  assert.equal(projections('[Log](artifacts/run.log)').length, 0,
    'a relative log link is not an output shape either');
});

test('stage 2: the card path and card label stay in step with the resolver', () => {
  for (const reference of [
    'computer://png/openbitfun-wordmark.png',
    'computer://artifacts/REPORT.md',
    'file:///home/user/project/artifacts/notes.txt',
    'computer://D:/work/project/artifacts/notes.txt'
  ]) {
    const resolution = resolve(reference, 'label.md');
    assert.equal(resolution.kind, FileReferenceKind.RemoteWorkspaceFile, `${reference} resolves`);
    assert.equal(resolution.target.rawReference, reference, 'the raw reference is preserved');
    assert.equal(resolution.target.remotePath, RemoteUiState.normalizeRemoteFilePath(reference),
      'the resolved path is the normalized reference');
  }
});

test('stage 2: a scheme-less relative path is not a card', () => {
  assert.equal(projections('the photo is png/photo.jpg').length, 0,
    'a bare file name cannot be resolved against the host, so it stays plain text');
});

/* ------------------------------------------------------------------ stage 3 */

test('stage 3: the read command carries the normalized workspace-relative path', () => {
  const target = resolve('computer://png/openbitfun-wordmark.png', 'openbitfun-wordmark.png').target;
  const info = RemoteCommandFactory.getFileInfo(target.remotePath, target.sessionId);
  assert.equal(info.cmd, 'get_file_info');
  assert.equal(info.path, 'png/openbitfun-wordmark.png');
  assert.equal(info.session_id, SESSION);

  const chunk = RemoteCommandFactory.readFileChunk(target.remotePath, 0, 1024, target.sessionId);
  assert.equal(chunk.cmd, 'read_file_chunk');
  assert.equal(chunk.path, 'png/openbitfun-wordmark.png');
  assert.equal(chunk.session_id, SESSION);
});

test('stage 3: the preview target keeps the session the file must be read from', () => {
  const target = resolve('computer://png/openbitfun-wordmark.png').target;
  assert.ok(target.isValid(), 'a target with a session and a path is openable');
  const anonymous = resolve('computer://png/x.png').target;
  assert.equal(anonymous.sessionId, SESSION, 'the resolver takes the session from its context');
});

test('stage 3: normalizeRemoteFilePath only strips the schemes the host sends', () => {
  assert.equal(RemoteUiState.normalizeRemoteFilePath('computer://png/a.png'), 'png/a.png');
  assert.equal(RemoteUiState.normalizeRemoteFilePath('file:///home/u/a.png'), '/home/u/a.png');
  assert.equal(RemoteUiState.normalizeRemoteFilePath('computer://D:/work/a.png'), 'D:/work/a.png');
  assert.equal(RemoteUiState.normalizeRemoteFilePath('png/a.png'), 'png/a.png');
});

/* ------------------------------------------------------------------ stage 4 */

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  md: 'text/markdown',
  txt: 'text/plain',
  zip: 'application/zip',
  pdf: 'application/pdf'
};

function nameOf(remotePath) {
  return remotePath.split('/').pop();
}

/** A host that answers exactly like `remote_connect.rs` does for a real file. */
class FakeFileHost {
  constructor(files) {
    this.files = files;
    this.commands = [];
  }
  async getFileInfo(path, sessionId) {
    this.commands.push({ cmd: 'get_file_info', path, sessionId });
    const file = this.files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    return { name: nameOf(path), size: file.size, mimeType: MIME[file.kind] };
  }
  async readFileChunk(path, offset, limit, sessionId) {
    this.commands.push({ cmd: 'read_file_chunk', path, offset, limit, sessionId });
    const file = this.files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    const end = Math.min(file.size, offset + limit);
    return {
      name: nameOf(path),
      contentBase64: Buffer.from(file.bytes.slice(offset, end)).toString('base64'),
      revision: '1:1',
      offset,
      chunkSize: end - offset,
      totalSize: file.size,
      mimeType: MIME[file.kind]
    };
  }
  async readFile(path, sessionId, onProgress, maxBytes) {
    const file = this.files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    if (maxBytes !== undefined && file.size > maxBytes) throw new Error('File too large for preview.');
    const info = await this.getFileInfo(path, sessionId);
    return {
      name: info.name,
      mimeType: info.mimeType,
      size: info.size,
      contentBase64: Buffer.from(file.bytes).toString('base64')
    };
  }
  async streamFile(path, sessionId, onChunk) {
    const file = this.files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    const info = await this.getFileInfo(path, sessionId);
    await onChunk(new Uint8Array(file.bytes), { name: info.name, size: info.size, mimeType: info.mimeType });
    return { name: info.name, size: info.size, mimeType: info.mimeType };
  }
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

function fixtureFiles() {
  return {
    'png/openbitfun-wordmark.png': { kind: 'png', size: PNG_BYTES.length, bytes: PNG_BYTES },
    'png/photo.jpg': { kind: 'jpg', size: PNG_BYTES.length, bytes: PNG_BYTES },
    'artifacts/REPORT.md': { kind: 'md', size: 21, bytes: Buffer.from('# Report\nhello md\n') },
    'artifacts/notes.txt': { kind: 'txt', size: 11, bytes: Buffer.from('plain notes') },
    'artifacts/bundle.zip': { kind: 'zip', size: 8, bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]) },
    'artifacts/paper.pdf': { kind: 'pdf', size: 8, bytes: Buffer.from('%PDF-1.4') }
  };
}

async function preview(path, label) {
  const host = new FakeFileHost(fixtureFiles());
  const state = new FilePreviewState();
  const controller = new RemoteFilePreviewController(host, state, () => true, () => 1);
  await controller.open(resolve(path, label).target);
  return { state, host };
}

function dataSource(state) {
  return `data:${state.mimeType};base64,${state.contentBase64}`;
}

test('stage 4: an image file reaches the Ready image renderer with usable pixels', async () => {
  for (const file of ['computer://png/openbitfun-wordmark.png', 'computer://png/photo.jpg']) {
    const { state } = await preview(file);
    assert.equal(state.phase, FilePreviewPhase.Ready, `${file} is ready`);
    assert.equal(state.rendererKind, FilePreviewRendererKind.Image, `${file} renders as an image`);
    assert.equal(state.fileName, file.split('/').pop());
    assert.equal(state.contentBase64, PNG_BYTES.toString('base64'), 'the pixels survive base64');
    assert.equal(dataSource(state), `data:${state.mimeType};base64,${PNG_BYTES.toString('base64')}`);
    assert.match(dataSource(state), /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/,
      'the data source is a decodable image url');
    assert.deepEqual(Array.from(Buffer.from(state.contentBase64, 'base64')), Array.from(PNG_BYTES));
  }
});

test('stage 4: markdown and plain text reach the text renderers', async () => {
  const markdown = await preview('computer://artifacts/REPORT.md');
  assert.equal(markdown.state.phase, FilePreviewPhase.Ready);
  assert.equal(markdown.state.rendererKind, FilePreviewRendererKind.Markdown);
  assert.equal(markdown.state.textContent, '# Report\nhello md\n');

  const text = await preview('computer://artifacts/notes.txt');
  assert.equal(text.state.phase, FilePreviewPhase.Ready);
  assert.equal(text.state.rendererKind, FilePreviewRendererKind.Text);
  assert.equal(text.state.textContent, 'plain notes');
});

test('stage 4: a type with no renderer is Unsupported, not an error', async () => {
  for (const file of ['computer://artifacts/bundle.zip', 'computer://artifacts/paper.pdf']) {
    const { state } = await preview(file);
    assert.equal(state.phase, FilePreviewPhase.Unsupported, `${file} is honestly unsupported`);
    assert.equal(state.rendererKind, FilePreviewRendererKind.Unsupported);
    assert.notEqual(state.phase, FilePreviewPhase.Error, 'unsupported must not read as a failure');
  }
});

test('stage 4: a missing file is an error the ui can explain', async () => {
  const { state } = await preview('computer://artifacts/missing.png');
  assert.equal(state.phase, FilePreviewPhase.Error);
  assert.ok(state.errorText.length > 0);
});

test('stage 4: every common image extension the host can serve renders as an image', () => {
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'];
  for (const extension of extensions) {
    assert.equal(RemoteFilePreviewController.rendererFor(`preview.${extension}`, `image/${extension}`),
      FilePreviewRendererKind.Image, `.${extension} renders as an image`);
  }
  assert.equal(RemoteFilePreviewController.rendererFor('diagram.svg', 'image/svg+xml'),
    FilePreviewRendererKind.Unsupported, 'svg stays on the text path rather than the image decoder');
});

/* ------------------------------------------------------------------ stage 5 */

const { RemoteFileDownloadController } = load('services/RemoteFileDownloadController');

class FakeSaver {
  constructor() {
    this.chunks = [];
    this.beginCalls = [];
    this.finished = false;
    this.aborted = false;
  }
  async begin(name) { this.beginCalls.push(name); }
  async write(bytes) { this.chunks.push(Buffer.from(bytes)); }
  async finish() { this.finished = true; return 'file://docs/download'; }
  async abort() { this.aborted = true; }
}

function downloader(host, saver) {
  const statuses = [];
  let text = '';
  const controller = new RemoteFileDownloadController(
    host,
    (_downloading, _downloaded, status) => statuses.push(status),
    () => {},
    (value) => { text = value; },
    () => {},
    2500,
    { setTimeout: () => 1, clearTimeout: () => {} },
    saver
  );
  return { controller, statuses, statusText: () => text };
}

test('stage 5: downloading an image streams real bytes and names the destination', async () => {
  const host = new FakeFileHost(fixtureFiles());
  const saver = new FakeSaver();
  const { controller, statuses, statusText } = downloader(host, saver);

  await controller.download('computer://png/openbitfun-wordmark.png', SESSION, false, true);

  assert.deepEqual(saver.beginCalls, ['openbitfun-wordmark.png'],
    'the destination keeps the host file name');
  assert.equal(Buffer.concat(saver.chunks).toString('base64'), PNG_BYTES.toString('base64'),
    'the downloaded bytes are the real file');
  assert.ok(saver.finished, 'the destination is committed');
  assert.ok(!saver.aborted, 'no failure path ran');
  assert.ok(statuses.length > 0 && statusText().length > 0, 'the ui gets a status to show');
});

test('stage 5: a bare relative path is refused instead of saving an empty file', async () => {
  const host = new FakeFileHost(fixtureFiles());
  const saver = new FakeSaver();
  const { controller } = downloader(host, saver);
  await controller.download('   ', SESSION, false, true);
  assert.equal(saver.beginCalls.length, 0);
  assert.equal(saver.finished, false);
});

test('stage 5: a host failure aborts the destination and reports it', async () => {
  const host = new FakeFileHost(fixtureFiles());
  const saver = new FakeSaver();
  const { controller, statusText } = downloader(host, saver);
  await controller.download('computer://artifacts/missing.png', SESSION, false, true);
  assert.ok(saver.aborted, 'the partial destination is removed');
  assert.equal(saver.finished, false);
  assert.ok(statusText().length > 0, 'the failure is reported to the ui');
});

/* ------------------------------------------------------- surface wiring */

const CARD_GAPS = [
  ['pages/components/FileReferenceCard.ets', /this\.onDownload\(this\.path\)/, 'the card download action passes the raw reference'],
  ['pages/components/FileReferenceCard.ets', /this\.onPreview\(this\.path, this\.label\)/, 'the card opens the preview with the raw reference'],
  ['pages/components/ChatMessageContent.ets', /FileReferenceCard\(\{/, 'the message card list mounts the real card'],
  ['pages/components/FilePreviewSurface.ets', /Image\(`data:\$\{this\.state\.mimeType\};base64,\$\{this\.state\.contentBase64\}`\)/, 'the image preview builds its data source from the loaded bytes']
];

test('the surface wiring that carries a card tap to the preview is intact', () => {
  for (const [file, pattern, expectation] of CARD_GAPS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, pattern, expectation);
  }
});

/* --------------------------------------------------- end-to-end coherence */

const { ConversationIntentDispatcher } = load('pages/actions/ConversationIntentDispatcher');
const { ConversationIntents, ConversationIntentType } = load('pages/actions/ConversationIntent');
const { AppRoute } = load('pages/navigation/AppRouteContract');

async function settled(state) {
  for (let tick = 0; tick < 20 && state.phase === FilePreviewPhase.Loading; tick++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** The real intent → dispatcher → controller → surface chain, transport faked. */
function appChain() {
  const state = new FilePreviewState();
  const statuses = [];
  const controller = new FilePreviewController(new FakeFileHost(fixtureFiles()), state, {
    remoteAvailable: () => true,
    activeSession: () => ({ sessionId: SESSION, workspacePath: WORKSPACE }),
    workspacePath: () => WORKSPACE,
    openExternalLink: async () => true,
    onGeneralStatus: (value) => statuses.push(value),
    onRemoteStatus: (value) => statuses.push(value)
  });
  const dispatcher = new ConversationIntentDispatcher({
    mailbox: async () => {},
    openSidebar: () => {},
    back: () => {},
    newRemoteSession: () => {},
    unsupported: () => {},
    stop: async () => {},
    loadOlder: async () => {},
    approve: async () => {},
    reject: async () => {},
    cancel: async () => {},
    answer: async () => {},
    rename: async () => {},
    copy: async () => {},
    retry: async () => {},
    selectModel: async () => {},
    pickImages: async () => {},
    removeImage: () => {},
    openFilePreview: (route, request) => controller.open(route, request),
    downloadFile: () => {},
    buildPlan: async () => {},
    send: async () => {},
    voiceInput: async () => {},
    inputChanged: () => {}
  });
  return { state, controller, dispatcher, statuses };
}

test('the whole chain agrees on one path from message text to a rendered image', async () => {
  const reference = projections('[openbitfun-wordmark.png](computer://png/openbitfun-wordmark.png)')[0];
  const { state, dispatcher, statuses } = appChain();

  dispatcher.dispatch(AppRoute.RemoteChat, ConversationIntents.openFilePreview(reference.path, reference.label));
  await settled(state);

  assert.equal(state.phase, FilePreviewPhase.Ready, 'the card tap reached the preview');
  assert.equal(state.rendererKind, FilePreviewRendererKind.Image);
  assert.equal(state.fileName, 'openbitfun-wordmark.png');
  assert.equal(state.mimeType, 'image/png');
  assert.equal(state.contentBase64, PNG_BYTES.toString('base64'), 'the pixels on screen are the file');
  assert.equal(state.target.sessionId, SESSION, 'the read targeted the active session');
  assert.equal(state.target.remotePath, 'png/openbitfun-wordmark.png', 'and the workspace-relative path');
  assert.deepEqual(statuses, [], 'nothing fell back to a status message');
});

test('the same intent outside the remote conversation says so instead of opening nothing', async () => {
  const { dispatcher, statuses } = appChain();
  dispatcher.dispatch(AppRoute.RemoteHome, ConversationIntents.openFilePreview('computer://png/a.png', 'a.png'));
  assert.equal(statuses.length, 1, 'the user is told the file surface is unavailable here');
});

test('a download started from a card reaches the destination with the file bytes', async () => {
  const host = new FakeFileHost(fixtureFiles());
  const saver = new FakeSaver();
  const { controller, statusText } = downloader(host, saver);
  await controller.download('computer://artifacts/REPORT.md', SESSION, false, true);
  assert.deepEqual(saver.beginCalls, ['REPORT.md']);
  assert.equal(Buffer.concat(saver.chunks).toString('utf8'), '# Report\nhello md\n');
  assert.ok(statusText().length > 0);
});