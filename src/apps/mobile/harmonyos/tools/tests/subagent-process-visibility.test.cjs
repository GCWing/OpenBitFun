const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const cache = new Map();

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
    // Platform kits are only reached by code paths these tests do not run.
    if (!name.startsWith('.')) return {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name))
      .split(path.sep).join('/');
    return fs.existsSync(path.join(ROOT, `${target}.ets`)) ? load(target) : {};
  }, exported);
  return exported;
}

const { DurableSessionReducer } = load('services/DurableSessionReducer');
const { ChatTimelineStore } = load('services/ChatTimelineStore');
const { ChatSessionController } = load('services/ChatSessionController');
const { SubagentStreamCoordinator } = load('services/SubagentStreamCoordinator');
const { ChatTimelineRowStore } = load('model/ChatTimelineModels');
const ui = load('pages/state/ConversationUiModels');
const { ChatMessageStructurePolicy: Policy } = load('pages/policy/ChatMessageStructurePolicy');
const fixture = load('pages/preview/SubagentSwarmFixture');

const SESSION = fixture.SWARM_PARENT_SESSION;
const CHILD_SESSION = fixture.SWARM_PAYMENTS_SESSION;
const TASK_CALL_ID = 'task_call_1';
const SWARM_CALL_ID = 'swarm_call_1';

/**
 * One durable session-record event exactly as the host publishes it.
 *
 * The shapes are the ones `records_from_turns` serializes: a turn header every
 * record repeats, an optional round header, and the item's own data under
 * `item.data` with camelCase keys.
 */
function record(revision, id, type, order, data, sessionId = SESSION) {
  return {
    session_id: sessionId,
    event: 'session-record',
    payload: {
      sessionId,
      id: `item/${id}`,
      revision,
      turn: {
        turnId: 'turn', turnIndex: 0, sessionId, timestamp: 1,
        userMessage: { id: 'user', content: 'run the audit', timestamp: 1 },
        status: 'inprogress'
      },
      round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: 'inprogress' },
      item: { type, data: Object.assign({ id, orderIndex: order, timestamp: 3 }, data) }
    }
  };
}

/**
 * The owner tool record of a delegation.
 *
 * The host records the child Session id on the launching tool item — the
 * durable contract is `subagent_session_id` on the item data in
 * `src/crates/services/services-core/src/session/types.rs`, published as
 * `subagentSessionId` — and the launching tool is `AgentSpawn` in an Ultimate
 * session. Nothing else on the parent item says a child exists, and the child's
 * own records never say which launch they belong to.
 */
function ownerRecord(revision, sessionId = CHILD_SESSION, toolName = 'AgentSpawn', toolId = SWARM_CALL_ID) {
  return record(revision, toolId, 'tool', 0, {
    toolName,
    toolCall: { id: toolId, input: { agent_id: 'swarm-audit', agent_type: 'Explore', prompt: 'Audit it' } },
    toolResult: { result: 'agent_id   bg_task_id   status\nswarm-audit bg-7f21c9    started', success: true },
    startTime: 3,
    status: 'completed',
    subagentSessionId: sessionId
  });
}

/** Unmarked process records of a child session, as that session's own stream publishes them. */
function childThinkingRecord(revision, sessionId = CHILD_SESSION) {
  return record(revision, 'child-think', 'thinking', 1, { content: 'Reading the payment module' }, sessionId);
}

function childToolRecord(revision, sessionId = CHILD_SESSION) {
  return record(revision, 'child-read', 'tool', 2, {
    toolName: 'Read',
    toolCall: { id: 'child-read', input: { file_path: 'src/payments.ts' } },
    toolResult: { result: 'export const charge = 1', success: true },
    startTime: 4,
    status: 'completed'
  }, sessionId);
}

function childTextRecord(revision, sessionId = CHILD_SESSION) {
  return record(revision, 'child-text', 'text', 3, { content: 'Found no hard-coded keys' }, sessionId);
}

/** A launch item as the host records it, at the status that revision carried. */
function launchRecord(revision, status) {
  return record(revision, SWARM_CALL_ID, 'tool', 0, {
    toolName: 'AgentSpawn',
    toolCall: { id: SWARM_CALL_ID, input: { agent_id: 'swarm-audit', agent_type: 'Explore', prompt: 'Audit it' } },
    startTime: 3,
    status,
    subagentSessionId: CHILD_SESSION
  });
}

