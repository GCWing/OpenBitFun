const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const etsRoot = path.join(root, 'entry/src/main/ets');

// The two device-model pages are one workflow, and most of what they promise is
// decided before ArkUI sees anything: which models a role may be set to, what a
// role row says, when a write is allowed, and what the sheet reports afterwards.
// Those rules are plain classes and pure functions, so they are run here for
// real. The decorators are the platform's binding rather than part of the rules,
// so they come off before transpiling.
function load(relativePath, resolve) {
  const source = fs.readFileSync(path.join(etsRoot, relativePath), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
  }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(name => (resolve ? resolve(name) : undefined) || {}, exported);
  return exported;
}

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const emptyCatalog = () => ({version: 0, models: [], default_models: {}});

function controllerModule() {
  return load('services/RemoteModelDefaultsController.ets', name =>
    name.endsWith('RemoteI18n') ? {RemoteI18n: {t: key => key}} :
      name.endsWith('RemoteUiState') ? {RemoteUiState: {emptyModelCatalog: () => emptyCatalog()}} : {});
}

function policyModule() {
  return load('pages/policy/ModelRoleCandidatesPolicy.ets');
}

function sheetStateModule() {
  const controller = controllerModule();
  const policy = policyModule();
  return load('pages/state/DeviceModelDefaultsSheetState.ets', name =>
    name.endsWith('RemoteModelDefaultsController') ? controller :
      name.endsWith('RemoteUiState') ? {RemoteUiState: {emptyModelCatalog: () => emptyCatalog()}} :
        name.endsWith('ModelRoleCandidatesPolicy') ? policy : {});
}

function settingsSheetStateModule() {
  const models = sheetStateModule();
  return load('pages/state/SettingsSheetState.ets', name =>
    name.endsWith('DeviceModelDefaultsSheetState') ? models : {});
}

const catalog = (defaults = {}) => ({
  version: 3,
  models: [
    {id: 'm-primary', name: 'Primary', provider: 'openai', base_url: '', model_name: 'm-primary', enabled: true, capabilities: ['text_chat']},
    {
      id: 'm-vision', name: 'Vision', provider: 'openai', base_url: '', model_name: 'm-vision',
      enabled: true, capabilities: ['text_chat', 'image_understanding']
    }
  ],
  default_models: defaults
});

const catalogOf = models => ({version: 1, models, default_models: {}});
const ids = models => models.map(model => model.id);
const gate = (supported, connected, deviceId) => ({supported, connected, deviceId});
const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

/** The sheet state over one fixture desktop, with the reads and writes recorded. */
function sheetWith(client, feedbackDurationMs = 2000) {
  const {DeviceModelDefaultsSheetState} = sheetStateModule();
  const sheet = new DeviceModelDefaultsSheetState(feedbackDurationMs);
  sheet.bind(client);
  return sheet;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test('the picker offers enabled, capable models in the catalog own order', () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();
  const models = [
    {id: 'm-first', enabled: true, capabilities: ['text_chat']},
    {id: 'm-disabled', enabled: false, capabilities: ['text_chat', 'image_understanding']},
    {id: 'm-both', enabled: true, capabilities: ['text_chat', 'image_understanding']},
    {id: 'm-vision', enabled: true, capabilities: ['image_understanding']},
    {id: 'm-plain', enabled: true, capabilities: []},
    {id: 'm-uncapable', enabled: true}
  ];
  const catalog = catalogOf(models);

  // A disabled model is not a candidate at all, and neither is one without the
  // capability the role needs: the desktop would refuse both writes.
  assert.deepEqual(ids(policy.textChatCandidates(catalog)), ['m-first', 'm-both']);
  assert.deepEqual(ids(policy.imageUnderstandingCandidates(catalog)), ['m-both', 'm-vision']);
  // Order is the desktop's, not a local sort: this list and the desktop's own
  // model list have to describe the same device.
  assert.deepEqual(ids(policy.textChatCandidates(catalog)), ids(models.filter(model =>
    model.enabled && (model.capabilities || []).indexOf('text_chat') >= 0)));

  assert.deepEqual(ids(policy.candidatesForRole('primary', catalog)), ['m-first', 'm-both']);
  assert.deepEqual(ids(policy.candidatesForRole('fast', catalog)), ['m-first', 'm-both']);
  assert.deepEqual(ids(policy.candidatesForRole('image_understanding', catalog)), ['m-both', 'm-vision']);

  assert.deepEqual(policy.textChatCandidates(emptyCatalog()), []);
  assert.deepEqual(policy.imageUnderstandingCandidates(emptyCatalog()), []);
  assert.equal(policy.isEmptyCatalog(emptyCatalog()), true);
  assert.equal(policy.isEmptyCatalog(catalog), false);
});

