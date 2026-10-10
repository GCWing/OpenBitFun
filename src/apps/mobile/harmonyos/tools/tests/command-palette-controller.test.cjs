const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Loads an `.ets` module with the imports it needs supplied by the caller, so a
// test can drive production classes whose neighbours are ArkUI-bound.
function load(relativePath, stubs = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true
    }
  }).outputText;
  const exported = {};
  // ArkTS decorators are globals in the framework, and `__decorate` keeps the
  // decorated member when a decorator returns nothing — which is what `@Trace`
  // does. A class decorator returning nothing keeps its class for the same
  // reason, so one stub serves both.
  const decorator = () => undefined;
  new Function('require', 'exports', 'ObservedV2', 'Trace', js)(
    (id) => stubs[id] ?? {}, exported, decorator, decorator);
  return exported;
}

const policy = load('entry/src/main/ets/services/CommandPalettePolicy.ets');
const refusals = load('entry/src/main/ets/services/HostInvokeRefusal.ets');
const {
  CommandPaletteCatalogStatus,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteProbeFailure
} = policy;

const controllerModule = load('entry/src/main/ets/services/RemoteCommandPaletteController.ets', {
  './CommandPalettePolicy': policy,
  './HostInvokeRefusal': refusals,
  './ConnectionErrorPolicy': {
    // Only reachable for a non-refusal failure, where the app words the
    // connection problem itself.
    ConnectionErrorPolicy: {errorText: (err) => (err instanceof Error ? err.message : String(err))}
  },
  './RemoteLogger': {RemoteLogger: {info: () => {}, warn: () => {}}}
});
const { RemoteCommandPaletteController, CommandPaletteProbe } = controllerModule;

// The production page state, minus the ArkUI decorators its class carries.
const stateModule = load('entry/src/main/ets/pages/state/CommandPaletteState.ets', {
  '../../services/CommandPalettePolicy': policy,
  '../policy/UsageReportPresentationPolicy': {
    UsageReportPresentationPolicy: {present: () => ({sections: [], partial: false})}
  }
});
const { CommandPaletteState, CommandPalettePresentation } = stateModule;

/**
 * A page and a controller wired the way the composition wires them.
 *
 * `CommandPaletteState` is what the conversation reads and the controller is
 * what owns the probe's answer, so a test can see exactly what a re-entry paints.
 */
function fixture(options = {}) {
  const state = new CommandPaletteState();
  const calls = {catalog: 0, verbs: []};
  const client = {
    skillCatalog: async () => {
      calls.catalog += 1;
      if (options.failCatalog) {
        throw options.failCatalog;
      }
      return {skills: [{id: 'plan', name: 'Plan'}]};
    },
    compactSession: async () => 'ok',
    runInitAgentsMd: async () => 'ok',
    sessionUsageReport: async () => undefined
  };
  const controller = new RemoteCommandPaletteController(client, {
    onCatalogLoading: () => state.setCatalogLoading(),
    onCatalogReady: (_sessionId, catalog) => state.setCatalogReady(catalog),
    onCatalogFailed: (_sessionId, errorText, failure) => state.setCatalogFailed(errorText, failure),
    onCommandStarted: () => {},
    onCommandSettled: () => {},
    onCommandNoticeExpired: () => {},
    onUsageLoading: () => {},
    onUsageReady: () => {},
    onUsageFailed: () => {}
  });
  return {state, controller, calls};
}

// The row as the conversation view projects it: the chips a tap may act on.
function chips(fixtureState) {
  return CommandPalettePresentation.project(fixtureState, true, false).chips;
}

function chip(chipsShown, kind) {
  const found = chipsShown.find((entry) => entry.kind === kind);
  assert.ok(found, `the row must carry the ${kind} chip`);
  return found;
}

const isSessionReachable = () => true;