/** The child's own records, in the order its stream publishes them. */
function childRecords() {
  return [childThinkingRecord(1), childToolRecord(2), childTextRecord(3)];
}

/**
 * A coordinator over a stub stream per child session, plus the callbacks it
 * registered, so a test can deliver child records as the host would.
 */
function coordinatorHarness() {
  const opened = new Map();
  const closed = [];
  const errors = [];
  let notifications = 0;
  const coordinator = new SubagentStreamCoordinator({
    subscribeSession: (sessionId, callbacks) => {
      opened.set(sessionId, callbacks);
      return { close: () => { closed.push(sessionId); }, wake: () => {}, loadOlder: () => {}, isClosed: () => false };
    }
  }, () => { notifications++; }, error => { errors.push(error); });
  return {
    coordinator, opened, closed, errors,
    notifications: () => notifications
  };
}

/** A parent transcript holding one delegation item, as the reducer projects it. */
function parentMessages(records) {
  const reducer = new DurableSessionReducer();
  records.forEach(event => reducer.apply(event));
  return reducer.messages();
}

/** The assistant row's items of a transcript built from `records`. */
function parentItems(records) {
  const assistant = parentMessages(records).find(message => message.role === 'assistant');
  assert.ok(assistant, 'the transcript holds an assistant row');
  return ui.toConversationUiMessage(assistant).items || [];
}