test('the pinned row is the role own "no model" value, and only the primary has none', () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();

  // The primary model is required: a phone that cleared it would leave the
  // desktop with nothing to run.
  assert.equal(policy.allowsUnset('primary'), false);
  assert.equal(policy.allowsUnset('fast'), true);
  assert.equal(policy.allowsUnset('image_understanding'), true);

  assert.equal(policy.unsetLabelKey('fast'), 'chat.modelFollowPrimary');
  assert.equal(policy.unsetLabelKey('image_understanding'), 'settings.modelService.notConfigured');
  assert.equal(policy.unsetHintKey('fast'), 'chat.modelFastNotConfigured');
  assert.equal(policy.unsetHintKey('image_understanding'), 'settings.model.imageUnderstandingUnset');
  assert.equal(policy.unsetHintKey('primary'), '');

  const roles = {primary: 'm-primary', fast: null, image_understanding: 'm-vision'};
  assert.equal(policy.isUnsetSelected(roles, 'fast'), true);
  assert.equal(policy.isUnsetSelected(roles, 'image_understanding'), false);
  // The primary can never be "unset", so its picker has no such row to check.
  assert.equal(policy.isUnsetSelected(roles, 'primary'), false);
  assert.equal(policy.isCandidateSelected(roles, 'image_understanding', 'm-vision'), true);
  assert.equal(policy.isCandidateSelected(roles, 'image_understanding', 'm-both'), false);
  assert.equal(policy.isCandidateSelected(roles, 'fast', 'm-primary'), false);

  // The capability badge explains one list only; elsewhere it would widen rows.
  assert.equal(policy.showsCapabilityBadge('image_understanding'), true);
  assert.equal(policy.showsCapabilityBadge('fast'), false);
  assert.equal(policy.showsCapabilityBadge('primary'), false);
  assert.equal(policy.roleLabelKey('image_understanding'), 'chat.modelImage');
  assert.equal(policy.filterKey('image_understanding'), 'settings.model.filterImageUnderstanding');
  assert.equal(policy.filterKey('fast'), 'settings.model.filterTextChat');
  assert.equal(policy.filterKey('primary'), 'settings.model.filterTextChat');
});

// ---------------------------------------------------------------------------
// Role rows
// ---------------------------------------------------------------------------

