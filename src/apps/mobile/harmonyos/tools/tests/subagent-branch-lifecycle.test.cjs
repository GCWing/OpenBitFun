const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const COMPONENTS = path.join(ROOT, 'pages/components');
const STATE = path.join(ROOT, 'pages/state');
const cache = new Map();

/** The session-scoped logger, whose own platform kit is not reachable here. */
const LOGGER = { RemoteLogger: { info() {}, warn() {}, error() {}, debug() {} } };

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
    if (!name.startsWith('.')) return {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name))
      .split(path.sep).join('/');
    if (target === 'services/RemoteLogger') return LOGGER;
    return fs.existsSync(path.join(ROOT, `${target}.ets`)) ? load(target) : {};
  }, exported);
  return exported;
}

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const { DurableSessionReducer } = load('services/DurableSessionReducer');
const { SubagentStreamCoordinator } = load('services/SubagentStreamCoordinator');
const { SubagentBranchExpansionState } = load('pages/state/SubagentBranchExpansionState');
const ui = load('pages/state/ConversationUiModels');
const { ChatMessageStructurePolicy: Policy } = load('pages/policy/ChatMessageStructurePolicy');
const fixture = load('pages/preview/SubagentSwarmFixture');

const SESSION = fixture.SWARM_PARENT_SESSION;
const CHILD_SESSION = fixture.SWARM_DOCS_SESSION;

/** The follow cap the coordinator enforces, read from the constant that states it. */
const CAP = Number(/MAX_CONCURRENT_CHILD_STREAMS: number = (\d+)/.exec(
  source('services/SubagentStreamCoordinator.ets'))[1]);
/** How long the coordinator holds a branch's transcript write back, in milliseconds. */
const FLUSH_MS = Number(/BRANCH_CACHE_FLUSH_MS: number = (\d+)/.exec(
  source('services/SubagentStreamCoordinator.ets'))[1]);

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

/** A launch item as the host records it: the child Session id is the whole link. */
function launchRecord(revision, status, toolId = 'swarm-docs-spawn', sessionId = CHILD_SESSION, roundIndex = 0) {
  const parent = record(revision, toolId, 'tool', roundIndex, {
    toolName: 'AgentSpawn',
    toolCall: { id: toolId, input: { agent_id: 'swarm-docs', agent_type: 'Explore', prompt: 'Audit it' } },
    startTime: 3,
    status,
    subagentSessionId: sessionId
  });
  // A launch is republished as its call settles, and what it is republished in is
  // the round the host is in when it settles — which is how a settled launch ends
  // up among the parent rows that follow it.
  parent.payload.round = {
    id: `round-${roundIndex}`, turnId: 'turn', roundIndex, timestamp: 2, status: 'inprogress'
  };
  parent.payload.item.data.orderIndex = roundIndex;
  return parent;
}

/** An ordinary row of the parent's own work, in the round the host published it. */
function parentToolRecord(revision, toolId, name, order, roundIndex) {
  const parent = record(revision, toolId, 'tool', order, {
    toolName: name,
    toolCall: { id: toolId, input: { pattern: 'swarm', path: 'src/agents' } },
    toolResult: { result: 'src/agents/swarm.ts', success: true },
    startTime: 3,
    status: 'completed'
  });
  parent.payload.round = {
    id: `round-${roundIndex}`, turnId: 'turn', roundIndex, timestamp: 2, status: 'inprogress'
  };
  return parent;
}

/** One worker the wide delegation launched, all of them running at once. */
function wideLaunchRecord(index) {
  return launchRecord(1, 'completed', fixture.wideSpawnId(index), fixture.wideChildSession(index));
}

