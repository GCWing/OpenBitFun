const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../entry/src/main');
const english = JSON.parse(fs.readFileSync(path.join(root, 'resources/en_US/element/string.json'))).string;
const chinese = JSON.parse(fs.readFileSync(path.join(root, 'resources/zh_CN/element/string.json'))).string;
const realCatalog = { string: english.concat(chinese.map(entry => ({ ...entry, name: `${entry.name}.zh` }))) };

// Run the production ArkTS classes with only platform resource/decorator mocks.
function load(catalog = realCatalog) {
  const cache = new Map();
  let language = 'zh-CN';
  const resourceManager = {
    getRawFileContentSync(filename) {
      assert.equal(filename, 'string.json');
      return Buffer.from(JSON.stringify(catalog));
    },
    getStringByNameSync(key) {
      return (language === 'zh-CN' ? chinese : english).find(entry => entry.name === key).value;
    }
  };
  function module(name) {
    if (cache.has(name)) return cache.get(name);
    const source = fs.readFileSync(path.join(root, 'ets/i18n', `${name}.ets`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
    }).outputText;
    const exports = {};
    const requireMock = specifier => {
      if (specifier === '@kit.ArkTS') return { util: { TextDecoder: { create: () => ({ decodeWithStream: bytes => Buffer.from(bytes).toString('utf8') }) } } };
      if (specifier === '@kit.LocalizationKit') return { intl: { DateTimeFormat: Intl.DateTimeFormat } };
      return module(specifier.replace('./', ''));
    };
    new Function('require', 'exports', 'getContext', 'ObservedV2', 'Trace', compiled)(
      requireMock, exports, () => ({ resourceManager }), value => value, () => {}
    );
    cache.set(name, exports);
    return exports;
  }
  return {
    create: locale => new (module('HostTextRetranslator').HostTextRetranslator)(locale),
    remote: module('RemoteI18n').RemoteI18n,
    setResourceLanguage: locale => { language = locale; }
  };
}

for (const locale of ['zh-CN', 'en-US']) {
  test(`${locale}: exact and templated messages always converge to the target`, () => {
    const r = load().create(locale);
    for (const [en, zh] of [
      ['Back', '返回'],
      ['Downloaded a.txt · 3 KB', '下载完成 a.txt · 3 KB'],
      ['Switching to Desk-1…', '正在切换到 Desk-1…'],
      ['3 more sessions', '还有 3 个会话'],
      ['Show 3 more sessions', '再显示 3 条会话']
    ]) {
      const expected = locale === 'zh-CN' ? zh : en;
      for (const input of [en, zh]) {
        assert.equal(r.retranslate(input), expected);
        assert.equal(r.retranslate(r.retranslate(input)), expected);
      }
    }
  });

  test(`${locale}: every real catalog template translates with parameters intact`, () => {
    const r = load().create(locale);
    const source = locale === 'zh-CN' ? english : chinese;
    const target = new Map((locale === 'zh-CN' ? chinese : english).map(e => [e.name, e.value]));
    const fill = template => template.replace(/%[12]\$s/g, slot => slot === '%1$s' ? 'VALUE' : 'SIZE');
    for (const entry of source.filter(e => e.value.includes('%1$s'))) {
      const expected = fill(target.get(entry.name));
      assert.equal(r.retranslate(fill(entry.value)), expected, entry.name);
      assert.equal(r.retranslate(expected), expected, entry.name);
    }
  });

  test(`${locale}: restricted status translation never falls back to the full catalog`, () => {
    const r = load().create(locale);
    for (const name of ['Back', '3 sessions', 'Show 3 more sessions', 'my workspace']) {
      assert.equal(r.retranslateKnown(name, ['status.notConnected']), name);
    }
    for (const input of ['未连接', 'Not connected']) {
      assert.equal(r.retranslateKnown(input, ['status.notConnected']), locale === 'zh-CN' ? '未连接' : 'Not connected');
    }
  });

  test(`${locale}: workspace identity protects even names identical to placeholders`, () => {
    const { remote } = load();
    remote.setLanguage(locale);
    for (const name of ['Back', '3 sessions', 'Not connected', '未连接']) {
      assert.equal(remote.retranslateWorkspaceName(name, '/remote/project', ''), name);
      assert.equal(remote.retranslateWorkspaceName(name, '', 'workspace-id'), name);
    }
    assert.equal(remote.retranslateWorkspaceName('Back', '', ''), 'Back');
    assert.equal(remote.retranslateWorkspaceName('未连接', '', ''), locale === 'zh-CN' ? '未连接' : 'Not connected');
  });
}