async function until(predicate, label, attempts = 400) {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * The production chain the live assistant row walks: the session's records ->
 * controller -> durable reducer -> timeline store -> projector -> keyed V2 rows
 * -> conversation UI DTO -> grouped render model. Returns the Task cards the
 * bubble would draw, or undefined while the session has not published yet.
 */
function projectCards(timeline) {
  const rows = new ChatTimelineRowStore().reconcile(timeline.project(false));
  const liveRow = rows.find(row => row.type === 'assistant_live_turn');
  if (!liveRow) return undefined;
  const message = ui.toConversationUiMessage(liveRow.message);
  const groups = Policy.structuredGroups(message.items || [], 'item', (message.status || '') === 'active',
    message.status || 'active');
  const items = groups.flatMap(group => group.type === 'item' ? group.items : []);
  const tools = groups.flatMap(group => group.tools || []);
  const cards = items.filter(entry => Policy.isSubagentEntry(entry));
  return { message, groups, items, tools, cards };
}

function cardsFromTimeline(timeline) {
  const projected = projectCards(timeline);
  assert.ok(projected, 'the running turn is projected as a live assistant row');
  return projected;
}

function cardCount(timeline) {
  const projected = projectCards(timeline);
  return projected ? projected.cards.length : -1;
}

/** The live swarm fixture read through the production controller. */
async function swarmHarness() {
  const ledger = new fixture.SwarmLedger();
  const script = new fixture.SwarmScript(ledger);
  const timeline = new ChatTimelineStore();
  timeline.reset(SESSION);
  const errors = [];
  const subscribed = [];
  const controller = new ChatSessionController({
    getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }),
    subscribeSession: (sessionId, callbacks) => {
      subscribed.push(sessionId);
      return ledger.openStream(sessionId, callbacks);
    }
  }, {
    onSnapshot: snapshot => timeline.applySnapshot(snapshot),
    canPoll: () => true,
    onError: error => { errors.push(error); }
  }, { initialPollDelayMs: 0 });
  // The turn's opening records exist before the session is read, the way a
  // history page already holds everything the reader has produced so far.
  script.advance();
  controller.start(SESSION, { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await until(() => cardCount(timeline) === 0, 'the parent session to be read');
  return { ledger, script, timeline, controller, errors, subscribed };
}

/** Publishes every beat of the fixture up to and including `lastBeat`. */
function beatThrough(script, lastBeat) {
  while (script.position() <= lastBeat) {
    assert.equal(script.advance(), true, `the fixture has beat ${lastBeat}`);
  }
}

test('a launch item that names a child session receives that child stream as its branch', async () => {
  const harness = await swarmHarness();
  const { script, timeline, subscribed, controller } = harness;
  try {
    script.advance(); // launch the payments worker, which had already finished
    await until(() => (projectCards(timeline)?.cards[0]?.subItems || []).length === 6,
      "the child's own page to land in the branch");

    const { cards, message } = cardsFromTimeline(timeline);
    const card = cards[0];
    assert.equal(card.tool.name, 'AgentSpawn', 'the launching item is the card');
    assert.deepEqual((card.subItems || []).map(child => child.type),
      ['thinking', 'tool', 'tool', 'thinking', 'tool', 'text'],
      "the branch holds the child's own items in the child's own order");
    assert.equal(card.subItems[0].content, 'Locate every payment entry point before reading any of them.');
    assert.equal(card.subItems[1].tool.name, 'Grep');
    assert.equal(card.subItems[5].content.indexOf('Reported two defects'), 0);
    assert.equal(message.text.indexOf('I will run three workers'), 0,
      "the parent's own text is the answer, not the worker's report");

    assert.ok(subscribed.includes(CHILD_SESSION), 'the child session was read as its own stream');
    assert.deepEqual(harness.errors, [], 'no stream failed');
  } finally {
    controller.stop();
  }
});

test('the branch is grouped by the subscription it arrived on, not by a marker on the record', async () => {
  const harness = await swarmHarness();
  const { script, timeline, controller } = harness;
  try {
    script.advance();
    await until(() => (projectCards(timeline)?.cards[0]?.subItems || []).length === 6, 'the branch');
    const card = cardsFromTimeline(timeline).cards[0];
    assert.ok(card.subItems.length > 0, 'the branch has the child process');
    assert.ok(card.subItems.every(child => child.is_subagent !== true),
      'and it does: the child records are unmarked, exactly as the host publishes them');
    assert.ok(card.subItems.every(child => !child.subItems || child.subItems.length === 0),
      'no child item is nested in another');
  } finally {
    controller.stop();
  }
});

test("the parent's own records never become a card's process", async () => {
  const harness = await swarmHarness();
  const { script, timeline, controller } = harness;
  try {
    beatThrough(script, 8); // launches, AgentWait and ordinary parent rows
    await until(() => cardCount(timeline) === 3, 'three launches to be read');

    const { items, tools, cards } = cardsFromTimeline(timeline);
    const parentTools = tools.concat(items.filter(entry => entry.tool).map(entry => entry.tool))
      .filter(tool => tool.name !== 'AgentSpawn' && tool.name !== 'Task');
    assert.deepEqual(parentTools.map(tool => tool.name), ['AgentWait', 'Grep', 'Read'],
      "the parent's own rows stay sibling rows");
    cards.forEach(card => {
      const ids = (card.subItems || []).map(child => child.tool?.id || child.type);
      assert.ok(ids.indexOf('swarm-wait') < 0 && ids.indexOf('swarm-parent-grep') < 0,
        "the parent's own rows are not drawn inside a branch");
    });
  } finally {
    controller.stop();
  }
});

test('a worker that is still running keeps publishing into its own card', async () => {
  const harness = await swarmHarness();
  const { script, timeline, controller } = harness;
  try {
    beatThrough(script, 3); // the second worker is launched, still silent
    await until(() => cardCount(timeline) === 3, 'three launches');
    const docsCard = () => cardsFromTimeline(timeline).cards.find(card => card.tool.id === 'swarm-docs-spawn');
    assert.equal((docsCard().subItems || []).length, 0, 'a launch is drawn before its worker says anything');

    beatThrough(script, 4);
    await until(() => (docsCard().subItems || []).length === 1, "the worker's first step");
    const firstKey = cardsFromTimeline(timeline).groups.map(group => group.key).join('|');

    beatThrough(script, 6);
    await until(() => (docsCard().subItems || []).length === 2, 'the worker to publish more steps');
    assert.deepEqual((docsCard().subItems || []).map(child => child.type), ['thinking', 'tool']);
    assert.equal(cardsFromTimeline(timeline).groups.map(group => group.key).join('|'), firstKey,
      'an arriving step must not recreate the card node that is already open');

    beatThrough(script, 12);
    await until(() => (docsCard().subItems || []).length === 5, 'the worker to keep streaming');
    assert.deepEqual((docsCard().subItems || []).map(child => child.tool?.id || child.type),
      ['thinking', 'swarm-docs-search', 'thinking', 'swarm-docs-links', 'swarm-docs-read'],
      'and its card still holds one row per step it published');
    assert.equal(harness.errors.length, 0, 'no stream failed while its card streamed');
  } finally {
    controller.stop();
  }
});

test('a launch item without a child session id is an ordinary tool row', () => {
  const bare = ownerRecord(1);
  delete bare.payload.item.data.subagentSessionId;
  const items = parentItems([bare]);
  const groups = Policy.structuredGroups(items, 'item', true, 'active');

  assert.deepEqual(groups.map(group => group.type), ['tool_group'],
    'nothing claims it, so it is drawn as a tool row');
  assert.equal(groups[0].tools[0].name, 'AgentSpawn');
  assert.equal(groups[0].tools[0].tool_input.prompt, 'Audit it',
    'with the brief it was given, exactly as an older host draws it');
  assert.equal(Policy.scopeSubagentItems(items).length, 1, 'and no branch is opened for it');
});

test('a launch item without a child session id opens no branch and no stream', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  const bare = ownerRecord(1);
  delete bare.payload.item.data.subagentSessionId;
  coordinator.observeParentEvent(bare);
  assert.equal(opened.size, 0, 'an older host names no child session, so nothing is followed');

  const decorated = coordinator.decorate(parentMessages([bare]));
  const groups = Policy.structuredGroups(ui.toConversationUiMessage(decorated[1]).items || [],
    'item', true, 'active');
  assert.deepEqual(groups.map(group => group.type), ['tool_group'],
    'and the launch stays an ordinary tool row');
  assert.equal(groups[0].tools[0].name, 'AgentSpawn');
  coordinator.endSession();
});