function childThinkingRecord(revision, sessionId = CHILD_SESSION) {
  return record(revision, 'child-think', 'thinking', 1, { content: 'Reading the module' }, sessionId);
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

/** The child's own turn record at a new revision: where a turn's outcome lands. */
function childTurnSettle(revision, status, sessionId = CHILD_SESSION) {
  return {
    session_id: sessionId,
    event: 'session-record',
    payload: {
      sessionId, id: 'turn/turn', revision,
      turn: {
        turnId: 'turn', turnIndex: 0, sessionId, timestamp: 1,
        userMessage: { id: 'user', content: 'the brief', timestamp: 1 },
        status
      }
    }
  };
}

const childRecords = () => [childThinkingRecord(1), childToolRecord(2), childTextRecord(3)];

/** A parent transcript holding the records, as the reducer projects it. */
function parentMessages(records) {
  const reducer = new DurableSessionReducer();
  records.forEach(event => reducer.apply(event));
  return reducer.messages();
}

/**
 * A coordinator over stub streams, keeping the callbacks it registered.
 *
 * Nothing here is a fixture-shaped shortcut: the coordinator opens a stream per
 * child exactly as it does in the app, and the callbacks it is handed are the
 * ones a host's pages would drive.
 */
function coordinatorHarness(options = {}) {
  const opened = new Map();
  const live = new Set();
  const closed = [];
  const errors = [];
  let notifications = 0;
  const coordinator = new SubagentStreamCoordinator({
    subscribeSession: (sessionId, callbacks) => {
      if (options.refuses) throw new Error(`no stream for ${sessionId}`);
      opened.set(sessionId, callbacks);
      live.add(sessionId);
      return {
        close: () => { closed.push(sessionId); live.delete(sessionId); },
        wake: () => {}, loadOlder: () => {}, isClosed: () => false
      };
    }
  }, () => { notifications++; }, error => errors.push(error), options.branchCache);
  return {
    coordinator, opened, live, closed, errors,
    open: () => Array.from(live.keys()),
    notifications: () => notifications
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function until(predicate, label, attempts = 400) {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** The card the bubble would draw for one launch, read through the shared policy. */
function cardFor(coordinator, records, toolId) {
  const decorated = coordinator.decorate(parentMessages(records));
  const items = ui.toConversationUiMessage(decorated[1]).items || [];
  const card = Policy.subagentBranchAt(items, 0, toolId);
  assert.ok(card, `the branch ${toolId} is found by the launch tool call`);
  return card;
}

/** The ordered group keys of one assistant frame: what a structured rebuild keys on. */
function frameGroups(coordinator, records) {
  const decorated = coordinator.decorate(parentMessages(records));
  const items = ui.toConversationUiMessage(decorated[1]).items || [];
  return Policy.structuredGroups(items, 'item', true, 'active').map(group => group.key).join('|');
}

/** The phone's transcript store, in memory: what a restart reads from. */
class FakeBranchCache {
  constructor() {
    this.stored = new Map();
    this.writes = 0;
  }

  async loadBranch(sessionId) {
    const stored = this.stored.get(sessionId);
    return stored === undefined ? [] : JSON.parse(JSON.stringify(stored));
  }

  async saveBranch(sessionId, messages) {
    this.writes++;
    // Stored as plain rows, which is what the real store does: a branch that
    // only survives in memory is exactly what this cache exists to replace.
    this.stored.set(sessionId, JSON.parse(JSON.stringify(messages)));
  }
}

// ── The disclosure outlives the row it was opened in ────────────────────────

test('a branch disclosure is kept per branch, not per render pass', () => {
  const expansion = new SubagentBranchExpansionState();
  assert.equal(expansion.isExpanded('swarm-docs-spawn'), false, 'a branch starts closed');

  assert.equal(expansion.toggle('swarm-docs-spawn'), true, 'opening answers the new state');
  assert.equal(expansion.isExpanded('swarm-docs-spawn'), true);
  assert.equal(expansion.isExpanded('swarm-payments-spawn'), false,
    'another branch is not opened by it');

  assert.equal(expansion.toggle('swarm-docs-spawn'), false, 'closing answers the new state');
  assert.equal(expansion.isExpanded('swarm-docs-spawn'), false);

  expansion.setExpanded('swarm-docs-spawn', true);
  assert.equal(expansion.isExpanded('swarm-docs-spawn'), true, 'the owner can set it directly');
  assert.equal(expansion.toggle(''), false, 'a branch with no identity has no disclosure');
  assert.equal(expansion.isExpanded(''), false);
});

test('the disclosure survives the row being rebuilt around it', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(launchRecord(1, 'running'));
  const callbacks = opened.get(CHILD_SESSION);
  callbacks.onEvent(childThinkingRecord(1));
  callbacks.onCaughtUp();

  // The parent's own rows, published while its worker runs.
  const parentRows = [
    parentToolRecord(1, 'swarm-parent-grep', 'Grep', 0, 5),
    parentToolRecord(1, 'swarm-parent-read', 'Read', 1, 5)
  ];
  const before = [launchRecord(1, 'running', 'swarm-docs-spawn', CHILD_SESSION, 0), ...parentRows];
  const card = cardFor(coordinator, before, 'swarm-docs-spawn');
  // The reader opens the card: the same key the card reads and writes.
  const expansion = new SubagentBranchExpansionState();
  expansion.toggle(card.tool.id);
  assert.equal(expansion.isExpanded(card.tool.id), true);

  // The launch settles in a later round. The launch item is republished in the
  // round the host is in when its call returns, so it lands after the parent rows
  // that followed it: the structured groups of the frame reorder, and the whole
  // keyed subtree below the row — the card included — is rebuilt with them.
  const settled = [launchRecord(2, 'completed', 'swarm-docs-spawn', CHILD_SESSION, 5), ...parentRows];
  assert.notEqual(frameGroups(coordinator, settled), frameGroups(coordinator, before),
    'the frame is rebuilt at that moment');
  assert.ok(frameGroups(coordinator, before).indexOf('subagent') <
    frameGroups(coordinator, before).indexOf('tool'),
    'the card was drawn above the parent rows before the settle');
  assert.ok(frameGroups(coordinator, settled).indexOf('subagent') >
    frameGroups(coordinator, settled).indexOf('tool'),
    'and below them after it');

  const settledCard = cardFor(coordinator, settled, 'swarm-docs-spawn');
  assert.equal(settledCard.tool.id, card.tool.id,
    'the branch is the same branch: its identity is the launch, not the render path');
  assert.equal(expansion.isExpanded(settledCard.tool.id), true,
    'and the card the rebuild draws is still the one the reader opened');
  assert.equal(harness.notifications() > 0, true, 'the settle republished the parent transcript');
  coordinator.endSession();
});

test('the card reads and writes the conversation\'s disclosure, and owns none', () => {
  const card = source('pages/components/SubagentTaskCard.ets');
  assert.match(card, /@Param expansion: SubagentBranchExpansionState/,
    'the disclosure is a param, so the conversation owns it');
  assert.doesNotMatch(card, /@Local expanded/,
    'a disclosure kept in the card is lost the moment the row is rebuilt');
  assert.match(card, /this\.expansion\.isExpanded\(this\.branchKey\(\)\)/,
    'the card reads it through the branch key');
  assert.match(card, /this\.expansion\.toggle\(this\.branchKey\(\)\)/,
    'and writes it back through the same key');
  assert.match(source('pages/state/SubagentBranchExpansionState.ets'), /@Trace expanded: boolean/,
    'the disclosure is traced, so opening it repaints the card that reads it');

  const timeline = source('pages/components/ChatTimeline.ets');
  assert.equal((timeline.match(/subagentBranches: this\.subagentBranches/g) || []).length, 3,
    'the pane hands the disclosure to the list, and the list to both row call sites');

  const bubble = source('pages/components/ChatMessageBubble.ets');
  assert.match(bubble, /branchId: entry\.tool\?\.id \|\| ''/,
    'the bubble keys the card by the tool call that launched it');
  assert.match(bubble, /expansion: this\.subagentBranches/);

  const view = source('pages/components/ConversationView.ets');
  assert.match(view, /subagentBranches: this\.state\.subagentBranches/,
    'the conversation view passes the state it projects');
  assert.match(source('pages/state/ConversationViewState.ets'),
    /state\.subagentBranches = core\.subagentBranches/,
    'and the projection carries the owner\'s instance rather than a fresh one');
  assert.match(source('pages/state/ConversationCoreState.ets'),
    /readonly subagentBranches: SubagentBranchExpansionState/,
    'which is owned by the conversation itself');
});

// ── A session follows a bounded number of its children ──────────────────────

test('a session follows no more of its children than the cap allows', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  for (let index = 0; index < CAP + 2; index++) coordinator.observeParentEvent(wideLaunchRecord(index));

  const state = coordinator.followState();
  assert.equal(state.branches, CAP + 2, 'every worker keeps its own branch');
  assert.equal(state.subscribed, CAP, 'but only the cap of them hold a stream');
  assert.equal(state.waiting, 2, 'and the two that lost a slot are waiting for one');

  const followed = harness.open();
  assert.deepEqual(followed, Array.from({ length: CAP }, (_entry, index) => fixture.wideChildSession(index + 2)),
    'the workers that just started stay followed, and the oldest ones wait');
  assert.deepEqual(harness.closed, [fixture.wideChildSession(0), fixture.wideChildSession(1)],
    'nothing is released that has not already published what it published');
  coordinator.endSession();
});

test('a card the reader opens takes a slot back for its worker', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  for (let index = 0; index < CAP + 2; index++) coordinator.observeParentEvent(wideLaunchRecord(index));
  const before = coordinator.followState();

  // The reader opens the card of the first worker, whose stream was released
  // when the delegation grew past the cap.
  coordinator.ensureSubscribed(fixture.wideSpawnId(0));

  const after = coordinator.followState();
  assert.equal(opened.has(fixture.wideChildSession(0)), true, 'the opened worker is followed again');
  assert.equal(after.subscribed, before.subscribed, 'still inside the cap');
  assert.equal(after.waiting, before.waiting, 'and still the same number of workers want a slot');
  assert.equal(harness.closed.filter(id => id === fixture.wideChildSession(0)).length, 1,
    'its earlier stream was closed, not duplicated');

  // Following a worker that already holds a stream is a no-op.
  const streams = Array.from(opened.keys()).length;
  coordinator.ensureSubscribed(fixture.wideSpawnId(0));
  assert.equal(Array.from(opened.keys()).length, streams, 're-attaching twice opens nothing twice');
  coordinator.endSession();
});

test('a worker that reported hands its slot to one that is still working', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  for (let index = 0; index < CAP + 2; index++) coordinator.observeParentEvent(wideLaunchRecord(index));
  const working = fixture.wideChildSession(2);
  assert.equal(opened.has(working), true, 'the third worker is followed');

  // It answers: its turn settles, which is the one change that needs no step.
  // The child's first page has to have landed for its turn to be readable.
  const callbacks = opened.get(working);
  callbacks.onCaughtUp();
  callbacks.onEvent(childTurnSettle(9, 'completed', working));

  const state = coordinator.followState();
  assert.equal(state.subscribed, CAP, 'the slot it held is taken again immediately');
  assert.equal(state.waiting, 1, 'and the worker that was waiting longest is no longer waiting');
  assert.ok(harness.open().includes(fixture.wideChildSession(1)), 'it is the one that was served');
  coordinator.endSession();
});

