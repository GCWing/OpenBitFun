const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const etsRoot = path.join(root, 'entry/src/main/ets');

// Run the production ArkTS classes with only platform/decorator-free mocks. The
// controller, the wire sender and the entry policy are plain classes on purpose:
// the rules they encode are what this suite pins.
function load(relativePath, resolve) {
  const source = fs.readFileSync(path.join(etsRoot, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
  }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(name => (resolve ? resolve(name) : undefined) || {}, exported);
  return exported;
}

const factory = load('services/RemoteCommandFactory.ets');
const {RemoteCommandFactory} = factory;
const {RemoteSessionManager} = load('services/RemoteSessionManager.ets', name =>
  name.endsWith('RemoteCommandFactory') ? factory : {});

function controllerModule() {
  return load('services/RemoteModelDefaultsController.ets', name =>
    name.endsWith('RemoteI18n') ? {RemoteI18n: {t: key => key}} :
      name.endsWith('RemoteUiState') ? {RemoteUiState: {emptyModelCatalog: () => emptyCatalog()}} : {});
}

const emptyCatalog = () => ({version: 0, models: [], default_models: {}});

function catalogNames(locale) {
  const entries = JSON.parse(
    fs.readFileSync(path.join(root, `entry/src/main/resources/${locale}/element/string.json`), 'utf8')
  ).string;
  return new Set(entries.map(entry => entry.name));
}

// Resource names cannot carry dots, so a code key maps to its underscore name.
test('every key the entry and the controller render exists in both catalogs', () => {
  const english = catalogNames('en_US');
  const chinese = catalogNames('zh_CN');
  const keys = [
    'settings.model.settingsTitle',
    'settings.model.upgradeBadge',
    'settings.model.unsupported',
    'settings.model.section',
    'settings.model.default',
    'status.loadingModelDefaults',
    'status.updatingModelDefaults',
    'status.modelDefaultsUpdated',
    'status.modelDefaultsLoadFailed',
    'status.modelDefaultsUpdateFailed',
    'status.remoteUnavailable'
  ];
  for (const key of keys) {
    const name = key.replace(/\./g, '_');
    assert.ok(english.has(name), `${key} is missing from en_US (${name})`);
    assert.ok(chinese.has(name), `${key} is missing from zh_CN (${name})`);
  }
});
const catalog = (defaults = {}, extra = {}) => ({
  version: 3,
  models: [
    {id: 'm-primary', name: 'Primary', provider: 'openai', base_url: '', model_name: 'm-primary', enabled: true, capabilities: []},
    {
      id: 'm-vision', name: 'Vision', provider: 'openai', base_url: '', model_name: 'm-vision',
      enabled: true, capabilities: ['text_chat', 'image_understanding']
    }
  ],
  default_models: defaults,
  ...extra
});

const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

function controllerWith(client) {
  const {RemoteModelDefaultsController} = controllerModule();
  const states = [];
  const controller = new RemoteModelDefaultsController(client, {
    onStateChanged: state => { states.push(state); }
  });
  return {controller, states, state: () => controller.getState()};
}

const gate = (supported, connected, deviceId) => ({supported, connected, deviceId});

test('set_model_defaults sends every slot in one object and null is a value', () => {
  assert.deepEqual(RemoteCommandFactory.setModelDefaults('m-primary', 'm-fast', null), {
    cmd: 'set_model_defaults',
    primary: 'm-primary',
    fast: 'm-fast',
    image_understanding: null
  });
  const cleared = RemoteCommandFactory.setModelDefaults(null, null, null);
  assert.deepEqual(cleared, {
    cmd: 'set_model_defaults',
    primary: null,
    fast: null,
    image_understanding: null
  });
  // An absent key would be ambiguous between "clear" and "leave unchanged", so
  // the whole object is always on the wire.
  assert.deepEqual(Object.keys(cleared).sort(), ['cmd', 'fast', 'image_understanding', 'primary']);
});

test('the acknowledgement is parsed as all six slots, nulls included', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  manager.send = async () => ({
    resp: 'model_defaults_updated',
    default_models: {
      primary: 'm-primary',
      fast: null,
      search: 'm-search',
      image_understanding: 'm-vision',
      image_generation: 'm-image',
      speech_recognition: 'm-speech'
    }
  });
  assert.deepEqual(await manager.setModelDefaults('m-primary', null, 'm-vision'), {
    primary: 'm-primary',
    fast: null,
    search: 'm-search',
    image_understanding: 'm-vision',
    image_generation: 'm-image',
    speech_recognition: 'm-speech'
  });
});

