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
const { ChatTimelineRowStore } = load('model/ChatTimelineModels');
const ui = load('pages/state/ConversationUiModels');
const { ChatMessageStructurePolicy: Policy } = load('pages/policy/ChatMessageStructurePolicy');

const SESSION = 'session';
const TURN = 'turn';
const CHILD_SESSION = 'child-session';
const TASK_CALL_ID = 'task_call_1';

/** One durable session-record event exactly as the host publishes it. */
function record(revision, id, type, order, data) {
  return {
    session_id: SESSION,
    event: 'session-record',
    payload: {
      sessionId: SESSION,
      id: `item/${id}`,
      revision,
      turn: {
        turnId: TURN, turnIndex: 0, sessionId: SESSION, timestamp: 1,
        userMessage: { id: 'user', content: 'run the audit', timestamp: 1 },
        status: 'inprogress'
      },
      round: { id: 'round', turnId: TURN, roundIndex: 0, timestamp: 2, status: 'inprogress' },
      item: { type, data: Object.assign({ id, orderIndex: order, timestamp: 3 }, data) }
    }
  };
}

/**
 * The owner Task tool record.
 *
 * The host records the child Session id on the Task tool item — the durable
 * record contract is `is_subagent_item` / `subagent_session_id` on the item
 * data in `src/crates/services/services-core/src/session/types.rs`, published
 * as `isSubagentItem` / `subagentSessionId` — and every mobile client maps that
 * field onto the subagent marker (`DurableSessionReducer.ets:157`), so the
 * owner Task arrives marked exactly like the records it owns.
 */
function ownerTaskRecord(revision) {
  return record(revision, TASK_CALL_ID, 'tool', 0, {
    toolName: 'Task',
    toolCall: { id: TASK_CALL_ID, input: { description: 'Audit the payment module', subagent_type: 'Explore' } },
    startTime: 3,
    status: 'running',
    subagentSessionId: CHILD_SESSION
  });
}

function childThinkingRecord(revision) {
  return record(revision, 'child-think', 'thinking', 1, {
    content: 'Reading the payment module', subagentSessionId: CHILD_SESSION
  });
}

function childToolRecord(revision) {
  return record(revision, 'child-tool', 'tool', 2, {
    toolName: 'Read',
    toolCall: { id: 'child-read', input: { path: 'src/payments.ts' } },
    startTime: 4,
    status: 'completed',
    subagentSessionId: CHILD_SESSION
  });
}

function childTextRecord(revision) {
  return record(revision, 'child-text', 'text', 3, {
    content: 'Found no hard-coded keys', subagentSessionId: CHILD_SESSION
  });
}

/** Every record a running Task publishes, in host order. */
function runningTaskRecords() {
  return [
    ownerTaskRecord(1),
    childThinkingRecord(2),
    childToolRecord(3),
    childTextRecord(4)
  ];
}