test('a marked launch item still opens its branch and is never swallowed by another', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'completed' } };
  const groups = Policy.structuredGroups([owner], 'item', true, 'active');
  assert.equal(groups.length, 1, 'the launch is drawn');
  assert.equal(groups[0].items[0].tool.name, 'AgentSpawn',
    'as a branch owner rather than as an internal tool of another branch');
  assert.equal(Policy.isSubagentEntry(groups[0].items[0]), true);
});

test('an unmarked launch item keeps the parent rows that follow it out of its branch', () => {
  // Older desktops ran a Task subagent inline and marked nothing; AgentSpawn
  // never worked that way, so the records after it are the parent's own work.
  const swarm = { type: 'tool', tool: { id: 'swarm', name: 'AgentSpawn', status: 'running' } };
  const read = { type: 'tool', tool: { id: 'parent-read', name: 'Read', status: 'completed' } };
  const scoped = Policy.scopeSubagentItems([swarm, read]);
  assert.equal(scoped.length, 2, 'the parent row stays a sibling row');
  assert.equal((scoped[0].subItems || []).length, 0);

  const task = { type: 'tool', tool: { id: 'task', name: 'Task', status: 'running' } };
  const legacy = Policy.scopeSubagentItems([task, read]);
  assert.equal(legacy.length, 1, 'the legacy Task fallback is unchanged');
  assert.equal((legacy[0].subItems || []).length, 1);
});

test('every owner name the host can send opens the branch', () => {
  for (const name of ['Task', 'task', 'TASK', ' Task ', 'AgentSpawn', 'agentspawn', 'AgentSpawn']) {
    const owner = { type: 'tool', tool: { id: 'call', name, status: 'running' } };
    const child = { type: 'text', is_subagent: true, content: 'child output' };
    const scoped = Policy.scopeSubagentItems([owner, child]);
    assert.equal((scoped[0].subItems || []).length, 1, `owner name ${JSON.stringify(name)} owns the child`);
  }
});

test('a card read from a decorated parent message carries the child branch', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(ownerRecord(1));
  assert.ok(opened.has(CHILD_SESSION), 'the child session is followed once its launch is read');

  const callbacks = opened.get(CHILD_SESSION);
  childRecords().forEach(event => callbacks.onEvent(event));
  callbacks.onCaughtUp();

  const decorated = coordinator.decorate(parentMessages([ownerRecord(1)]));
  const card = Policy.subagentBranchAt(ui.toConversationUiMessage(decorated[1]).items || [], 0, SWARM_CALL_ID);
  assert.ok(card, 'the branch is found by the launch tool call');
  assert.deepEqual((card.subItems || []).map(child => child.type), ['thinking', 'tool', 'text']);
  assert.ok(harness.notifications() > 0, 'the parent is republished when the branch changes');
  coordinator.endSession();
  assert.ok(harness.closed.includes(CHILD_SESSION), 'and the child stream is closed with the session');
});

