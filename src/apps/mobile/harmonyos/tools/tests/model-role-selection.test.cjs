const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(relativePath, resolve) {
  const source = fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
  }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(name => (resolve ? resolve(name) : undefined) || {}, exported);
  return exported;
}

const policy = load('entry/src/main/ets/pages/policy/ConversationModelPresentationPolicy.ets');
const {ConversationModelPresentationPolicy: Policy} = policy;
const ui = load('entry/src/main/ets/services/RemoteUiState.ets', name => name.endsWith('RemoteI18n') ?
  {RemoteI18n: {t: key => key, f: (key, value) => `${key}:${value}`}} :
  name.endsWith('RemoteSessionIdentity') ? {remoteSessionIdentity: () => ''} : {TranscriptIntegrityPolicy: {}});
const {RemoteUiState} = ui;

function model(id, options = {}) {
  return {
    id,
    name: options.name || id,
    provider: options.provider || 'openai',
    base_url: '',
    model_name: options.model_name || id,
    context_window: options.context_window,
    enabled: options.enabled !== false,
    capabilities: []
  };
}

const primary = model('anthropic/claude-sonnet-4', {
  name: 'Anthropic', provider: 'anthropic', model_name: 'anthropic/claude-sonnet-4', context_window: 200000
});
const fast = model('openbitfun:gpt-5-mini', {name: 'Fast', provider: 'openai', model_name: 'openbitfun:gpt-5-mini'});
const other = model('local:llama', {name: 'Llama', provider: 'local'});
const disabled = model('disabled-model', {name: 'Disabled', provider: 'test', enabled: false});

function catalog(defaults = {}, extra = {}) {
  return {
    version: 1,
    models: [primary, fast, other, disabled],
    default_models: defaults,
    ...extra
  };
}

test('resolves role selectors to enabled concrete models', () => {
  const both = catalog({primary: primary.id, fast: fast.id});
  assert.equal(Policy.resolveModel(both, 'primary').id, primary.id);
  assert.equal(Policy.resolveModel(both, 'fast').id, fast.id);
  assert.equal(Policy.resolveModel(both, primary.id).id, primary.id);
  assert.equal(Policy.resolveModel(both, '  primary  ').id, primary.id);
});

test('fast falls back to primary exactly like the host', () => {
  const primaryOnly = catalog({primary: primary.id});
  assert.equal(Policy.resolveModel(primaryOnly, 'fast').id, primary.id);
  const disabledFast = catalog({primary: primary.id, fast: disabled.id});
  assert.equal(Policy.resolveModel(disabledFast, 'fast').id, primary.id);
  const unknownFast = catalog({primary: primary.id, fast: 'missing-model'});
  assert.equal(Policy.resolveModel(unknownFast, 'fast').id, primary.id);
});

test('role selectors never resolve disabled, unknown, auto or default selectors', () => {
  const both = catalog({primary: primary.id, fast: fast.id});
  assert.equal(Policy.resolveModel(both, disabled.id), undefined);
  assert.equal(Policy.resolveModel(both, 'missing-model'), undefined);
  assert.equal(Policy.resolveModel(both, 'auto'), undefined);
  assert.equal(Policy.resolveModel(both, 'default'), undefined);
  assert.equal(Policy.resolveModel(both, ''), undefined);
  assert.equal(Policy.resolveModel(catalog({primary: disabled.id}), 'primary'), undefined);
});

test('maps a concrete model id to the roles it serves', () => {
  assert.deepEqual(Policy.modelRoles(catalog({primary: primary.id, fast: fast.id}), primary.id), ['primary']);
  assert.deepEqual(Policy.modelRoles(catalog({primary: primary.id, fast: fast.id}), fast.id), ['fast']);
  assert.deepEqual(Policy.modelRoles(catalog({primary: fast.id, fast: fast.id}), fast.id), ['primary', 'fast']);
  assert.deepEqual(Policy.modelRoles(catalog({primary: primary.id, fast: fast.id}), other.id), []);
  assert.deepEqual(Policy.modelRoles(catalog({primary: primary.id}), ''), []);
  assert.deepEqual(Policy.modelRoles(catalog({}), primary.id), []);
});

test('selectedModel resolves a semantic session_model_id instead of the primary fallback', () => {
  assert.equal(Policy.selectedModel(catalog({primary: primary.id, fast: fast.id}, {session_model_id: 'fast'})).id, fast.id);
  assert.equal(Policy.selectedModel(catalog({primary: primary.id, fast: fast.id}, {session_model_id: 'primary'})).id, primary.id);
  assert.equal(Policy.selectedModel(catalog({primary: primary.id}, {session_model_id: 'fast'})).id, primary.id);
});