test('re-entering a probed session repaints its row from the answer already in hand', async () => {
  // The controller outlives the conversation's state, so a session that is left
  // and re-entered would otherwise draw a waiting row over an answer the
  // controller still holds — and, before this, a row waiting forever.
  const {state, controller, calls} = fixture();
  await controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
  assert.equal(calls.catalog, 1);
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Ready);
  assert.equal(chip(chips(state), CommandPaletteChipKind.Skills).state, CommandPaletteChipState.Ready);

  // Leaving the conversation drops every conversation-scoped value it owned.
  state.reset();
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Idle);
  assert.equal(state.catalog, undefined);
  assert.equal(chip(chips(state), CommandPaletteChipKind.Skills).state, CommandPaletteChipState.Dimmed,
    'a waiting chip is what the page shows before anything answers');

  await controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
  assert.equal(calls.catalog, 1, 'the answer in hand is not read again');
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Ready, 'the row is not left waiting');
  assert.ok(state.catalog, 'the cached catalog is what the picker lists');
  assert.equal(state.catalog.skills.length, 1);
  assert.equal(chip(chips(state), CommandPaletteChipKind.Skills).state, CommandPaletteChipState.Ready);
  assert.equal(chip(chips(state), CommandPaletteChipKind.Skills).badgeKey, '');
  assert.equal(controller.catalogProbeFor('session-a'), CommandPaletteProbe.Probed);
});

test('a failed read is republished as the same failure, not as a fresh verdict', async () => {
  // A timeout that happened once must not come back as an upgrade prompt, and a
  // host that named the version gap must not come back as a timeout.
  for (const [thrown, expected, badge] of [
    [new refusals.HostInvokeRefusal('get_mode_skill_configs',
      "command 'get_mode_skill_configs' is unknown to this OpenBitFun desktop peer host version; " +
      'upgrade the peer host or check the command name'),
      CommandPaletteProbeFailure.VersionGap, policy.CommandPalettePolicy.upgradeBadgeKey],
    [new refusals.HostInvokeRefusal('get_mode_skill_configs', 'workspace not found'),
      CommandPaletteProbeFailure.Refused, ''],
    [new Error('request timed out'), CommandPaletteProbeFailure.Unreachable, '']
  ]) {
    const {state, controller, calls} = fixture({failCatalog: thrown});
    await controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
    assert.equal(state.catalogFailure, expected, `${expected}: first read`);
    state.reset();

    await controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
    assert.equal(calls.catalog, 1, `${expected}: no second read`);
    assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Failed, `${expected}: re-entry`);
    assert.equal(state.catalogFailure, expected);
    assert.equal(state.catalogErrorText.length > 0, true, `${expected}: the host text survives`);
    assert.equal(chip(chips(state), CommandPaletteChipKind.Skills).badgeKey, badge);
    assert.equal(controller.catalogFailureFor('session-a'), expected);
  }
});

test('a forced re-check reads again and clears the previous verdict', async () => {
  // 「重新检查」 is the user's own retry after upgrading the desktop, so it must
  // never be served from the cache it exists to replace.
  const {state, controller, calls} = fixture({
    failCatalog: new refusals.HostInvokeRefusal('get_mode_skill_configs', 'Command not found: get_mode_skill_configs')
  });
  await controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Failed);

  const recovered = fixture();
  await recovered.controller.loadCatalog('session-a', 'agentic', false, isSessionReachable);
  assert.equal(recovered.calls.catalog, 1);

  // A forced read on the failing fixture goes out again and still fails.
  await controller.loadCatalog('session-a', 'agentic', true, isSessionReachable);
  assert.equal(calls.catalog, 2, 'a forced read is not served from cache');
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Failed);
});

test('an answer for a session the user left is dropped rather than painted', async () => {
  // The fence is the last thing between a slow host and one session's catalog
  // appearing over another's conversation.
  const {state, controller} = fixture();
  await controller.loadCatalog('session-a', 'agentic', false, () => false);
  assert.equal(state.catalogStatus, CommandPaletteCatalogStatus.Idle,
    'a read whose session is gone must not repaint anything');
  assert.equal(controller.catalogProbeFor('session-a'), CommandPaletteProbe.Unprobed);
});