test('a role row states the value the device returned and the fallback it uses', () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();
  const roles = {primary: 'm-primary', fast: null, image_understanding: null};
  const fixture = catalog({primary: 'm-primary', fast: null, image_understanding: null});

  const primary = policy.roleRow(roles, 'primary', fixture);
  assert.equal(primary.modelId, 'm-primary');
  assert.equal(primary.model.id, 'm-primary');
  assert.equal(primary.unset, false);
  assert.equal(primary.unsetKey, '');
  assert.equal(primary.resolved, true);

  // An empty fast slot follows the primary, and says so in those words.
  const fast = policy.roleRow(roles, 'fast', fixture);
  assert.equal(fast.unset, true);
  assert.equal(fast.unsetKey, 'chat.modelFollowPrimary');
  assert.equal(fast.hintKey, 'chat.modelFastNotConfigured');
  assert.equal(fast.resolved, true);

  // The multimodal slot has no fallback: an empty one means the capability is
  // off, not borrowed from another role.
  const image = policy.roleRow(roles, 'image_understanding', fixture);
  assert.equal(image.unsetKey, 'settings.modelService.notConfigured');
  assert.equal(image.hintKey, 'settings.model.imageUnderstandingUnset');
  assert.equal(image.resolved, false);
  assert.equal(policy.resolvedModel(roles, 'image_understanding', fixture), undefined);

  // A value the catalog no longer lists keeps its id: the desktop holds it, and
  // hiding it behind "not configured" would misreport the device.
  const orphan = policy.roleRow({primary: 'm-gone'}, 'primary', fixture);
  assert.equal(orphan.modelId, 'm-gone');
  assert.equal(orphan.model, undefined);
  assert.equal(orphan.unset, false);
  assert.equal(orphan.resolved, false);

  // A disabled model is not a resolved one either.
  const disabled = catalogOf([{id: 'm-off', enabled: false, capabilities: ['text_chat']}]);
  assert.equal(policy.roleRow({primary: 'm-off'}, 'primary', disabled).resolved, false);

  // With no models at all every row says unconfigured and none promises a
  // fallback, because there is no primary to follow.
  for (const role of ['primary', 'fast', 'image_understanding']) {
    const empty = policy.roleRow(roles, role, emptyCatalog());
    assert.equal(empty.unset, true, role);
    assert.equal(empty.unsetKey, 'settings.modelService.notConfigured', role);
    assert.equal(empty.hintKey, '', role);
    assert.equal(empty.resolved, false, role);
  }
});

// ---------------------------------------------------------------------------
// Page state: gating, the write, the read-back, the feedback
// ---------------------------------------------------------------------------

test('the gate is armed when the sheet opens and spent when a page opens', async () => {
  let reads = 0;
  const sheet = sheetWith({
    getModelCatalog: async () => { reads += 1; return catalog({primary: 'm-primary'}); },
    setModelDefaults: async () => { throw new Error('write is not expected here'); }
  });

  assert.equal(sheet.setGate(gate(true, true, 'desk-1')), true);
  // Arming is not reading: a sheet opened for another setting asks nothing.
  assert.equal(reads, 0);
  assert.equal(sheet.state.available, true);
  assert.equal(sheet.state.loaded, false);

  await sheet.ensureLoaded();
  await sheet.ensureLoaded();
  assert.equal(reads, 1);
  assert.equal(sheet.state.loaded, true);
  assert.equal(sheet.state.roles.primary, 'm-primary');

  // The same gate is not a reset, so what is on screen survives a rebuild.
  assert.equal(sheet.setGate(gate(true, true, 'desk-1')), false);
  await sheet.ensureLoaded();
  assert.equal(reads, 1);

  // Another desktop is a different answer, so the page drops what it had.
  assert.equal(sheet.setGate(gate(true, true, 'desk-2')), true);
  assert.equal(sheet.state.loaded, false);
  assert.equal(sheet.state.available, true);
});

test('an older desktop and a dropped link are stated, not read', async () => {
  let reads = 0;
  const sheet = sheetWith({
    getModelCatalog: async () => { reads += 1; return catalog(); },
    setModelDefaults: async () => { throw new Error('write is not expected here'); }
  });

  assert.equal(sheet.setGate(gate(false, true, 'desk-1')), true);
  await sheet.ensureLoaded();
  await sheet.selectRole('primary', 'm-primary');
  assert.equal(reads, 0);
  assert.equal(sheet.state.available, false);
  assert.equal(sheet.state.error, 'settings.model.unsupported');
  // Nothing was written and nothing claims it was.
  assert.equal(sheet.feedbackVisible, false);

  assert.equal(sheet.setGate(gate(true, false, 'desk-1')), true);
  assert.equal(sheet.state.available, false);
  assert.equal(sheet.state.error, 'status.remoteUnavailable');
});