test('the same child record published twice adds one step', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(ownerRecord(1));
  const callbacks = opened.get(CHILD_SESSION);
  const [thinking, tool, text] = childRecords();

  callbacks.onEvent(thinking);
  callbacks.onCaughtUp();
  callbacks.onEvent(thinking); // the host replayed a page the reader already had
  callbacks.onEvent(tool);
  callbacks.onEvent(text);

  const decorated = coordinator.decorate(parentMessages([ownerRecord(1)]));
  const card = Policy.subagentBranchAt(ui.toConversationUiMessage(decorated[1]).items || [], 0, SWARM_CALL_ID);
  assert.deepEqual((card.subItems || []).map(child => child.type), ['thinking', 'tool', 'text'],
    'identity and revision decide, so a replayed record is not a second step');

  // A newer revision of an existing step updates it in place.
  const updated = childToolRecord(9);
  updated.payload.item.data.status = 'failed';
  updated.payload.item.data.toolResult = { result: '', success: false, error: 'permission denied' };
  callbacks.onEvent(updated);
  const after = coordinator.decorate(parentMessages([ownerRecord(1)]));
  const updatedCard = Policy.subagentBranchAt(ui.toConversationUiMessage(after[1]).items || [], 0, SWARM_CALL_ID);
  assert.equal((updatedCard.subItems || []).length, 3, 'an updated step replaces the one it updates');
  assert.equal(updatedCard.subItems[1].tool.status, 'failed');
  coordinator.endSession();
});

test('a settled launch repaints its card even when its worker says nothing new', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(launchRecord(1, 'running'));
  const callbacks = opened.get(CHILD_SESSION);
  callbacks.onEvent(childThinkingRecord(1));
  callbacks.onCaughtUp();

  const running = coordinator.decorate(parentMessages([launchRecord(1, 'running')]));
  const runningCard = Policy.subagentBranchAt(ui.toConversationUiMessage(running[1]).items || [], 0, SWARM_CALL_ID);
  assert.equal(runningCard.tool.status, 'running', 'the launch is drawn at the status it was recorded with');
  assert.equal((runningCard.subItems || []).length, 1, 'with the one step its worker has published');

  // The launch settles. Its worker publishes no further step, so the launching
  // item's own record is the only thing that changed.
  const settled = coordinator.decorate(parentMessages([launchRecord(1, 'running'), launchRecord(2, 'completed')]));
  const settledCard = Policy.subagentBranchAt(ui.toConversationUiMessage(settled[1]).items || [], 0, SWARM_CALL_ID);
  assert.equal(settledCard.tool.status, 'completed');
  assert.equal((settledCard.subItems || []).length, 1, 'and its worker keeps the branch it already had');
  assert.ok(settled[1].renderVersion > running[1].renderVersion,
    'the card is repainted: a tool item status alone is not part of the row key');

  // A publication that changes nothing is stable: the same version and the same
  // attached branch, or the row would be rebuilt from a message without it.
  const repeated = coordinator.decorate(parentMessages([launchRecord(1, 'running'), launchRecord(2, 'completed')]));
  assert.equal(repeated[1].renderVersion, settled[1].renderVersion);
  assert.equal(((ui.toConversationUiMessage(repeated[1]).items || [])[0].subItems || []).length, 1);
  coordinator.endSession();
});

test('a host that publishes a child inside the parent stream is not drawn twice', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(ownerRecord(1));
  const callbacks = opened.get(CHILD_SESSION);
  childRecords().forEach(event => callbacks.onEvent(event));
  callbacks.onCaughtUp();

  // The same worker's records, restated flat behind the launch and marked, as
  // hosts that inline a subagent's process publish them.
  const inline = record(4, 'child-read', 'tool', 2, {
    toolName: 'Read', toolCall: { id: 'child-read', input: { file_path: 'src/payments.ts' } },
    startTime: 4, status: 'completed', isSubagentItem: true, subagentSessionId: CHILD_SESSION
  });
  const decorated = coordinator.decorate(parentMessages([ownerRecord(1), inline]));
  const items = ui.toConversationUiMessage(decorated[1]).items || [];
  assert.equal((items[0].subItems || []).length, 0,
    'the branch the parent stream already carries is not restated from the child stream');

  const scoped = Policy.scopeSubagentItems(items);
  assert.equal(scoped.length, 1, 'and the parent stream folds that record into the same card');
  assert.equal((scoped[0].subItems || []).length, 1);
  assert.equal(scoped[0].subItems[0].tool.id, 'child-read', 'the one record the parent stream sent');
  coordinator.endSession();
});