test('an acknowledgement without slots is followed by an authoritative device read', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  const commands = [];
  manager.send = async command => {
    commands.push(command);
    if (command.cmd === 'set_model_defaults') {
      return {resp: 'model_defaults_updated'};
    }
    return {resp: 'ok', catalog: catalog({primary: 'm-primary', fast: null})};
  };
  const defaults = await manager.setModelDefaults('m-primary', null, null);
  assert.deepEqual(commands.map(command => command.cmd), ['set_model_defaults', 'get_model_catalog']);
  // Device scope: the defaults belong to the desktop, not to an open session.
  assert.deepEqual(commands[1], {cmd: 'get_model_catalog'});
  assert.deepEqual(defaults, {
    primary: 'm-primary',
    fast: null,
    search: null,
    image_understanding: null,
    image_generation: null,
    speech_recognition: null
  });
});

test('a slot that is not a model id is refused instead of shown as configured', async () => {
  const manager = Object.create(RemoteSessionManager.prototype);
  manager.send = async () => ({resp: 'model_defaults_updated', default_models: {primary: 42}});
  await assert.rejects(manager.setModelDefaults('m-primary', null, null), /Model defaults unavailable/);
});

test('the entry belongs to the connected control target and to no other row', () => {
  const {DeviceModelSettingsEntryPolicy: entry} = load(
    'pages/policy/DeviceModelSettingsEntryPolicy.ets',
    name => name.endsWith('RemoteModels') ?
      {REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1: 'device_model_defaults_v1'} : {}
  );
  const shows = (online, deviceId, targetId, connectionState) =>
    entry.showsEntry(online, deviceId, 'phone-1', targetId, connectionState);

  assert.equal(shows(true, 'desk-1', 'desk-1', 'connected'), true);
  // Offline rows carry no entry at all.
  assert.equal(shows(false, 'desk-1', 'desk-1', 'connected'), false);
  // An online desktop this phone is not driving cannot answer a device write.
  assert.equal(shows(true, 'desk-2', 'desk-1', 'connected'), false);
  assert.equal(shows(true, 'desk-1', 'desk-1', 'reconnecting'), false);
  assert.equal(shows(true, 'desk-1', 'desk-1', 'idle'), false);
  // Never on the phone's own row, and never without an identity.
  assert.equal(shows(true, 'phone-1', 'phone-1', 'connected'), false);
  assert.equal(shows(true, '', '', 'connected'), false);

  assert.equal(entry.supportsDeviceModelDefaults(['device_model_defaults_v1', 'host_stream_v1']), true);
  assert.equal(entry.supportsDeviceModelDefaults(['workspace_id_references_v1']), false);
  assert.equal(entry.supportsDeviceModelDefaults([]), false);
  assert.equal(entry.supportsDeviceModelDefaults(undefined), false);
});

test('a missing capability greys the entry, badges it and explains the tap', () => {
  const {DeviceModelSettingsEntryPolicy: entry} = load(
    'pages/policy/DeviceModelSettingsEntryPolicy.ets',
    name => name.endsWith('RemoteModels') ?
      {REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1: 'device_model_defaults_v1'} : {}
  );
  const shown = entry.showsEntry(true, 'desk-1', 'phone-1', 'desk-1', 'connected');

  assert.equal(entry.entryEnabled(true), true);
  assert.equal(entry.entryEnabled(false), false);
  assert.equal(entry.showsUpgradeBadge(shown, true), false);
  assert.equal(entry.showsUpgradeBadge(shown, false), true);
  assert.equal(entry.degradeReasonKey(shown, true), '');
  assert.equal(entry.degradeReasonKey(shown, false), 'settings.model.unsupported');
  // No entry means no reason band: the row cannot be tapped in the first place.
  assert.equal(entry.showsUpgradeBadge(false, false), false);
  assert.equal(entry.degradeReasonKey(false, false), '');
});

test('the controller reads the device catalog without a session id', async () => {
  const calls = [];
  const {controller, state} = controllerWith({
    getModelCatalog: async (...args) => {
      calls.push(args);
      return catalog({primary: 'm-primary', fast: null, image_understanding: 'm-vision'});
    },
    setModelDefaults: async () => {
      throw new Error('write is not expected here');
    }
  });

  assert.equal(controller.setGate(gate(true, true, 'desk-1')), true);
  await controller.load();

  assert.deepEqual(calls, [[]]);
  assert.equal(state().available, true);
  assert.equal(state().loaded, true);
  assert.equal(state().loading, false);
  assert.equal(state().statusText, '');
  assert.deepEqual(state().roles, {primary: 'm-primary', fast: null, image_understanding: 'm-vision'});
  assert.equal(state().catalog.models.length, 2);
});