test('a write locks the pages, sends every slot, and reports the read-back', async () => {
  const write = deferred();
  const writes = [];
  let stored = {primary: 'm-primary', fast: null, image_understanding: null};
  const sheet = sheetWith({
    getModelCatalog: async () => catalog(stored),
    setModelDefaults: async (primary, fast, image) => {
      writes.push([primary, fast, image]);
      stored = {primary, fast, image_understanding: image};
      return write.promise;
    }
  }, 5);
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  const pending = sheet.selectRole('fast', 'm-vision');
  assert.equal(sheet.state.busy, true);
  assert.equal(sheet.feedbackVisible, false);
  await wait(0);
  assert.deepEqual(writes, [['m-primary', 'm-vision', null]]);
  assert.equal(sheet.pendingRole, 'fast');
  assert.equal(sheet.pendingModelId, 'm-vision');

  // A second tap while the first write is out cannot overwrite the intent the
  // retry and the result line are read from.
  await sheet.selectRole('fast', 'm-primary');
  assert.equal(writes.length, 1);
  assert.equal(sheet.pendingModelId, 'm-vision');

  write.resolve({});
  await pending;
  assert.equal(sheet.state.busy, false);
  assert.equal(sheet.state.roles.fast, 'm-vision');
  assert.equal(sheet.feedbackVisible, true);
  await wait(40);
  assert.equal(sheet.feedbackVisible, false);
});

test('selecting the value a role already holds writes nothing and says nothing', async () => {
  let writes = 0;
  const sheet = sheetWith({
    getModelCatalog: async () => catalog({primary: 'm-primary', fast: 'm-vision'}),
    setModelDefaults: async () => { writes += 1; return {}; }
  }, 5);
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  await sheet.selectRole('primary', 'm-primary');
  await sheet.selectRole('fast', 'm-vision');
  assert.equal(writes, 0);
  assert.equal(sheet.feedbackVisible, false);
  assert.equal(sheet.state.busy, false);
});

test('a rejected write keeps the host error verbatim and retries the same write', async () => {
  const writes = [];
  const sheet = sheetWith({
    getModelCatalog: async () => catalog({primary: 'm-primary'}),
    setModelDefaults: async (primary, fast, image) => {
      writes.push([primary, fast, image]);
      if (writes.length === 1) {
        throw new Error('Unknown model id: m-missing');
      }
      return {};
    }
  }, 5);
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  await sheet.selectRole('primary', 'm-missing');
  assert.equal(sheet.state.error, 'Unknown model id: m-missing');
  assert.equal(sheet.state.failure, 'write');
  assert.equal(sheet.feedbackVisible, false);
  // The value never moved: the write was refused, so the device still holds it.
  assert.equal(sheet.state.roles.primary, 'm-primary');
  assert.deepEqual(writes, [['m-missing', null, null]]);

  await sheet.retry();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], ['m-missing', null, null]);
  assert.equal(sheet.state.error, '');
  assert.equal(sheet.feedbackVisible, true);
});

test('a read that fails after an accepted write is retried as a read', async () => {
  let reads = 0;
  const sheet = sheetWith({
    getModelCatalog: async () => {
      reads += 1;
      if (reads === 3) {
        throw new Error('Remote transport is not connected.');
      }
      return catalog({primary: reads <= 2 ? 'm-primary' : 'm-vision'});
    },
    setModelDefaults: async () => ({})
  }, 5);
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  await sheet.selectRole('primary', 'm-vision');
  assert.equal(sheet.state.failure, 'load');
  assert.equal(sheet.state.error, 'Remote transport is not connected.');
  assert.equal(sheet.feedbackVisible, false);
  assert.equal(sheet.state.roles.primary, 'm-primary');

  await sheet.retry();
  assert.equal(reads, 4);
  assert.equal(sheet.state.error, '');
  assert.equal(sheet.state.roles.primary, 'm-vision');
  // A re-read confirms nothing new was written, so it does not claim an update.
  assert.equal(sheet.feedbackVisible, false);
});

test('a write that lands after the sheet closed is dropped', async () => {
  const write = deferred();
  const sheet = sheetWith({
    getModelCatalog: async () => catalog({primary: 'm-primary'}),
    setModelDefaults: async () => write.promise
  }, 5);
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  const pending = sheet.selectRole('primary', 'm-vision');
  sheet.reset();
  write.resolve({primary: 'm-vision'});
  await pending;
  assert.equal(sheet.state.available, false);
  assert.equal(sheet.state.busy, false);
  assert.equal(sheet.feedbackVisible, false);
  assert.deepEqual(sheet.state.roles, {primary: null, fast: null, image_understanding: null});
});