test('switching sessions follows the new one and drops the old', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(ownerRecord(1));
  assert.equal(opened.size, 1);

  coordinator.beginSession('another-session');
  assert.ok(harness.closed.includes(CHILD_SESSION), 'the previous session\'s child stream is closed');
  const other = ownerRecord(1, 'other-child', 'AgentSpawn', 'other-call');
  coordinator.observeParentEvent(other);
  assert.ok(opened.has('other-child'), 'and the new session\'s children are followed');
  assert.equal(opened.has(CHILD_SESSION), true, 'only the stream itself was closed');
  coordinator.endSession();
  assert.ok(harness.closed.includes('other-child'));
});

test('the swarm fixture publishes the live record shapes, not a nested invention', () => {
  const ledger = new fixture.SwarmLedger();
  const script = new fixture.SwarmScript(ledger);
  script.drain();

  const parent = ledger.page(fixture.SWARM_PARENT_SESSION, {}).events.map(entry => entry.payload);
  // A launch item is republished as its call settles, so read its latest revision.
  const byCall = new Map();
  parent.filter(entry => entry.item && entry.item.data.toolName === 'AgentSpawn')
    .forEach(entry => byCall.set(entry.item.data.id, entry));
  const launches = Array.from(byCall.values());
  assert.equal(launches.length, 3, 'the parent launches three workers');
  const childSessions = launches.map(entry => entry.item.data.subagentSessionId);
  assert.deepEqual(childSessions,
    [fixture.SWARM_PAYMENTS_SESSION, fixture.SWARM_FLAKY_SESSION, fixture.SWARM_DOCS_SESSION],
    'each launch names the session its worker runs in');
  launches.forEach(launch => {
    assert.deepEqual(Object.keys(launch.item.data.toolCall.input).sort(), ['agent_id', 'agent_type', 'prompt'],
      'with the live input shape, brief and all');
    const table = launch.item.data.toolResult.result;
    assert.match(table, /^agent_id\s+bg_task_id\s+status/,
      'and a result table of the columns the host answers with');
    assert.ok(table.includes(launch.item.data.toolCall.input.agent_id),
      'naming the worker it started');
  });
  const settled = launches.filter(launch => launch.item.data.status === 'completed');
  assert.equal(settled.length, 2, 'two launches settled with a running worker behind them');
  settled.forEach(launch => {
    assert.ok(launch.item.data.toolResult.result.includes('started'),
      'and report the status the host reports for a background worker');
  });
  const failed = launches.filter(launch => launch.item.data.status === 'error');
  assert.equal(failed.length, 1, 'one launch failed, which is what the card colours for');
  assert.equal(failed[0].item.data.toolResult.success, false);

  const parentText = JSON.stringify(parent);
  assert.equal(parentText.includes('"isSubagentItem"'), false,
    'no parent record marks a child: the child is not in this stream at all');
  assert.equal(parentText.includes('"subItems"'), false, 'and nothing is nested inside a parent item');

  childSessions.forEach(sessionId => {
    const events = ledger.page(sessionId, {}).events;
    assert.ok(events.length > 0, `the child session ${sessionId} publishes its own records`);
    const payloads = events.map(entry => entry.payload);
    assert.ok(payloads.every(entry => entry.sessionId === sessionId), 'on its own session id');
    assert.equal(JSON.stringify(payloads).includes('subagentSessionId'), false,
      'with no subagent marker on any child record');
    assert.ok(payloads.some(entry => entry.item && entry.item.data.subagentSessionId === sessionId) === false,
      'and no child record claims a child of its own');
    const names = payloads.filter(entry => entry.item && entry.item.type === 'tool')
      .map(entry => entry.item.data.toolName);
    assert.ok(names.every(name => ['Grep', 'Read', 'ExecCommand'].includes(name)),
      'the child uses the live tool names');
  });
});