async function timelineHarness() {
  const timeline = new ChatTimelineStore();
  timeline.reset(SESSION);
  let stream;
  const controller = new ChatSessionController({
    getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }),
    subscribeSession: (_id, callbacks) => {
      stream = callbacks;
      return { wake() {}, close() {} };
    }
  }, {
    onSnapshot: snapshot => timeline.applySnapshot(snapshot),
    canPoll: () => true,
    onError: error => { throw error; }
  });
  controller.start(SESSION, { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await stream.onCaughtUp();
  for (const event of runningTaskRecords()) await stream.onEvent(event);
  return { timeline, stream, controller };
}

/**
 * The production chain the live assistant row walks: durable records -> timeline
 * store -> projector -> keyed V2 rows -> conversation UI DTO -> grouped render
 * model. Returns the Task card the bubble would draw.
 */
function taskCardFromActiveTurn(timeline) {
  const rows = new ChatTimelineRowStore().reconcile(timeline.project(false));
  const liveRow = rows.find(row => row.type === 'assistant_live_turn');
  assert.ok(liveRow, 'the running turn is projected as a live assistant row');
  const message = ui.toConversationUiMessage(liveRow.message);
  const groups = Policy.structuredGroups(message.items || [], 'item', true, message.status || 'active');
  const cards = groups
    .filter(group => group.type === 'item' && group.items.length === 1)
    .map(group => group.items[0])
    .filter(entry => entry.tool && entry.tool.name === 'Task');
  assert.equal(cards.length, 1, 'exactly one Task card is drawn for one Task tool call');
  return { message, card: cards[0], groups };
}

test('a running Task card receives the subagent process published flat behind it', async () => {
  const { timeline, controller } = await timelineHarness();
  const { card } = taskCardFromActiveTurn(timeline);

  assert.equal((card.subItems || []).length, 3, 'thinking, tool and text are Task children');
  assert.deepEqual((card.subItems || []).map(child => child.type), ['thinking', 'tool', 'text']);
  assert.equal(card.subItems[0].content, 'Reading the payment module');
  assert.equal(card.subItems[1].tool.name, 'Read');
  assert.equal(card.subItems[2].content, 'Found no hard-coded keys');
  controller.stop();
});

test('the subagent process never leaks into the parent transcript as sibling rows', async () => {
  const { timeline, controller } = await timelineHarness();
  const { message, groups } = taskCardFromActiveTurn(timeline);

  const siblingTypes = groups.flatMap(group => group.items.concat(group.tools.map(tool => ({ type: 'tool', tool }))))
    .filter(entry => entry.type !== 'tool' || !entry.tool || entry.tool.name !== 'Task')
    .map(entry => entry.type);
  assert.deepEqual(siblingTypes, [], 'only the Task card represents the running subagent');
  assert.equal(message.text, '', 'the subagent answer is not the parent answer');
  assert.equal(message.thinking, '', 'the subagent reasoning is not the parent reasoning');
  controller.stop();
});

test('the subagent process stays visible after the turn completes', async () => {
  const { timeline, stream, controller } = await timelineHarness();
  const finished = ownerTaskRecord(5);
  finished.payload.item.data.status = 'completed';
  finished.payload.turn.status = 'completed';
  await stream.onEvent(finished);

  const assistant = timeline.snapshot().persistedMessages.find(row => row.role === 'assistant');
  assert.ok(assistant, 'the completed turn is persisted');
  const message = ui.toConversationUiMessage(assistant);
  const groups = Policy.structuredGroups(message.items || [], 'item', false, message.status || 'done');
  const card = groups.map(group => group.items[0]).find(entry => entry.tool && entry.tool.name === 'Task');
  assert.ok(card, 'the Task card survives completion');
  assert.equal((card.subItems || []).length, 3, 'its process stays under it');
  controller.stop();
});

test('an owner Task marked as a subagent is still the branch owner', () => {
  const task = {
    type: 'tool',
    is_subagent: true,
    tool: { id: TASK_CALL_ID, name: 'Task', status: 'running', tool_input: { description: 'Audit' } }
  };
  const children = [
    { type: 'thinking', is_subagent: true, content: 'child reasoning' },
    { type: 'tool', is_subagent: true, tool: { id: 'child-read', name: 'Read', status: 'running' } },
    { type: 'text', is_subagent: true, content: 'child output' }
  ];
  const scoped = Policy.scopeSubagentItems([task].concat(children));
  assert.equal(scoped.length, 1, 'the marked children fold into the marked owner Task');
  assert.equal((scoped[0].subItems || []).length, 3);
});

test('every Task name variant the host can send opens the branch', () => {
  for (const name of ['Task', 'task', 'TASK', ' Task ', 'Task']) {
    const task = { type: 'tool', tool: { id: 'call', name, status: 'running' } };
    const child = { type: 'text', is_subagent: true, content: 'child output' };
    const scoped = Policy.scopeSubagentItems([task, child]);
    assert.equal((scoped[0].subItems || []).length, 1, `Task name ${JSON.stringify(name)} owns the child`);
  }
});

test('a marked record that arrives before its Task is not lost', () => {
  const orphan = { type: 'thinking', is_subagent: true, content: 'first child reasoning' };
  const task = { type: 'tool', is_subagent: true, tool: { id: TASK_CALL_ID, name: 'Task', status: 'running' } };
  const later = { type: 'text', is_subagent: true, content: 'later child output' };
  const scoped = Policy.scopeSubagentItems([orphan, task, later]);

  assert.equal(scoped.length, 2, 'the early record keeps its own branch');
  const orphanBranch = scoped[0];
  assert.equal(orphanBranch.type, 'thinking');
  assert.equal((orphanBranch.subItems || []).length, 1, 'its content survives as a child, not as parent output');
  assert.equal(orphanBranch.subItems[0].is_subagent, false, 'the inner copy renders as subagent process');
  assert.equal(scoped[1].tool.name, 'Task');
  assert.equal((scoped[1].subItems || []).length, 1, 'the later record still joins its Task');
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

test('an unmarked Task with flat marked children is unchanged', () => {
  const task = { type: 'tool', tool: { id: TASK_CALL_ID, name: 'Task', status: 'running' } };
  const children = [
    { type: 'thinking', is_subagent: true, content: 'child reasoning' },
    { type: 'tool', is_subagent: true, tool: { id: 'child-read', name: 'Read', status: 'completed' } }
  ];
  const scoped = Policy.scopeSubagentItems([task].concat(children));
  assert.equal(scoped.length, 1);
  assert.equal((scoped[0].subItems || []).length, 2);
});

/**
 * The branch view key is what ArkUI keys the Task card node by, and an unchanged
 * key never re-runs the item builder. The card therefore cannot rely on a
 * rebuild to receive a step that arrives later: it re-reads its branch from the
 * observed message on every render. These tests pin that contract, so a future
 * "fix" that instead churns the key (and so destroys an open branch on every
 * streamed step) fails here.
 */
test('the Task branch view key stays stable while its subagent publishes steps', () => {
  const task = { type: 'tool', tool: { id: TASK_CALL_ID, name: 'Task', status: 'running' } };
  const child = { type: 'thinking', is_subagent: true, content: 'child reasoning' };
  const branchKeys = items => Policy.structuredGroups(Policy.scopeSubagentItems(items), 'item', true, 'active')
    .map(group => group.key).join('|');

  assert.equal(branchKeys([task, child]), branchKeys([task]),
    'an arriving step must not recreate the branch node that is already open');
});

test('a card re-reads its branch, so a later step reaches the open card', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: TASK_CALL_ID, name: 'Task', status: 'running' } };
  const firstStep = { type: 'thinking', is_subagent: true, content: 'step one' };
  const secondStep = { type: 'tool', is_subagent: true, tool: { id: 'child-read', name: 'Read', status: 'running' } };

  // What the frozen item builder captured when the Task card was first drawn.
  const captured = Policy.structuredGroups([owner], 'item', true, 'active')[0].items[0];
  assert.equal((captured.subItems || []).length, 0, 'a Task card is born with no process items');

  // What the card reads on every later render, from the transcript as it is now.
  const first = Policy.subagentBranchAt([owner, firstStep], 0, TASK_CALL_ID);
  assert.equal((first.subItems || []).length, 1, 'the first step is visible');
  const second = Policy.subagentBranchAt([owner, firstStep, secondStep], 0, TASK_CALL_ID);
  assert.equal((second.subItems || []).length, 2, 'a step published later is visible too');
  assert.equal(second.subItems[1].tool.name, 'Read');
  assert.notEqual(second, captured, 'the stale captured snapshot is not what the card draws');
});