test('the page starts from the controller own unavailable snapshot', () => {
  const {DeviceModelDefaultsSheetState, emptyModelDefaultsState} = sheetStateModule();
  const {RemoteModelDefaultsController} = controllerModule();
  const controller = new RemoteModelDefaultsController({
    getModelCatalog: async () => emptyCatalog(),
    setModelDefaults: async () => ({})
  }, {onStateChanged: () => {}});
  // The copy the state object carries as its initial value has to stay the shape
  // the controller publishes, or a page mounted before `bind` renders nonsense.
  assert.deepEqual(emptyModelDefaultsState(), controller.getState());
  assert.deepEqual(new DeviceModelDefaultsSheetState().state, controller.getState());
  assert.equal(DeviceModelDefaultsSheetState.name, 'DeviceModelDefaultsSheetState');
});

// ---------------------------------------------------------------------------
// The picker over a device that stopped answering
// ---------------------------------------------------------------------------

test('a gate that drops while the picker is open states the reason, not a choice', async () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();
  const sheet = sheetWith({
    getModelCatalog: async () => catalog({primary: 'm-primary'}),
    setModelDefaults: async () => ({})
  });
  assert.equal(sheet.setGate(gate(true, true, 'desk-1')), true);
  await sheet.ensureLoaded();

  // The frame the picker draws for a device that is answering: the list is the
  // device's, and the mark on the pinned row is the value it reported.
  assert.deepEqual(policy.pickerView(sheet.state), {
    reason: false, retry: false, reading: false, list: true, answered: true
  });
  assert.equal(policy.isUnsetSelected(sheet.state.roles, 'fast'), true);

  // The link drops while the picker is up. The snapshot keeps the roles it was
  // read with, so the raw predicate still calls the empty slot a choice — which
  // is exactly the sentence the page must not draw from it.
  assert.equal(sheet.setGate(gate(true, false, 'desk-1')), true);
  assert.equal(sheet.state.error, 'status.remoteUnavailable');
  assert.equal(policy.isUnsetSelected(sheet.state.roles, 'fast'), true);
  const dropped = policy.pickerView(sheet.state);
  assert.equal(dropped.reason, true, 'the page states the reason instead of a list');
  assert.equal(dropped.answered, false, 'a snapshot the gate replaced answers nothing');
  assert.equal(dropped.list, false, 'a device that cannot answer has no list to offer');
  // Reconnecting is the sheet's own business: it re-arms the gate when the link
  // returns, so there is nothing here for a retry to repeat.
  assert.equal(dropped.retry, false);
  assert.equal(policy.canRepeatRead(sheet.state), false);

  // An older desktop is the same page, with the reason it has.
  assert.equal(sheet.setGate(gate(false, true, 'desk-1')), true);
  assert.equal(sheet.state.error, 'settings.model.unsupported');
  assert.equal(policy.pickerView(sheet.state).reason, true);
  assert.equal(policy.pickerView(sheet.state).retry, false);
});

test('a read that fails while the picker is open keeps the rows but not their marks', async () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();
  let reads = 0;
  const sheet = sheetWith({
    getModelCatalog: async () => {
      reads += 1;
      if (reads === 2) {
        throw new Error('The desktop stopped answering the model catalog.');
      }
      return catalog({primary: 'm-primary'});
    },
    setModelDefaults: async () => ({})
  });
  sheet.setGate(gate(true, true, 'desk-1'));
  await sheet.ensureLoaded();

  // Another desktop is a different answer, so the page reads again — and this
  // read is the one that fails.
  assert.equal(sheet.setGate(gate(true, true, 'desk-2')), true);
  await sheet.load();
  assert.equal(sheet.state.failure, 'load');
  assert.equal(sheet.state.error, 'The desktop stopped answering the model catalog.');

  const view = policy.pickerView(sheet.state);
  assert.equal(view.reason, true, 'the host\'s own words are what the page states');
  assert.equal(view.retry, true, 'repeating the read is the way out of a failed read');
  assert.equal(view.list, true, 'the device can still answer, so its rows stay');
  assert.equal(view.answered, false, 'but the last read is not this desktop\'s answer');
  assert.equal(view.reading, false);

  // The retry repeats that read and nothing else.
  assert.equal(reads, 2);
  await sheet.retry();
  assert.equal(reads, 3);
  assert.equal(sheet.state.error, '');
  assert.deepEqual(policy.pickerView(sheet.state), {
    reason: false, retry: false, reading: false, list: true, answered: true
  });
});