// ── What a worker published outlives the launch of the app ──────────────────

test('a worker already read is still there after a restart', async () => {
  const branchCache = new FakeBranchCache();
  const first = coordinatorHarness({ branchCache });
  first.coordinator.beginSession(SESSION);
  first.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  const callbacks = first.opened.get(CHILD_SESSION);
  childRecords().forEach(event => callbacks.onEvent(event));
  callbacks.onCaughtUp();
  first.coordinator.endSession(); // the session closes: what the child published is written now
  await until(() => branchCache.stored.has(CHILD_SESSION), 'the child transcript to be stored');

  const stored = branchCache.stored.get(CHILD_SESSION);
  assert.deepEqual(stored.filter(message => message.role === 'assistant').length, 1,
    'the stored rows are the worker\'s own transcript');
  assert.equal(branchCache.writes, 1, 'and it was written once, under the child Session id');
  assert.equal(stored[0].id, 'user', 'the brief the worker was spawned with is part of it');

  // A phone that just started: the same session, and a child whose stream has
  // not answered yet. Everything that is drawn now came out of the cache above.
  const cold = coordinatorHarness({ branchCache });
  cold.coordinator.beginSession(SESSION);
  cold.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  assert.equal(cold.coordinator.followState().restored, 0, 'nothing is drawn before the read lands');
  await until(() => cold.coordinator.followState().restored === 3, 'the branch to be restored');

  const card = cardFor(cold.coordinator, [launchRecord(1, 'completed')], 'swarm-docs-spawn');
  assert.deepEqual((card.subItems || []).map(child => child.type), ['thinking', 'tool', 'text'],
    'the worker\'s steps are drawn from the transcript the phone stored');
  assert.equal(card.subItems[1].tool.name, 'Read', 'with the shapes a live branch draws');
  cold.coordinator.endSession();
});