test('an old desktop is explained, not read', async () => {
  let reads = 0;
  const {controller, state} = controllerWith({
    getModelCatalog: async () => { reads += 1; return catalog(); },
    setModelDefaults: async () => { throw new Error('write is not expected here'); }
  });

  assert.equal(controller.setGate(gate(false, true, 'desk-1')), true);
  await controller.load();

  assert.equal(reads, 0);
  assert.equal(state().available, false);
  assert.equal(state().error, 'settings.model.unsupported');
  assert.equal(state().failure, '');
  assert.deepEqual(state().roles, {primary: null, fast: null, image_understanding: null});
});

test('a dropped link is unavailable and gates both actions', async () => {
  let reads = 0;
  let writes = 0;
  const {controller, state} = controllerWith({
    getModelCatalog: async () => { reads += 1; return catalog({primary: 'm-primary'}); },
    setModelDefaults: async () => { writes += 1; return {}; }
  });

  assert.equal(controller.setGate(gate(true, false, 'desk-1')), true);
  await controller.load();
  await controller.applyRoleSelection('fast', 'm-vision');

  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(state().available, false);
  assert.equal(state().error, 'status.remoteUnavailable');
});

test('a write is locked while it runs and sends the whole object', async () => {
  const write = deferred();
  const writeCalls = [];
  let stored = {primary: 'm-primary', fast: null, image_understanding: null};
  const {controller, state} = controllerWith({
    getModelCatalog: async () => catalog(stored),
    setModelDefaults: async (...args) => {
      writeCalls.push(args);
      stored = {primary: args[0], fast: args[1], image_understanding: args[2]};
      return write.promise;
    }
  });

  controller.setGate(gate(true, true, 'desk-1'));
  await controller.load();

  const pending = controller.applyRoleSelection('fast', 'm-vision');
  assert.equal(state().busy, true);
  assert.equal(state().statusText, 'status.updatingModelDefaults');
  await flush();
  assert.deepEqual(writeCalls, [['m-primary', 'm-vision', null]]);
  // The three slots travel together; only the selected one changed.
  await controller.applyRoleSelection('primary', 'm-vision');
  await controller.load();
  assert.deepEqual(writeCalls, [['m-primary', 'm-vision', null]]);

  write.resolve({primary: 'm-primary', fast: 'm-vision', image_understanding: null});
  await pending;
  assert.equal(state().busy, false);
  assert.equal(state().statusText, 'status.modelDefaultsUpdated');
  assert.equal(state().roles.fast, 'm-vision');
});

test('values change only after the read-back, never optimistically', async () => {
  const write = deferred();
  const read = deferred();
  let reads = 0;
  const {controller, state} = controllerWith({
    getModelCatalog: async () => {
      reads += 1;
      // Page open, then the pre-write read; the third is the post-write re-read.
      return reads <= 2 ?
        catalog({primary: 'm-primary', fast: null, image_understanding: null}) : read.promise;
    },
    setModelDefaults: async () => write.promise
  });

  controller.setGate(gate(true, true, 'desk-1'));
  await controller.load();
  assert.equal(state().roles.primary, 'm-primary');

  const pending = controller.applyRoleSelection('primary', 'm-vision');
  // In flight: the request is out, nothing on screen moved.
  assert.equal(state().busy, true);
  assert.equal(state().roles.primary, 'm-primary');

  write.resolve({});
  await flush();
  // Acknowledged: still nothing on screen, because the desktop reconciles and
  // the read has not answered yet.
  assert.equal(reads, 3);
  assert.equal(state().roles.primary, 'm-primary');
  assert.equal(state().busy, true);

  // The desktop repaired the selection while persisting it: the read decides.
  read.resolve(catalog({primary: 'm-reconciled', fast: 'm-vision', image_understanding: null}));
  await pending;
  assert.deepEqual(state().roles, {primary: 'm-reconciled', fast: 'm-vision', image_understanding: null});
  assert.equal(state().busy, false);
  assert.equal(state().statusText, 'status.modelDefaultsUpdated');
});

