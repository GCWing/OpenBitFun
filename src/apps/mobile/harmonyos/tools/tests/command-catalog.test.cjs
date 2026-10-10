const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ETS_ROOT = path.join(__dirname, '../../entry/src/main/ets');
const cache = new Map();

function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ets`, path.join(base, 'index.ets')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

// Transpiles a real `.ets` module and resolves its relative imports the same way,
// so the projection under test is the production file rather than a copy.
function loadModule(file) {
  if (cache.has(file)) {
    return cache.get(file);
  }
  const exported = {};
  cache.set(file, exported);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
  }).outputText;
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) {
      throw new Error(`unexpected import "${specifier}" in ${path.basename(file)}`);
    }
    const resolved = resolveSpecifier(file, specifier);
    if (resolved === undefined) {
      throw new Error(`cannot resolve "${specifier}" from ${path.basename(file)}`);
    }
    return loadModule(resolved);
  };
  new Function('require', 'exports', js)(localRequire, exported);
  return exported;
}

function load(relativePath) {
  return loadModule(path.join(ETS_ROOT, relativePath));
}

const {
  CommandCatalogProjection: Projection,
  COMMAND_CATALOG_FILTER_ALL,
  COMMAND_CATALOG_FILTER_BUILTIN,
  COMMAND_CATALOG_FILTER_CUSTOM
} = load('services/CommandCatalogProjection.ets');
const { CommandPalettePolicy } = load('services/CommandPalettePolicy.ets');
const models = load('model/RemoteModels.ets');
const managerSource = fs.readFileSync(path.join(ETS_ROOT, 'services/RemoteSessionManager.ets'), 'utf8');

// One host row, shaped exactly like `ModeSkillInfo`: a flattened `SkillInfo`
// beside the mode's availability flags. Built-in skills are the only ones the
// host gives a group key, which is what the picker's ordering leans on.
function row(key, overrides = {}) {
  return Object.assign({
    key,
    name: key,
    description: `${key} description`,
    path: `/skills/${key}`,
    level: 'user',
    dirName: key,
    isBuiltin: false,
    isShadowed: false,
    allowUserInvocation: true,
    defaultEnabled: true,
    globallyEnabled: true,
    effectiveEnabled: true,
    disabledByMode: false,
    selectedForRuntime: true,
    stateReason: 'builtin_policy_enabled'
  }, overrides);
}

function builtinRow(key, groupKey, name = key) {
  return row(key, {name, isBuiltin: true, groupKey});
}

function ids(catalog) {
  return Projection.rows(catalog).map((entry) => entry.id);
}

test('the host row shape maps onto one palette entry per skill', () => {
  const catalog = Projection.parseHostCatalog([
    builtinRow('plan', 'workflow', 'Plan'),
    row('review', {level: 'project', description: 'Review the change'})
  ]);
  assert.equal(catalog.skills.length, 2);
  const plan = catalog.skills[0];
  assert.equal(plan.id, 'plan', 'the id is the key the [\$key] token carries');
  assert.equal(plan.name, 'Plan');
  assert.equal(plan.description, 'plan description');
  assert.equal(plan.group, 'workflow', 'a built-in keeps the host group taxonomy');
  assert.equal(plan.source, models.REMOTE_SKILL_SOURCE_BUILTIN);
  assert.equal(plan.shadowed, false);
  assert.equal(plan.selectedForRuntime, true);
  assert.equal(plan.effectiveEnabled, true);
  assert.equal(plan.globallyEnabled, true);
  assert.equal(plan.allowUserInvocation, true);

  const review = catalog.skills[1];
  assert.equal(review.group, '', 'a user skill has no host group of its own');
  assert.equal(review.source, models.REMOTE_SKILL_SOURCE_PROJECT,
    'a skill written for this project says so');
});

test('the projection reads a snake_case host as well as the camelCase one', () => {
  // The payload crosses a relay between two independently built versions.
  const catalog = Projection.parseHostCatalog([{
    key: 'plan',
    name: 'Plan',
    description: 'Plan the work',
    level: 'user',
    is_builtin: true,
    group_key: 'workflow',
    is_shadowed: false,
    allow_user_invocation: true,
    selected_for_runtime: true,
    effective_enabled: true,
    globally_enabled: true
  }]);
  assert.deepEqual(ids(catalog), ['plan']);
  const plan = catalog.skills[0];
  assert.equal(plan.group, 'workflow');
  assert.equal(plan.source, models.REMOTE_SKILL_SOURCE_BUILTIN);
  assert.equal(Projection.invocable(plan), true);
});

test('a row without a key names nothing and is dropped', () => {
  const catalog = Projection.parseHostCatalog([
    row(''),
    row('   ', {name: 'blank'}),
    row('plan')
  ]);
  assert.deepEqual(ids(catalog), ['plan'],
    'the key is what the picker lists and keys on, so a row without one is unusable');
});

test('an empty or absent read yields an empty catalog rather than an error', () => {
  assert.deepEqual(Projection.parseHostCatalog(undefined).skills, []);
  assert.deepEqual(Projection.parseHostCatalog([]).skills, []);
  assert.deepEqual(ids(undefined), []);
});

test('only the skill the host offered to the user is offered by the picker', () => {
  // Mirrors the desktop composer's own rule. Each flag is a real refusal.
  function parseOne(overrides = {}) {
    return Projection.parseHostCatalog([row('plan', overrides)]).skills[0];
  }

  assert.equal(Projection.invocable(parseOne()), true);
  assert.equal(Projection.invocable(parseOne({isShadowed: true})), false,
    'a shadowed row is a duplicate of the winner, never a second choice');
  assert.equal(Projection.invocable(parseOne({selectedForRuntime: false})), false);
  assert.equal(Projection.invocable(parseOne({effectiveEnabled: false})), false,
    'a skill this mode disabled is not offered');
  assert.equal(Projection.invocable(parseOne({globallyEnabled: false})), false);
  assert.equal(Projection.invocable(parseOne({allowUserInvocation: false})), false,
    'a skill the model may reach but the user may not must not be listed');

  const catalog = Projection.parseHostCatalog([
    row('plan'),
    row('shadowed', {isShadowed: true}),
    row('mode-off', {effectiveEnabled: false}),
    row('implicit-only', {allowUserInvocation: false})
  ]);
  assert.deepEqual(ids(catalog), ['plan']);
});

test('a host that omits the availability flags offers nothing it did not state', () => {
  // The three availability flags have no contract default, so an absent one reads
  // as `false`: a half-instrumented host yields rows without claiming they are
  // reachable. `allow_user_invocation` is the one flag whose default is `true`,
  // because its absence is the browser-compatible shape rather than a refusal.
  const catalog = Projection.parseHostCatalog([
    {key: 'valid', selected_for_runtime: true, effective_enabled: true, globally_enabled: true},
    {key: 'unstated', name: 'Unstated'}
  ]);
  const valid = catalog.skills.find((entry) => entry.id === 'valid');
  const unstated = catalog.skills.find((entry) => entry.id === 'unstated');
  assert.equal(valid.allowUserInvocation, true);
  assert.equal(Projection.invocable(valid), true);
  assert.equal(unstated.selectedForRuntime, false, 'an unstated flag is not a stated yes');
  assert.equal(unstated.effectiveEnabled, false);
  assert.equal(unstated.globallyEnabled, false);
  assert.equal(unstated.allowUserInvocation, true, 'the one flag with a true default');
  assert.equal(Projection.invocable(unstated), false);
});

test('one key is one row even when the host lists the winner and its shadow', () => {
  // The host emits both rows under the same key, and a picker keyed by id would
  // otherwise render the same choice twice. Keeping the first row could keep the
  // shadowed one and hide the skill the user can actually invoke, so the
  // invocable row wins whichever order they arrive in.
  const shadowedFirst = Projection.parseHostCatalog([
    row('plan', {name: 'Plan (shadowed)', isShadowed: true}),
    row('plan', {name: 'Plan'})
  ]);
  assert.deepEqual(ids(shadowedFirst), ['plan']);
  assert.equal(shadowedFirst.skills.length, 1);
  assert.equal(shadowedFirst.skills[0].name, 'Plan',
    'the invocable row is the one the picker shows');

  const invocableFirst = Projection.parseHostCatalog([
    row('plan', {name: 'Plan'}),
    row('plan', {name: 'Plan (shadowed)', isShadowed: true})
  ]);
  assert.deepEqual(invocableFirst.skills.map((entry) => entry.name), ['Plan']);
  assert.equal(invocableFirst.skills[0].shadowed, false,
    'a later shadowed duplicate must not replace the winner');
});

test('a name collision keeps both rows, custom after builtin', () => {
  // The two sides of the sheet never merge: a user skill that reuses a built-in
  // name stays its own row in the custom group instead of shadowing the built-in.
  const catalog = Projection.parseHostCatalog([
    builtinRow('plan', 'workflow', 'Plan'),
    row('plan.user', {name: 'Plan', level: 'project'})
  ]);
  const presentation = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_ALL);
  assert.deepEqual(presentation.sections.map((section) => section.id),
    [COMMAND_CATALOG_FILTER_BUILTIN, COMMAND_CATALOG_FILTER_CUSTOM],
    'the custom section always comes last');
  assert.deepEqual(presentation.sections[0].rows.map((entry) => entry.name), ['Plan']);
  assert.deepEqual(presentation.sections[1].rows.map((entry) => entry.name), ['Plan']);
  assert.notEqual(presentation.sections[0].rows[0].id, presentation.sections[1].rows[0].id);
});

test('the built-in section is ordered by the host group, then by name', () => {
  const catalog = Projection.parseHostCatalog([
    builtinRow('zeta', 'workflow'),
    builtinRow('alpha', 'writing'),
    builtinRow('beta', 'workflow')
  ]);
  const presentation = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_ALL);
  const builtin = presentation.sections[0];
  assert.equal(builtin.titleKey, Projection.builtinSectionKey);
  assert.deepEqual(builtin.rows.map((entry) => entry.id), ['beta', 'zeta', 'alpha'],
    'group order first, name inside the group');
  assert.deepEqual(builtin.rows.map((entry) => entry.group), ['workflow', 'workflow', 'writing']);
  assert.equal(builtin.count, 3);
});

test('a user skill with no group still sorts inside the custom section', () => {
  const catalog = Projection.parseHostCatalog([
    row('two', {name: 'Beta', level: 'project'}),
    row('one', {name: 'Alpha', level: 'user'})
  ]);
  const presentation = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_ALL);
  assert.deepEqual(presentation.sections.map((section) => section.id), [COMMAND_CATALOG_FILTER_CUSTOM],
    'with no built-ins the custom section is the only one, and it is still a section');
  assert.deepEqual(presentation.sections[0].rows.map((entry) => entry.name), ['Alpha', 'Beta']);
  assert.equal(presentation.sections[0].titleKey, Projection.customSectionKey);
  assert.equal(presentation.isEmpty, false);
  assert.equal(presentation.hasNoMatches, false);
});

test('the filters count what each side actually holds', () => {
  const catalog = Projection.parseHostCatalog([
    builtinRow('plan', 'workflow'),
    builtinRow('review', 'workflow'),
    row('shipping', {level: 'project'})
  ]);
  const rows = Projection.rows(catalog);
  assert.equal(rows.length, 3);
  assert.equal(Projection.builtinCount(rows), 2);
  assert.equal(Projection.customCount(rows), 1);

  const all = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_ALL);
  assert.deepEqual(all.filters.map((filter) => filter.count), [3, 2, 1]);
  assert.deepEqual(all.filters.map((filter) => filter.labelKey), [
    'commands.skills.filterAll', 'commands.skills.filterBuiltin', 'commands.skills.filterCustom'
  ]);

  const builtinOnly = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_BUILTIN);
  assert.deepEqual(builtinOnly.sections.map((section) => section.id), [COMMAND_CATALOG_FILTER_BUILTIN]);
  const customOnly = Projection.present(catalog, '', COMMAND_CATALOG_FILTER_CUSTOM);
  assert.deepEqual(customOnly.sections.map((section) => section.id), [COMMAND_CATALOG_FILTER_CUSTOM]);
});

test('a search matches the names, keys, groups and descriptions', () => {
  const catalog = Projection.parseHostCatalog([
    builtinRow('plan', 'workflow', 'Plan'),
    row('shipping', {name: 'Shipping', description: 'Cut a release'})
  ]);
  assert.deepEqual(
    Projection.present(catalog, 'PLAN', COMMAND_CATALOG_FILTER_ALL)
      .sections.map((section) => section.rows.map((entry) => entry.id)),
    [['plan']], 'the query is case-insensitive and matches the name');
  assert.deepEqual(
    Projection.present(catalog, 'shipping', COMMAND_CATALOG_FILTER_ALL)
      .sections.map((section) => section.rows.map((entry) => entry.id)),
    [['shipping']], 'the query matches the key');
  assert.deepEqual(
    Projection.present(catalog, 'workflow', COMMAND_CATALOG_FILTER_ALL)
      .sections.map((section) => section.rows.map((entry) => entry.id)),
    [['plan']], 'the query matches the host group');
  assert.deepEqual(
    Projection.present(catalog, 'cut a release', COMMAND_CATALOG_FILTER_ALL)
      .sections.map((section) => section.rows.map((entry) => entry.id)),
    [['shipping']], 'the query matches the description');

  const nothing = Projection.present(catalog, 'nothing matches this', COMMAND_CATALOG_FILTER_ALL);
  assert.deepEqual(nothing.sections, []);
  assert.equal(nothing.hasNoMatches, true);
  assert.equal(nothing.isEmpty, false, 'a filtered-out catalog is not an empty one');
  assert.deepEqual(nothing.filters.map((filter) => filter.count), [2, 1, 1],
    'the filter counts describe the whole catalog, not the query');
});

test('an empty catalog is distinguishable from a filtered-out one', () => {
  const empty = Projection.present(Projection.parseHostCatalog([]), '', COMMAND_CATALOG_FILTER_ALL);
  assert.equal(empty.isEmpty, true, 'the host answered with nothing to invoke');
  assert.equal(empty.hasNoMatches, false);
  assert.deepEqual(empty.sections, []);
  assert.deepEqual(empty.filters.map((filter) => filter.count), [0, 0, 0]);

  const neverRead = Projection.present(undefined, '', COMMAND_CATALOG_FILTER_ALL);
  assert.equal(neverRead.isEmpty, true, 'no catalog at all reads as the same empty state');
});

test('the token label the picker hints at is the one the message carries', () => {
  // The hint and the message's token are the same string built by the same rule:
  // the desktop inserts `[$\u003cname\u003e]`, so a row hinted at its key would promise
  // text the message does not contain.
  const catalog = Projection.parseHostCatalog([builtinRow('plan', 'workflow', 'Plan')]);
  const entry = Projection.rows(catalog)[0];
  assert.equal(entry.name, 'Plan');
  assert.equal(entry.insertHint, CommandPalettePolicy.skillTokenLabel(entry.name));
  assert.equal(entry.insertHint, '[$Plan]');
  assert.equal(entry.isBuiltin, true, 'the row draws its built-in icon from this');

  const composed = CommandPalettePolicy.composeSubmissionText('fix the login', entry.name);
  assert.ok(composed.startsWith(entry.insertHint),
    'the message must open with exactly the token the row hinted at');
  assert.notEqual(entry.insertHint, CommandPalettePolicy.skillTokenLabel(entry.id),
    'the key is not what the user sees, which is why this test compares the name');
});

test('a row the host never named still yields a token that can be sent', () => {
  const catalog = Projection.parseHostCatalog([{key: 'plan.sub', selectedForRuntime: true,
    effectiveEnabled: true, globallyEnabled: true}]);
  const entry = Projection.rows(catalog)[0];
  assert.equal(entry.name, 'plan.sub', 'the key stands in for a missing name');
  assert.equal(entry.insertHint, '[$plan.sub]');
});

test('hostInvoke unwraps the bridge envelope instead of the command value', () => {
  // `host_invoke` answers with `{ok, value, error}`; every palette verb parses the
  // `value` and treats a refusal as a rejection, which is what makes the first
  // catalog read a usable probe.
  const hostInvoke = methodBody(managerSource, 'async hostInvoke<T>(command: string, args: Object): Promise<T>');
  assert.match(hostInvoke, /cmd: 'host_invoke'/);
  assert.match(hostInvoke, /command: command/);
  assert.match(hostInvoke, /args: args/);
  assert.match(hostInvoke, /if \(!response\.ok\)/);
  assert.match(hostInvoke, /throw new HostInvokeRefusal\(command, response\.error \|\| ''\)/,
    'a refused command must reject as a typed refusal so the caller can tell the host answering from the wire breaking');
  assert.match(hostInvoke, /return response\.value as T/);
  assert.match(managerSource, /ok: boolean; value\?: T; error\?: string;/);
  assert.match(managerSource, /import \{ HostInvokeRefusal \} from '\.\/HostInvokeRefusal';/);
});

test('a refusal carries the host words and a broken wire does not pretend to', () => {
  // The type is the whole distinction: `host_invoke` sets `ok: false` when the
  // host received the command and declined it, and nothing else on that wire ever
  // reached a host.
  const refusalSource = fs.readFileSync(path.join(ETS_ROOT, 'services/HostInvokeRefusal.ets'), 'utf8');
  assert.match(refusalSource, /export class HostInvokeRefusal extends Error/);
  assert.match(refusalSource, /readonly hostText: string;/);
  assert.match(refusalSource, /readonly command: string;/);
  assert.match(refusalSource, /export function isHostInvokeRefusal\(err: Object\): boolean \{[\s\S]*?err instanceof HostInvokeRefusal/);
  assert.match(refusalSource, /export function hostInvokeRefusalText\(err: Object\): string \{[\s\S]*?hostText/,
    'the host text is kept as it was sent rather than reworded by the connection policy');
});

test('each palette verb sends the arguments its own Rust handler declares', () => {
  // Flat camelCase for the skill read (its signature has no `request` wrapper),
  // camelCase inside `request` for the two turn verbs, and the snake_case fields
  // of the usage request, which is declared without `rename_all`.
  const skill = methodBody(managerSource, 'async skillCatalog(query: RemoteSkillCatalogQuery): Promise<RemoteCommandCatalog>');
  assert.match(skill, /'get_mode_skill_configs'/);
  assert.match(skill, /modeId: query\.modeId/);
  assert.match(skill, /forceRefresh: query\.forceRefresh/);
  assert.doesNotMatch(skill, /request:/, 'the skill read takes flat arguments');
  assert.match(skill, /CommandCatalogProjection\.parseHostCatalog\(rows\)/);

  const compact = methodBody(managerSource, 'async compactSession(query: RemoteCommandPaletteScope): Promise<string>');
  assert.match(compact, /'compact_session'/);
  assert.match(compact, /SessionRequestArgs = \{ request: RemoteSessionManager\.sessionRequest\(query\) \}/);

  const init = methodBody(managerSource, 'async runInitAgentsMd(query: RemoteCommandPaletteScope): Promise<string>');
  assert.match(init, /'run_init_agents_md'/);
  assert.match(init, /SessionRequestArgs = \{ request: RemoteSessionManager\.sessionRequest\(query\) \}/);

  const usage = methodBody(managerSource,
    'async sessionUsageReport(query: RemoteCommandPaletteScope): Promise<RemoteSessionUsageReport | undefined>');
  assert.match(usage, /'get_session_usage_report'/);
  assert.match(usage, /const request: SessionUsageRequest = \{ session_id: query\.sessionId \}/);
  assert.match(usage, /request\.workspace_id = query\.workspaceId/);
  assert.match(usage, /request\.workspace_path = query\.workspacePath/);
  assert.match(usage, /request\.remote_connection_id = query\.remoteConnectionId/);
  assert.match(usage, /request\.remote_ssh_host = query\.remoteSshHost/);
  assert.doesNotMatch(usage, /\bsessionId:/,
    'the usage request is declared without `rename_all`, so its fields stay snake_case');

  const request = methodBody(managerSource, 'private static sessionRequest(query: RemoteCommandPaletteScope): SessionRequest');
  assert.match(request, /const request: SessionRequest = \{ sessionId: query\.sessionId \}/);
  assert.match(request, /request\.workspaceId = query\.workspaceId/);
  assert.match(request, /request\.workspacePath = query\.workspacePath/);
  assert.match(request, /request\.remoteConnectionId = query\.remoteConnectionId/);
  assert.match(request, /request\.remoteSshHost = query\.remoteSshHost/);
  assert.doesNotMatch(request, /workspace_id/,
    'the two turn verbs take the camelCase struct their handler declares');
});

// Slices one method out of a class body, from its signature to the closing brace
// that sits at the class's own indentation.
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `RemoteSessionManager must keep ${signature}`);
  const end = source.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, `${signature} must stay a closed method`);
  return source.slice(start, end);
}