test('literal parameters survive initial formatting and language refresh', () => {
  const { remote, setResourceLanguage } = load();
  remote.setLanguage('en-US');
  setResourceLanguage('en-US');
  for (const filename of ['budget$$.txt', 'x$&y.txt', "x$`y.txt", "x$'y.txt", 'a%2$s.txt', 'a%1$s.txt']) {
    const initial = remote.f2('status.downloadDone', filename, '3 KB');
    assert.equal(initial, `Downloaded ${filename} · 3 KB`);
    remote.setLanguage('zh-CN');
    assert.equal(remote.retranslate(initial), `下载完成 ${filename} · 3 KB`);
    remote.setLanguage('en-US');
  }
});

test('messages produced after locale update remain stable when asynchronous save completes', async () => {
  const { remote, setResourceLanguage } = load();
  remote.setLanguage('en-US');
  remote.setLanguage('zh-CN');
  setResourceLanguage('zh-CN');
  const completedDuringSave = remote.f2('status.downloadDone', 'a.txt', '3 KB');
  await Promise.resolve();
  assert.equal(remote.retranslate(completedDuringSave), completedDuringSave);
});

test('unknown and ambiguous messages are retained', () => {
  const catalog = { string: [
    { name: 'first', value: 'Duplicate' }, { name: 'second', value: 'Duplicate' },
    { name: 'first.zh', value: '重复' }, { name: 'second.zh', value: '重复' },
    { name: 'one', value: '%1$s items' }, { name: 'two', value: '%1$s items' },
    { name: 'one.zh', value: '%1$s 项' }, { name: 'two.zh', value: '%1$s 条' }
  ] };
  for (const locale of ['en-US', 'zh-CN']) {
    const r = load(catalog).create(locale);
    for (const message of ['', 'unknown', 'Duplicate', '重复', '3 items', '3 项', '3 条']) {
      assert.equal(r.retranslate(message), message);
    }
  }
});

test('equally specific overlapping templates are not guessed', () => {
  const r = load({ string: [
    { name: 'first', value: 'A%1$s' }, { name: 'first.zh', value: '甲%1$s' },
    { name: 'second', value: '%1$sB' }, { name: 'second.zh', value: '%1$s乙' }
  ] }).create('zh-CN');
  assert.equal(r.retranslate('AB'), 'AB');
});

test('shared runtime refresh preserves workspace identity and refreshes download status', () => {
  const source = fs.readFileSync(path.join(root, 'ets/pages/runtime/AppRootRuntimeComposition.ets'), 'utf8');
  const body = source.split('  refreshLocalizedRuntimeCopy(): void {')[1].split('\n  }')[0];
  const { remote } = load();
  remote.setLanguage('zh-CN');
  const state = {
    statusText: 'Downloaded budget$$.txt · 3 KB',
    sessionErrorText: '',
    workspaceName: 'Not connected', workspacePath: '/remote/project', workspaceId: 'id',
    fileDownloadStatus: 'Downloaded budget$$.txt · 3 KB',
    setStatusText(value) { this.statusText = value; },
    setError(value) { this.sessionErrorText = value; },
    setWorkspace(name) { this.workspaceName = name; },
    setDownloadStatus(_downloading, _downloaded, value) { this.fileDownloadStatus = value; }
  };
  const context = { remotePageState: state, filePreviewState: { errorText: '' } };
  const refresh = new Function('RemoteI18n', 'ConnectionStatusPresenter', body);
  for (let index = 0; index < 2; index++) {
    refresh.call(context, remote, { labelKey: () => 'status.notConnected' });
    assert.equal(state.statusText, '下载完成 budget$$.txt · 3 KB');
    assert.equal(state.fileDownloadStatus, state.statusText);
    assert.equal(state.workspaceName, 'Not connected');
  }
});