test('the swarm fixture streams one worker a page at a time', () => {
  const ledger = new fixture.SwarmLedger();
  const script = new fixture.SwarmScript(ledger);
  const docsItems = () => ledger.page(fixture.SWARM_DOCS_SESSION, {}).events
    .filter(entry => entry.payload.item).length;

  script.advance(); // opening
  script.advance(); // first worker + its history
  script.advance(); // second worker
  script.advance(); // its launch
  const before = docsItems();
  script.advance();
  const after = docsItems();
  assert.ok(after > before, 'a running worker publishes its steps after its launch, not with it');

  const running = ledger.page(fixture.SWARM_DOCS_SESSION, {})
    .events.filter(entry => entry.payload.item && entry.payload.item.data.status === 'running');
  assert.equal(running.length, 0, 'and the fixture has not finished every step it will publish');
  script.drain();
  const settled = ledger.page(fixture.SWARM_DOCS_SESSION, {})
    .events.filter(entry => entry.payload.item && entry.payload.item.data.status === 'running');
  assert.ok(settled.length > 0, 'the last step a live worker published is still in progress');
});

test('a marked record that arrives before its launch is not lost', () => {
  const orphan = { type: 'thinking', is_subagent: true, content: 'first child reasoning' };
  const owner = { type: 'tool', is_subagent: true, tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'running' } };
  const later = { type: 'text', is_subagent: true, content: 'later child output' };
  const scoped = Policy.scopeSubagentItems([orphan, owner, later]);

  assert.equal(scoped.length, 2, 'the early record keeps its own branch');
  const orphanBranch = scoped[0];
  assert.equal(orphanBranch.type, 'thinking');
  assert.equal((orphanBranch.subItems || []).length, 1, 'its content survives as a child, not as parent output');
  assert.equal(orphanBranch.subItems[0].is_subagent, false, 'the inner copy renders as subagent process');
  assert.equal(scoped[1].tool.name, 'AgentSpawn');
  assert.equal((scoped[1].subItems || []).length, 1, 'the later record still joins its launch');
});

test('an orphaned subagent tool still renders inside its own branch', () => {
  const orphanTool = { type: 'tool', is_subagent: true, tool: { id: 'orphan-read', name: 'Read', status: 'running' } };
  const groups = Policy.structuredGroups([orphanTool], 'item', true, 'active');
  assert.equal(groups.length, 1, 'the orphan is drawn');
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].tool.name, 'Read', 'with its tool identity for the card title');
  assert.equal((groups[0].items[0].subItems || []).length, 1, 'and its own process child');
});

test('an orphaned subagent record labels its branch without repeating its own text', () => {
  const orphan = { type: 'thinking', is_subagent: true, content: 'first child reasoning' };
  const branch = Policy.scopeSubagentItems([orphan])[0];

  assert.equal(branch.content, '', 'the branch label does not repeat the step it wraps');
  assert.equal(Policy.subagentBody(branch), '', 'and the branch carries no second copy as its body');
  assert.equal(Policy.subagentTitle(branch), '',
    'with no text left the title falls back to the generic Task name');
  assert.equal((branch.subItems || []).length, 1, 'the step itself survives');
  assert.equal(branch.subItems[0].content, 'first child reasoning', 'and keeps the text as its body');
  assert.equal(branch.subItems[0].is_subagent, false, 'the step renders as content, not as a nested branch');

  const orphanTool = { type: 'tool', is_subagent: true, tool: { id: 'orphan-read', name: 'Read', status: 'running' } };
  const toolBranch = Policy.scopeSubagentItems([orphanTool])[0];
  assert.equal(Policy.subagentTitle(toolBranch), 'Read', 'a tool orphan keeps its tool-derived label');
  assert.equal(toolBranch.subItems[0].tool.name, 'Read', 'and its step is the tool row');
});

test('an unmarked launch with flat marked children is unchanged', () => {
  const owner = { type: 'tool', tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'running' } };
  const children = [
    { type: 'thinking', is_subagent: true, content: 'child reasoning' },
    { type: 'tool', is_subagent: true, tool: { id: 'child-read', name: 'Read', status: 'completed' } }
  ];
  const scoped = Policy.scopeSubagentItems([owner].concat(children));
  assert.equal(scoped.length, 1);
  assert.equal((scoped[0].subItems || []).length, 2);
});

/**
 * The branch view key is what ArkUI keys the card node by, and an unchanged key
 * never re-runs the item builder. The card therefore cannot rely on a rebuild to
 * receive a step that arrives later: it re-reads its branch from the observed
 * message on every render. These tests pin that contract, so a future "fix" that
 * instead churns the key (and so destroys an open branch on every streamed step)
 * fails here.
 */
