import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
// Execute the production lifecycle functions with a delayed host bridge. No
// model or DOM is needed to reproduce competing topic/session operations.
const functions = source.slice(source.indexOf('async function ensureDeckAgentSession()'), source.indexOf('function deckSlideFileName('))
  + source.slice(source.indexOf('async function newDeck()'), source.indexOf('function addElement('));

function harness() {
  const pending = [];
  const focused = [];
  const saved = [];
  const statuses = [];
  let sequence = 0;
  const host = {
    appDataDir: '/miniapp',
    backend: { ensureSession: (request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) },
    chat: { focusSession: async (id) => focused.push(id) },
    log: { error() {} },
  };
  const context = vm.createContext({
    state: { sessionId: 'deck-1', agentSession: {}, generation: {} },
    deckEpoch: 0,
    deckSessionInitialization: null,
    topicChangeInFlight: false,
    runtime: () => host,
    currentDeckProject: () => context.state.agentSession.workspaceSubdir ? {
      workspaceSubdir: context.state.agentSession.workspaceSubdir, runId: 'restored',
    } : null,
    newDeckProject: () => ({ workspaceSubdir: `decks/project-${++sequence}`, runId: `project-${sequence}` }),
    PPT_DESIGN_SKILL_KEY: 'ppt-design',
    clearFocusedDeckAgentSession: async () => focused.push(null),
    saveHistorySnapshot: async () => saved.push(structuredClone(context.state)),
    cancelTrackedBackendRuns: async () => {},
    setBusy() {}, resetGeneration() {}, rerender() {}, syncStylePanelFromState() {},
    setStatus: (message) => statuses.push(message),
    t: (key) => key,
    createInitialState: () => ({ sessionId: `deck-${++sequence}`, agentSession: {}, generation: {} }),
    ensureState: (state) => state,
    persist: async () => {},
  });
  vm.runInContext(functions, context);
  return { context, pending, focused, saved, statuses };
}

test('two initializers for one topic share a single host session', async () => {
  const { context, pending, focused } = harness();
  const first = context.ensureDeckAgentSession();
  const second = context.ensureDeckAgentSession();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.sessionId, undefined);
  pending[0].resolve({ sessionId: 'agent-1', created: true });
  assert.deepEqual(await Promise.all([first, second]), ['agent-1', 'agent-1']);
  assert.deepEqual(focused, ['agent-1']);
});

test('a late old-topic initializer cannot replace the new topic binding', async () => {
  const { context, pending, focused } = harness();
  const first = context.ensureDeckAgentSession();
  context.deckEpoch += 1;
  context.state = { sessionId: 'deck-2', agentSession: {} };
  const second = context.ensureDeckAgentSession();
  assert.notEqual(pending[0].request.appDataWorkspace, pending[1].request.appDataWorkspace);
  pending[1].resolve({ sessionId: 'agent-2', created: true });
  await second;
  pending[0].resolve({ sessionId: 'agent-1', created: true });
  assert.equal(await first, null);
  assert.equal(context.state.agentSession.id, 'agent-2');
  assert.deepEqual(focused, ['agent-2']);
});

test('saved topics resume their own session and workspace', async () => {
  const { context, pending, focused } = harness();
  context.state.agentSession = { id: 'saved-agent', workspaceSubdir: 'decks/saved' };
  const resumed = context.ensureDeckAgentSession();
  assert.equal(pending[0].request.sessionId, 'saved-agent');
  assert.equal(pending[0].request.appDataWorkspace, 'decks/saved');
  pending[0].resolve({ sessionId: 'saved-agent', created: false });
  await resumed;
  assert.deepEqual(focused, ['saved-agent']);
});

test('failed or silently replaced historical sessions keep their original pointer', async () => {
  for (const replacement of [false, true]) {
    const { context, pending, focused } = harness();
    context.state.agentSession = { id: 'saved-agent', workspaceSubdir: 'decks/saved' };
    const resumed = context.ensureDeckAgentSession();
    if (replacement) pending[0].resolve({ sessionId: 'empty-replacement', created: true });
    else pending[0].reject(new Error('Host offline'));
    await assert.rejects(resumed);
    assert.equal(context.state.agentSession.id, 'saved-agent');
    assert.equal(pending.length, 1);
    assert.deepEqual(focused, []);
  }
});

test('rapid New topic clicks save the old deck once and bind one fresh conversation', async () => {
  const { context, pending, focused, saved } = harness();
  context.state.agentSession = { id: 'old-agent', workspaceSubdir: 'decks/old' };
  const first = context.newDeck();
  const second = context.newDeck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].agentSession.id, 'old-agent');
  assert.equal(pending[0].request.sessionId, undefined);
  assert.notEqual(pending[0].request.appDataWorkspace, 'decks/old');
  pending[0].resolve({ sessionId: 'new-agent', created: true });
  await Promise.all([first, second]);
  assert.deepEqual(focused, [null, 'new-agent']);
  assert.equal(context.state.agentSession.id, 'new-agent');
  assert.equal(context.topicChangeInFlight, false);
});