test('a write keeps the slots a desktop save changed after the page opened', async () => {
  const writeCalls = [];
  let stored = {primary: 'm-primary', fast: null, image_understanding: null};
  const {controller, state} = controllerWith({
    getModelCatalog: async () => catalog(stored),
    setModelDefaults: async (...args) => {
      writeCalls.push(args);
      stored = {primary: args[0], fast: args[1], image_understanding: args[2]};
      return {};
    }
  });

  controller.setGate(gate(true, true, 'desk-1'));
  await controller.load();
  stored = {primary: 'm-desktop', fast: null, image_understanding: null};
  await controller.applyRoleSelection('fast', 'm-vision');

  assert.deepEqual(writeCalls, [['m-desktop', 'm-vision', null]]);
  assert.equal(state().roles.primary, 'm-desktop');
});

test('selecting the value a role already has writes nothing', async () => {
  let writes = 0;
  const {controller, state} = controllerWith({
    getModelCatalog: async () => catalog({primary: 'm-primary', fast: 'm-vision'}),
    setModelDefaults: async () => { writes += 1; return {}; }
  });

  controller.setGate(gate(true, true, 'desk-1'));
  await controller.load();
  await controller.applyRoleSelection('fast', 'm-vision');
  await controller.applyRoleSelection('fast', 'm-vision');

  assert.equal(writes, 0);
  assert.equal(state().busy, false);
});

test('an unknown model id and a transport failure stay distinct', async () => {
  const rejected = controllerWith({
    getModelCatalog: async () => catalog({primary: 'm-primary'}),
    setModelDefaults: async () => { throw new Error('Unknown model id: m-missing'); }
  });
  rejected.controller.setGate(gate(true, true, 'desk-1'));
  await rejected.controller.load();
  await rejected.controller.applyRoleSelection('primary', 'm-missing');
  assert.equal(rejected.state().error, 'Unknown model id: m-missing');
  assert.equal(rejected.state().failure, 'write');
  assert.equal(rejected.state().busy, false);
  assert.equal(rejected.state().roles.primary, 'm-primary');

  const offline = controllerWith({
    getModelCatalog: async () => { throw new Error('Remote transport is not connected.'); },
    setModelDefaults: async () => { throw new Error('write is not expected here'); }
  });
  offline.controller.setGate(gate(true, true, 'desk-1'));
  await offline.controller.load();
  assert.equal(offline.state().error, 'Remote transport is not connected.');
  assert.equal(offline.state().failure, 'load');
  assert.equal(offline.state().loading, false);
});

test('a failed read-back after an accepted write is a read failure', async () => {
  let reads = 0;
  const {controller, state} = controllerWith({
    getModelCatalog: async () => {
      reads += 1;
      if (reads <= 2) {
        return catalog({primary: 'm-primary'});
      }
      throw new Error('Remote transport is not connected.');
    },
    setModelDefaults: async () => ({primary: 'm-vision'})
  });

  controller.setGate(gate(true, true, 'desk-1'));
  await controller.load();
  await controller.applyRoleSelection('primary', 'm-vision');

  assert.equal(state().failure, 'load');
  assert.equal(state().error, 'Remote transport is not connected.');
  assert.equal(state().busy, false);
  // The write was accepted but unconfirmed, so the old value stays on screen.
  assert.equal(state().roles.primary, 'm-primary');
});

test('a result that lands after a gate change is dropped', async () => {
  const read = deferred();
  const {controller, state} = controllerWith({
    getModelCatalog: async () => read.promise,
    setModelDefaults: async () => ({})
  });

  controller.setGate(gate(true, true, 'desk-1'));
  const pending = controller.load();
  controller.setGate(gate(true, true, 'desk-2'));
  read.resolve(catalog({primary: 'm-primary'}));
  await pending;

  // The values belong to the desktop the sheet has already left.
  assert.deepEqual(state().roles, {primary: null, fast: null, image_understanding: null});
  assert.equal(state().loaded, false);
  assert.equal(state().loading, false);
});

test('reset clears the page and a repeated gate change reports no reset', async () => {
  const {controller, state} = controllerWith({
    getModelCatalog: async () => catalog({primary: 'm-primary'}),
    setModelDefaults: async () => ({})
  });

  assert.equal(controller.setGate(gate(true, true, 'desk-1')), true);
  assert.equal(controller.setGate(gate(true, true, 'desk-1')), false);
  await controller.load();
  assert.equal(state().loaded, true);

  controller.reset();
  assert.equal(state().available, false);
  assert.equal(state().loaded, false);
  assert.deepEqual(state().roles, {primary: null, fast: null, image_understanding: null});
});