test('a worker that published before a restart is not drawn twice after one', async () => {
  const branchCache = new FakeBranchCache();
  const first = coordinatorHarness({ branchCache });
  first.coordinator.beginSession(SESSION);
  first.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  childRecords().forEach(event => first.opened.get(CHILD_SESSION).onEvent(event));
  first.coordinator.endSession();
  await until(() => branchCache.stored.has(CHILD_SESSION), 'the child transcript to be stored');

  const cold = coordinatorHarness({ branchCache });
  cold.coordinator.beginSession(SESSION);
  cold.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  await until(() => cold.coordinator.followState().restored === 3, 'the branch to be restored');

  // The host replays the child from its own start, which restates every step the
  // cache already holds, and only then publishes what happened while the phone
  // was closed.
  const replayed = cold.opened.get(CHILD_SESSION);
  replayed.onCaughtUp();
  childRecords().forEach(event => replayed.onEvent(event));
  const settled = childToolRecord(4);
  settled.payload.item.data.status = 'failed';
  replayed.onEvent(settled);
  replayed.onEvent(childTurnSettle(9, 'completed'));

  const card = cardFor(cold.coordinator, [launchRecord(1, 'completed')], 'swarm-docs-spawn');
  assert.deepEqual((card.subItems || []).map(child => child.type), ['thinking', 'tool', 'text'],
    'the replay restates steps instead of adding them');
  assert.equal(card.subItems[1].tool.status, 'failed',
    'and a step that changed while the app was closed shows its newer state');
  assert.equal(cold.coordinator.followState().restored, 3, 'the restored prefix is what it was');
  assert.equal(card.tool.status, 'completed',
    'the worker reported before the restart, and its card says so without a stream');
  cold.coordinator.endSession();
});