test('the branch view key stays stable while its child publishes steps', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'running' } };
  const child = { type: 'thinking', is_subagent: true, content: 'child reasoning' };
  const branchKeys = items => Policy.structuredGroups(Policy.scopeSubagentItems(items), 'item', true, 'active')
    .map(group => group.key).join('|');

  assert.equal(branchKeys([owner, child]), branchKeys([owner]),
    'an arriving step must not recreate the branch node that is already open');
});

test('a card re-reads its branch, so a later step reaches the open card', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'running' } };
  const firstStep = { type: 'thinking', is_subagent: true, content: 'step one' };
  const secondStep = { type: 'tool', is_subagent: true, tool: { id: 'child-read', name: 'Read', status: 'running' } };

  // What the frozen item builder captured when the card was first drawn.
  const captured = Policy.structuredGroups([owner], 'item', true, 'active')[0].items[0];
  assert.equal((captured.subItems || []).length, 0, 'a card is born with no process items');

  // What the card reads on every later render, from the transcript as it is now.
  const first = Policy.subagentBranchAt([owner, firstStep], 0, SWARM_CALL_ID);
  assert.equal((first.subItems || []).length, 1, 'the first step is visible');
  const second = Policy.subagentBranchAt([owner, firstStep, secondStep], 0, SWARM_CALL_ID);
  assert.equal((second.subItems || []).length, 2, 'a step published later is visible too');
  assert.equal(second.subItems[1].tool.name, 'Read');
  assert.notEqual(second, captured, 'the stale captured snapshot is not what the card draws');
});

test('a branch is found by its launch tool call and by its render ordinal', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: SWARM_CALL_ID, name: 'AgentSpawn', status: 'running' } };
  const child = { type: 'text', is_subagent: true, content: 'child output' };

  assert.equal(Policy.subagentBranchAt([owner, child], 0, SWARM_CALL_ID).tool.id, SWARM_CALL_ID);
  assert.equal(Policy.subagentBranchAt([owner, child], 0, '').tool.id, SWARM_CALL_ID,
    'the ordinal identifies the branch when the host sent no tool call id');
  assert.equal(Policy.subagentBranchAt([owner, child], 1, SWARM_CALL_ID).tool.id, SWARM_CALL_ID,
    'an unknown ordinal still resolves through the owning tool call');
  assert.equal(Policy.subagentBranchAt([owner, child], 3, ''), undefined,
    'an ordinal with no branch resolves to nothing, so the card keeps its snapshot');
});

test('a branch path reports the ordinal the render path numbered it with', () => {
  assert.equal(Policy.subagentOrdinal('item-subagent-0'), 0);
  assert.equal(Policy.subagentOrdinal('item-subagent-2'), 2);
  assert.equal(Policy.subagentOrdinal('item-subagent-0-adjacent-1'), 0);
  assert.equal(Policy.subagentOrdinal('item-tool-0'), 0);
});

test('the card is fed the branch re-read from the observed message', () => {
  const card = fs.readFileSync(path.join(ROOT, 'pages/components/SubagentTaskCard.ets'), 'utf8');
  assert.match(card, /@Param items: ConversationUiMessageItem\[\]/,
    'the card takes the branch process items as its param');

  const bubble = fs.readFileSync(path.join(ROOT, 'pages/components/ChatMessageBubble.ets'), 'utf8');
  assert.match(bubble, /items: this\.currentSubagentBranch\(entry, path\)\.subItems/,
    'the bubble re-resolves the branch on every render instead of using the captured entry');
  assert.match(bubble, /ChatMessageStructurePolicy\.subagentBranchAt\(/,
    'the re-resolution goes through the shared policy');
});

test('the controller reads the launch record for the child session it names', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'services/ChatSessionController.ets'), 'utf8');
  assert.match(controller, /this\.subagents\.observeParentEvent\(event\)/,
    'the parent stream is where a child session is discovered');
  assert.match(controller, /this\.subagents\.decorate\(this\.reducer\.messages\(\)\)/,
    'and the branch is attached on the one path that publishes the transcript');
  assert.match(controller, /this\.subagents\.beginSession\(sessionId\)/,
    'a session switch rebinds the follow set');
  assert.match(controller, /this\.subagents\.endSession\(\)/,
    'and closing the session closes the streams it opened');
});