test('selectedModel keeps its precedence for concrete and empty selections', () => {
  const both = catalog({primary: primary.id, fast: fast.id});
  assert.equal(Policy.selectedModel(both, other.id).id, other.id);
  assert.equal(Policy.selectedModel({...both, session_model_id: fast.id}, '').id, fast.id);
  assert.equal(Policy.selectedModel(both, '').id, primary.id);
  assert.equal(Policy.selectedModel({...both, session_model_id: fast.id}, disabled.id).id, fast.id);
  assert.equal(Policy.selectedModel({...both, session_model_id: 'fast'}, 'primary').id, primary.id);
});

test('role selection is normalized and never inferred from auto, default or concrete ids', () => {
  assert.equal(Policy.selectedRole('primary'), 'primary');
  assert.equal(Policy.selectedRole(' fast '), 'fast');
  assert.equal(Policy.selectedRole('auto'), '');
  assert.equal(Policy.selectedRole('default'), '');
  assert.equal(Policy.selectedRole(''), '');
  assert.equal(Policy.selectedRole(primary.id), '');
  assert.equal(Policy.isSemanticModelId('primary'), true);
  assert.equal(Policy.isSemanticModelId(primary.id), false);
});

test('trigger label key follows a semantic selection that still resolves', () => {
  const both = catalog({primary: primary.id, fast: fast.id});
  assert.equal(Policy.selectedModelLabelKey(both, 'primary'), 'chat.modelPrimary');
  assert.equal(Policy.selectedModelLabelKey(both, 'fast'), 'chat.modelFast');
  assert.equal(Policy.selectedModelLabelKey(both, ' fast '), 'chat.modelFast');
  assert.equal(Policy.selectedModelLabelKey(catalog({fast: fast.id}), 'fast'), 'chat.modelFast');
  assert.equal(Policy.selectedModelLabelKey(catalog({primary: primary.id}), 'fast'), 'chat.modelFast');
  assert.equal(Policy.selectedModelLabelKey(both, 'auto'), '');
  assert.equal(Policy.selectedModelLabelKey(both, ''), '');
  assert.equal(Policy.selectedModelLabelKey(both, fast.id), '');
  assert.equal(Policy.roleLabelKey('primary'), 'chat.modelPrimary');
  assert.equal(Policy.roleLabelKey('fast'), 'chat.modelFast');
  assert.equal(Policy.roleLabelKey(other.id), '');
});

test('an unresolvable role is presented as no role selection at all', () => {
  const neither = catalog({});
  assert.equal(Policy.selectedModelLabelKey(neither, 'primary'), '');
  assert.equal(Policy.selectedModelLabelKey(neither, 'fast'), '');
  assert.equal(Policy.resolvedSelectedRole(neither, 'primary'), '');
  assert.equal(Policy.resolvedSelectedRole(neither, 'fast'), '');
  assert.deepEqual(Policy.roleEntries(neither), []);
  assert.equal(Policy.selectedModel(neither, 'fast'), undefined);

  const disabledDefaults = catalog({primary: disabled.id, fast: disabled.id});
  assert.equal(Policy.selectedModelLabelKey(disabledDefaults, 'fast'), '');
  assert.equal(Policy.resolvedSelectedRole(disabledDefaults, 'primary'), '');
  assert.equal(Policy.selectedModelLabelKey(disabledDefaults, primary.id), '');

  const primaryOnly = catalog({primary: primary.id});
  assert.equal(Policy.resolvedSelectedRole(primaryOnly, 'primary'), 'primary');
  assert.equal(Policy.resolvedSelectedRole(primaryOnly, 'fast'), 'fast');
  assert.equal(Policy.resolvedSelectedRole(primaryOnly, ''), '');
  assert.equal(Policy.resolvedSelectedRole(primaryOnly, primary.id), '');
  assert.equal(Policy.resolvedSelectedRole(primaryOnly, 'auto'), '');

  const fastOnly = catalog({fast: fast.id});
  assert.equal(Policy.resolvedSelectedRole(fastOnly, 'fast'), 'fast');
  assert.equal(Policy.selectedModelLabelKey(fastOnly, 'primary'), '');
});

test('a concrete row is checked only for its own concrete selection', () => {
  assert.equal(Policy.isConcreteModelSelected(fast.id, fast.id), true);
  assert.equal(Policy.isConcreteModelSelected(fast.id, primary.id), false);
  assert.equal(Policy.isConcreteModelSelected('primary', primary.id), false);
  assert.equal(Policy.isConcreteModelSelected('fast', fast.id), false);
  assert.equal(Policy.isConcreteModelSelected('auto', primary.id), false);
  assert.equal(Policy.isConcreteModelSelected('', primary.id), false);
});