test('a worker still running before a restart is not reported as finished after one', async () => {
  const branchCache = new FakeBranchCache();
  const first = coordinatorHarness({ branchCache });
  first.coordinator.beginSession(SESSION);
  first.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  childRecords().forEach(event => first.opened.get(CHILD_SESSION).onEvent(event));
  first.coordinator.endSession();
  await until(() => branchCache.stored.has(CHILD_SESSION), 'the child transcript to be stored');

  const cold = coordinatorHarness({ branchCache });
  cold.coordinator.beginSession(SESSION);
  cold.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  await until(() => cold.coordinator.followState().restored === 3, 'the branch to be restored');
  // The child's stream answers nothing: this is the whole reading there is.
  cold.opened.get(CHILD_SESSION).onCaughtUp();
  assert.equal(cardFor(cold.coordinator, [launchRecord(1, 'completed')], 'swarm-docs-spawn').tool.status,
    'running', 'a turn that never ended is still running, cache or no cache');
  cold.coordinator.endSession();
});

test('a stored outcome does not settle a worker whose stream has not answered', async () => {
  const branchCache = new FakeBranchCache();
  const first = coordinatorHarness({ branchCache });
  first.coordinator.beginSession(SESSION);
  first.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  const settled = first.opened.get(CHILD_SESSION);
  childRecords().forEach(event => settled.onEvent(event));
  settled.onCaughtUp();
  settled.onEvent(childTurnSettle(9, 'completed'));
  first.coordinator.endSession();
  await until(() => branchCache.stored.has(CHILD_SESSION), 'the child transcript to be stored');

  // A phone that just started: the stored transcript says this worker finished,
  // and the worker has been handed another turn since.
  const cold = coordinatorHarness({ branchCache });
  cold.coordinator.beginSession(SESSION);
  cold.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  await until(() => cold.coordinator.followState().restored === 3, 'the branch to be restored');
  assert.equal(cold.coordinator.followState().subscribed, 1,
    'the stored outcome does not release the stream: only this child can say what it is doing');
  const cardStatus = () => cardFor(cold.coordinator, [launchRecord(1, 'completed')], 'swarm-docs-spawn').tool.status;
  assert.equal(cardStatus(), 'running',
    'a worker whose stream has not answered yet is not reported as finished');

  // The stream catches up and says nothing: the host holds no more of this
  // child, so the outcome the phone stored is the reading that stands.
  const live = cold.opened.get(CHILD_SESSION);
  live.onCaughtUp();
  assert.equal(cardStatus(), 'completed', 'and a stored outcome is what the card falls back to');
  assert.equal(cold.coordinator.followState().subscribed, 1, 'still followed, so it can still correct it');

  // The host does answer after all, with the turn the worker is running now.
  live.onEvent(childTurnSettle(10, 'inprogress'));
  assert.equal(cardStatus(), 'running',
    'and a worker that is working right now is reported as working, not as it was stored');
  cold.coordinator.endSession();
});

