const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname,
  '../../entry/src/main/ets/services/WindowSystemBarService.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true
} }).outputText;

function harness() {
  const requests = [];
  const window = {
    AvoidAreaType: { TYPE_SYSTEM: 0, TYPE_NAVIGATION_INDICATOR: 1, TYPE_CUTOUT: 2, TYPE_KEYBOARD: 3 },
    getLastWindow() {
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    }
  };
  const exports = {};
  new Function('require', 'exports', 'ObservedV2', 'Trace', compiled)(
    name => name === '@kit.ArkUI' ? { window } : { RemoteLogger: { info() {}, error() {} } },
    exports, value => value, () => {}
  );
  return { requests, Binding: exports.WindowInsetsBinding };
}

function appWindow(right) {
  let listener;
  let detached = 0;
  return {
    getWindowAvoidArea(type) {
      return {
        topRect: { height: 0 }, bottomRect: { height: type === 1 ? 28 : 0 },
        leftRect: { width: 0 }, rightRect: { width: type === 2 ? right : 0 }
      };
    },
    on(_event, callback) { listener = callback; },
    off(_event, callback) {
      assert.equal(callback, listener);
      detached++;
    },
    change(value) { right = value; listener({}); },
    get detached() { return detached; }
  };
}

const ui = { px2vp: value => value };
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const outcome of ['success', 'failure']) {
  test(`late ${outcome} from a closed generation cannot replace live insets`, async () => {
    const { Binding, requests } = harness();
    const old = new Binding();
    old.bind(ui, {});
    old.unbind();
    const current = new Binding();
    current.bind(ui, {});
    const liveWindow = appWindow(64);
    requests[1].resolve(liveWindow);
    await settle();
    assert.equal(current.right, 64);

    const staleWindow = appWindow(4);
    if (outcome === 'success') requests[0].resolve(staleWindow);
    else requests[0].reject(new Error('Previous window was destroyed'));
    await settle();
    assert.equal(current.right, 64, 'obsolete completion must not overwrite the live broadcast');
    assert.equal(current.bottom, 28);
    if (outcome === 'success') assert.equal(staleWindow.detached, 1);

    const sibling = new Binding();
    sibling.bind(ui, {});
    assert.equal(sibling.right, 64, 'new listeners must receive an unpolluted cached value');
    assert.equal(requests.length, 2, 'live bindings still share one window subscription');
    liveWindow.change(32);
    assert.equal(current.right, 32);
    assert.equal(sibling.right, 32);
    current.unbind();
    assert.equal(liveWindow.detached, 0);
    sibling.unbind();
    assert.equal(liveWindow.detached, 1);
  });
}

test('completion after the last unbind cannot seed the next generation cache', async () => {
  const { Binding, requests } = harness();
  const old = new Binding();
  old.bind(ui, {});
  old.unbind();
  const staleWindow = appWindow(99);
  requests[0].resolve(staleWindow);
  await settle();
  assert.equal(staleWindow.detached, 1);
  const next = new Binding();
  next.bind(ui, {});
  assert.equal(next.right, 0, 'a closed generation must not publish into the cache');
  const liveWindow = appWindow(64);
  requests[1].resolve(liveWindow);
  await settle();
  assert.equal(next.right, 64);
  next.unbind();
  assert.equal(liveWindow.detached, 1);
});