test('a picker opened before the first read says so instead of blaming the catalog', () => {
  const {ModelRoleCandidatesPolicy: policy} = policyModule();
  const sheet = sheetWith({
    getModelCatalog: async () => catalog(),
    setModelDefaults: async () => ({})
  });
  // Armed, and not read: a sheet restored straight onto the picker is here.
  assert.equal(sheet.setGate(gate(true, true, 'desk-1')), true);
  const view = policy.pickerView(sheet.state);
  assert.equal(view.reading, true);
  assert.equal(view.list, false);
  assert.equal(view.answered, false, 'a list nobody has read yet is not an empty catalog');
  assert.equal(view.reason, false);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test('the sheet stacks main into the model pages and closes back to the top', () => {
  const {SettingsSheetState} = settingsSheetStateModule();
  const state = new SettingsSheetState();

  assert.equal(state.page, 'main');
  assert.equal(state.pickRole, '');
  state.setPage('deviceModels');
  assert.equal(state.page, 'deviceModels');

  state.openModelPick('fast');
  assert.equal(state.page, 'modelPick');
  assert.equal(state.pickRole, 'fast');

  // Back returns exactly one level, to the page that pushed the picker.
  state.backFromModelPick();
  assert.equal(state.page, 'deviceModels');
  assert.equal(state.pickRole, '');

  // Any other route out of the picker disarms the role, so a page rebuilt from
  // the wrong level cannot edit someone else's slot.
  state.openModelPick('image_understanding');
  state.setPage('main');
  assert.equal(state.pickRole, '');
  state.openModelPick('image_understanding');
  state.setPage('deviceModels');
  assert.equal(state.pickRole, '');

  state.openModelPick('primary');
  state.resetOnClose();
  assert.equal(state.page, 'main');
  assert.equal(state.pickRole, '');
  assert.equal(state.deviceModels.state.available, false);
  assert.equal(state.deviceModels.state.loaded, false);
});

// ---------------------------------------------------------------------------
// Wiring the app has to keep
// ---------------------------------------------------------------------------

test('the sheet routes both model pages and keeps no placeholder', () => {
  const settingsSheet = source('entry/src/main/ets/pages/components/SettingsSheet.ets');

  assert.equal(settingsSheet.includes('DeviceModelsPlaceholder'), false,
    'the placeholder page has to be gone once the real pages exist');
  assert.equal(settingsSheet.includes('deviceModelsPlaceholderText'), false,
    'the placeholder copy has to be gone with it');
  assert.match(settingsSheet, /page === 'deviceModels'/, 'the settings page must stay a page of the sheet');
  assert.match(settingsSheet, /page === 'modelPick'/, 'the picker must be a page of the same sheet');
  assert.match(settingsSheet, /this\.sheetState\.deviceModels\.bind\(/, 'the sheet owns the request path of the pages');
  assert.match(settingsSheet, /@Monitor\('connectionState', 'supportsDeviceModelDefaults', 'controlTargetDeviceId'\)/,
    'the gate has to follow the desktop, the link and its capability set');
});

test('neither model page offers a manual refresh', () => {
  const pages = [
    'entry/src/main/ets/pages/components/DeviceModelDefaultsPanel.ets',
    'entry/src/main/ets/pages/components/ModelRolePickerPanel.ets'
  ];
  for (const page of pages) {
    const text = source(page);
    assert.equal(text.includes("'common.refresh'"), false,
      `${page} must not grow a manual refresh: opening the page is the read`);
    // The write lock is what keeps a second write and an early exit out.
    assert.match(text, /state\.busy|locked\(\)/, `${page} must answer the write lock`);
  }
});

test('both model pages state a device that cannot answer', () => {
  const picker = source('entry/src/main/ets/pages/components/ModelRolePickerPanel.ets');

  // The card, the marks and the sentence about an empty list all come from one
  // view of one state, so a dropped link cannot leave a marked row or an empty
  // list being blamed on the catalog behind.
  assert.match(picker, /if \(this\.view\(\)\.reason\) \{/, 'the reason has to replace the list');
  assert.match(picker, /if \(this\.view\(\)\.reading\) \{/, 'and an unread page has to say so');
  assert.match(picker, /if \(this\.view\(\)\.list\) \{/, 'the list is drawn only while it is an answer');
  assert.match(picker, /this\.view\(\)\.answered && this\.candidates\(\)\.length === 0/,
    'an empty list is only explained away when the device is the one saying it');
  assert.match(picker, /view\(\)\.answered &&/, 'the marks have to come from the view');
  assert.match(picker, /ModelUnavailableCard\(\{/, 'the picker states the reason in the shared card');
  assert.match(picker, /deviceModels\.retry\(\)/, 'and offers the retry the state allows');

  // The settings page reaches the same card, so the two pages cannot describe the
  // same desktop differently.
  const settings = source('entry/src/main/ets/pages/components/DeviceModelDefaultsPanel.ets');
  assert.match(settings, /ModelUnavailableCard\(\{/, 'the settings page shares the card');
  assert.match(settings, /canRepeatRead\(this\.deviceModelState\(\)\)/,
    'and decides the retry from the same rule as the picker');
});

test('the connected desktop offers the model settings entry the previews shoot', () => {
  const normalize = text => text.replace(/\s+/g, ' ');
  const immersive = source('entry/src/main/ets/pages/preview/ImmersiveBottomPreview.ets');
  const surfaces = source('entry/src/main/ets/pages/components/AppRootOverlaySurfaces.ets');
  const profile = source('entry/src/main/ets/pages/components/AccountProfilePanel.ets');
  const pageState = source('entry/src/main/ets/pages/state/RemotePageState.ets');
  const models = source('entry/src/main/ets/model/RemoteModels.ets');

  // The chain behind the pill, end to end: the capability the desktop advertised
  // is what the sheet is told, and what the row draws.
  assert.match(pageState, /setHostCapabilities\(capabilities: string\[\]\): void \{/,
    'the host capability set is state the page carries');
  assert.match(pageState, /supportsHostCapability\(capability: string\): boolean \{/,
    'and the app asks it by capability');
  assert.match(normalize(surfaces),
    /supportsDeviceModelDefaults: this\.remotePageState\.supportsHostCapability\( REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1\)/,
    'AppSettingsSurface has to hand the sheet the desktop\'s own capability');
  assert.match(normalize(immersive), /setHostCapabilities\(\[REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1\]\)/,
    'the settings fixture has to advertise it, or every shot of the entry is the greyed one');
  // A literal here would advertise a capability the app does not look for, so both
  // ends name the constant the wire value is declared once.
  assert.match(models, /REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1: string = 'device_model_defaults_v1'/);
  assert.equal(/['"]device_model_defaults_v1['"]/.test(immersive), false,
    'the fixture has to name the constant, not its value');
  assert.equal(/['"]device_model_defaults_v1['"]/.test(surfaces), false);

  // The pill's enabled branch, distinct from the greyed one with its badge.
  assert.match(profile, /entryEnabled\(this\.supportsDeviceModelDefaults\)/);
  assert.match(profile, /\.opacity\(this\.deviceModelSettingsEnabled\(\) \? 1 : 0\.38\)/);
  assert.match(profile, /if \(!this\.deviceModelSettingsEnabled\(\)\) \{/);
  assert.match(profile, /settings\.model\.upgradeBadge/);
  assert.match(profile, /\.id\(`device-model-entry-\$\{this\.deviceModelSettingsEnabled\(\) \? 'enabled' : 'degraded'\}`\)/,
    'the pill has to say which of its two states it is in');
});

test('every key the two pages render exists in both catalogs', () => {
  const catalogs = locale => new Set(JSON.parse(
    source(`entry/src/main/resources/${locale}/element/string.json`)
  ).string.map(entry => entry.name));
  const english = catalogs('en_US');
  const chinese = catalogs('zh_CN');
  const keys = [
    'settings.model.settingsTitle',
    'settings.model.section',
    'settings.model.emptyTitle',
    'settings.model.emptyText',
    'settings.model.imageUnderstandingUnset',
    'settings.model.pickEmpty',
    'settings.model.capabilityImageUnderstanding',
    'settings.model.scopeNewSessions',
    'settings.model.scopeFastFollowsPrimary',
    'settings.model.scopeImageUnderstanding',
    'settings.modelService.notConfigured',
    'settings.modelService.accountSource',
    'settings.modelService.localSource',
    'chat.model',
    'chat.modelPrimary',
    'chat.modelFast',
    'chat.modelImage',
    'chat.modelFollowPrimary',
    'chat.modelFastNotConfigured',
    'connect.connected',
    'connect.disconnected',
    'common.retry',
    'status.loadingModelDefaults',
    'status.modelDefaultsUpdated',
    'status.remoteUnavailable'
  ];
  // The three templated sentences are used with `RemoteI18n.f`, so they have to
  // keep their placeholder in both locales.
  const templated = [
    'settings.model.filterTextChat',
    'settings.model.filterImageUnderstanding',
    'settings.model.updatedResult'
  ];
  for (const key of keys.concat(templated)) {
    const name = key.replace(/\./g, '_');
    assert.ok(english.has(name), `${key} is missing from en_US (${name})`);
    assert.ok(chinese.has(name), `${key} is missing from zh_CN (${name})`);
  }
  const value = (locale, key) => JSON.parse(
    source(`entry/src/main/resources/${locale}/element/string.json`)
  ).string.find(entry => entry.name === key.replace(/\./g, '_')).value;
  for (const key of templated) {
    assert.ok(value('en_US', key).includes('%1$s'), `${key} must keep its placeholder in en_US`);
    assert.ok(value('zh_CN', key).includes('%1$s'), `${key} must keep its placeholder in zh_CN`);
  }
});

test('the device-model scenarios are one family the launcher can open', () => {
  const entryAbility = source('entry/src/main/ets/entryability/EntryAbility.ets');
  const gallery = source('entry/src/main/ets/pages/preview/MobileDesignGallery.ets');
  const preview = source('entry/src/main/ets/pages/preview/DeviceModelDefaultsPreview.ets');

  assert.match(entryAbility, /String\(scenarioId \|\| ''\)\.startsWith\('device-model'\)/,
    'the launcher has to recognize the whole device-model family');
  assert.match(entryAbility, /deviceModelScenario && String\(scenarioId\)\.endsWith\('-dark'\)/,
    'the dark variants have to lock the dark colour mode');
  assert.match(gallery, /startsWith\('device-model'\)/,
    'the gallery has to route the family to the preview');
  for (const scenario of [
    'device-model-pick-fast', 'device-model-pick-multimodal', 'device-model-pick-primary',
    'device-model-pick-failed', 'device-model-degraded-pick',
    'device-model-writing', 'device-model-updated', 'device-model-degraded', 'device-model-empty'
  ]) {
    assert.ok(preview.includes(`'${scenario}'`), `${scenario} has to be a state the fixture can mount`);
  }
  // The two picker states with no list: a desktop that cannot answer the page and
  // one that stopped answering it are different reasons, so they are different
  // boards rather than one flag.
  assert.match(preview, /this\.client\.failReads = scenario === 'device-model-pick-failed'/,
    'a failed read has to be a state the fixture can be put in');
  assert.match(preview, /scenario === 'device-model-degraded' \|\| scenario === 'device-model-degraded-pick'/,
    'the older desktop has to cover its picker too');
  // `device-models` is the settings page itself: the state every other scenario
  // changes one thing away from, so it is the fixture's own default.
  assert.match(preview, /scenario === 'device-model-empty' \? \[\] : previewModels\(\)/,
    'the settings page over a full catalog has to be the default state');
  // The preview mounts the production sheet rather than a picture of it.
  assert.match(preview, /AppShell\(\{/, 'the fixture must mount the production shell');
  assert.match(preview, /AppSettingsSurface\(\{/, 'and the production settings surface');
});