test('a branch is found by its Task tool call and by its render ordinal', () => {
  const owner = { type: 'tool', is_subagent: true, tool: { id: TASK_CALL_ID, name: 'Task', status: 'running' } };
  const child = { type: 'text', is_subagent: true, content: 'child output' };

  assert.equal(Policy.subagentBranchAt([owner, child], 0, TASK_CALL_ID).tool.id, TASK_CALL_ID);
  assert.equal(Policy.subagentBranchAt([owner, child], 0, '').tool.id, TASK_CALL_ID,
    'the ordinal identifies the branch when the host sent no tool call id');
  assert.equal(Policy.subagentBranchAt([owner, child], 1, TASK_CALL_ID).tool.id, TASK_CALL_ID,
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

test('the Task card is fed the branch re-read from the observed message', () => {
  const card = fs.readFileSync(path.join(ROOT, 'pages/components/SubagentTaskCard.ets'), 'utf8');
  assert.match(card, /@Param items: ConversationUiMessageItem\[\]/,
    'the card takes the branch process items as its param');

  const bubble = fs.readFileSync(path.join(ROOT, 'pages/components/ChatMessageBubble.ets'), 'utf8');
  assert.match(bubble, /items: this\.currentSubagentBranch\(entry, path\)\.subItems/,
    'the bubble re-resolves the branch on every render instead of using the captured entry');
  assert.match(bubble, /ChatMessageStructurePolicy\.subagentBranchAt\(/,
    'the re-resolution goes through the shared policy');
});