test('defaults section lists both roles and describes the fast fallback', () => {
  const both = Policy.roleEntries(catalog({primary: primary.id, fast: fast.id}));
  assert.equal(both.length, 2);
  assert.deepEqual(both.map(entry => entry.role), ['primary', 'fast']);
  assert.deepEqual(both.map(entry => entry.labelKey), ['chat.modelPrimary', 'chat.modelFast']);
  assert.equal(both[0].model.id, primary.id);
  assert.equal(both[1].model.id, fast.id);
  assert.equal(both[0].fallsBackToPrimary, false);
  assert.equal(both[1].fallsBackToPrimary, false);
  assert.equal(Policy.roleMetaNoticeKey(both[1]), '');

  const primaryOnly = Policy.roleEntries(catalog({primary: primary.id}));
  assert.equal(primaryOnly[1].model.id, primary.id);
  assert.equal(primaryOnly[1].fallsBackToPrimary, true);
  assert.equal(Policy.roleMetaNoticeKey(primaryOnly[1]), 'chat.modelFastNotConfigured');

  const fastOnly = Policy.roleEntries(catalog({fast: fast.id}));
  assert.equal(fastOnly[0].model, undefined);
  assert.equal(fastOnly[1].model.id, fast.id);
  assert.equal(fastOnly[1].fallsBackToPrimary, false);

  assert.deepEqual(Policy.roleEntries(catalog({})), []);
  assert.deepEqual(Policy.roleEntries(catalog({primary: disabled.id, fast: disabled.id})), []);
});

test('role rows describe the resolved model with provider and context metadata', () => {
  assert.equal(Policy.roleMetaLabel(fast, 'Model'), 'gpt-5-mini · openai');
  assert.equal(Policy.roleMetaLabel(primary, 'Model'), 'claude-sonnet-4 · anthropic · 200k');
  assert.equal(Policy.roleMetaLabel(undefined, 'Model'), '');
  assert.equal(Policy.primaryLabel(primary, 'Model'), 'claude-sonnet-4');
  assert.equal(Policy.secondaryLabel(fast, 'Model'), 'openai · Fast');
});

test('catalog hydration keeps a resolvable semantic selection', () => {
  const both = catalog({primary: primary.id, fast: fast.id});
  assert.equal(RemoteUiState.selectedModelIdForCatalog(both, 'primary'), 'primary');
  assert.equal(RemoteUiState.selectedModelIdForCatalog(both, 'fast'), 'fast');
  assert.equal(RemoteUiState.selectedModelIdForCatalog({...both, session_model_id: 'fast'}, 'primary'), 'fast');
  assert.equal(RemoteUiState.selectedModelIdForCatalog(both, other.id), other.id);
  assert.equal(RemoteUiState.selectedModelIdForCatalog(both, 'missing-model'), primary.id);
  assert.equal(RemoteUiState.selectedModelIdForCatalog({...both, models: [primary, fast]}, 'fast'), 'fast');
  assert.equal(RemoteUiState.selectedModelIdForCatalog(catalog({fast: fast.id}), 'primary'), fast.id);
  assert.equal(RemoteUiState.selectedModelIdForCatalog(catalog({}), ''), '');
});

test('service and policy semantic helpers agree on padded selectors and defaults', () => {
  const padded = catalog({primary: `  ${primary.id}  `, fast: `  ${fast.id}  `});
  assert.equal(Policy.resolveModel(padded, 'primary').id, primary.id);
  assert.equal(Policy.resolveModel(padded, ' fast ').id, fast.id);
  assert.equal(Policy.resolvedSelectedRole(padded, ' fast '), 'fast');
  assert.deepEqual(Policy.modelRoles(padded, fast.id), ['fast']);
  assert.equal(RemoteUiState.selectedModelIdForCatalog(padded, 'primary'), 'primary');
  assert.equal(RemoteUiState.selectedModelIdForCatalog(padded, ' fast '), 'fast');
  assert.equal(RemoteUiState.selectedModelIdForCatalog(catalog({primary: primary.id, fast: fast.id}), ' primary '), 'primary');

  const paddedFastDisabled = catalog({primary: ` ${primary.id} `, fast: ` ${disabled.id} `});
  assert.equal(Policy.resolveModel(paddedFastDisabled, 'fast').id, primary.id);
  assert.equal(RemoteUiState.selectedModelIdForCatalog(paddedFastDisabled, 'fast'), 'fast');
});