test('the branch cache is written at most once per interval while a worker streams', async () => {
  const branchCache = new FakeBranchCache();
  const harness = coordinatorHarness({ branchCache });
  harness.coordinator.beginSession(SESSION);
  harness.coordinator.observeParentEvent(launchRecord(1, 'completed'));
  const callbacks = harness.opened.get(CHILD_SESSION);
  childRecords().forEach(event => callbacks.onEvent(event));
  callbacks.onCaughtUp();
  assert.equal(branchCache.writes, 0, 'a streaming worker does not rewrite its transcript per step');

  await until(() => branchCache.writes === 1, 'the first write', Math.ceil(FLUSH_MS / 5) + 200);
  assert.equal(branchCache.writes, 1, 'and the write holds the rest of the interval back');
  harness.coordinator.endSession();
  await flush();
  assert.equal(branchCache.writes, 2, 'closing the session writes what is there, once more');
});

test('a worker that is launched again after it settled is followed again', () => {
  const harness = coordinatorHarness();
  const { coordinator, opened } = harness;
  coordinator.beginSession(SESSION);
  coordinator.observeParentEvent(launchRecord(1, 'completed'));
  const first = opened.get(CHILD_SESSION);
  childRecords().forEach(event => first.onEvent(event));
  first.onCaughtUp();
  first.onEvent(childTurnSettle(4, 'completed'));

  assert.equal(coordinator.followState().subscribed, 0,
    'the worker reported, so its stream was released and its branch kept');

  // The same worker is launched again: a new tool call, the same child Session.
  coordinator.observeParentEvent(launchRecord(5, 'completed', 'swarm-docs-resume'));
  assert.equal(coordinator.followState().branches, 1, 'it is one branch, not two');
  assert.equal(coordinator.followState().subscribed, 1, 'and it is followed again');
  const resumed = opened.get(CHILD_SESSION);
  assert.equal(resumed === first, false, 'which is a fresh stream, not the released one');

  // The turn it is taking now arrives as a running turn of the same child.
  resumed.onCaughtUp();
  resumed.onEvent(childRecords()[2]);
  resumed.onEvent(childTurnSettle(6, 'inprogress'));
  const live = cardFor(coordinator, [launchRecord(5, 'completed', 'swarm-docs-resume')], 'swarm-docs-resume');
  assert.equal(live.tool.status, 'running',
    'the card of the launch that is happening now reports the worker, not the launch');
  assert.equal((live.subItems || []).length > 0, true, 'and it draws the worker it launched');

  // The same launch republished by every poll is not a reason to take a slot.
  const streams = coordinator.followState().subscribed;
  coordinator.observeParentEvent(launchRecord(5, 'completed', 'swarm-docs-resume'));
  assert.equal(coordinator.followState().subscribed, streams, 'the same launch changes nothing');
  assert.equal(opened.get(CHILD_SESSION) === resumed, true, 'and opens no second stream');

  // It reports again: the branch settles at the newer turn's outcome.
  resumed.onEvent(childTurnSettle(7, 'completed'));
  const settled = cardFor(coordinator, [launchRecord(5, 'completed', 'swarm-docs-resume')], 'swarm-docs-resume');
  assert.equal(settled.tool.status, 'completed', 'and a finished worker reads as finished');
  coordinator.endSession();
});
