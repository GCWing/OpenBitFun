import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function moduleUrl(relative, imports = {}) {
  let transformed = ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  transformed = transformed.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return `from ${JSON.stringify(imports[specifier])}`;
  });
  return `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
}

const hostStream = 'data:text/javascript,export const UNSUPPORTED_HOST_MESSAGE = "unsupported";';
const replica = await moduleUrl('../../shared/relay-transport/SessionRecordReplica.ts');
const presentation = await moduleUrl('../src/services/SessionRecordPresentation.ts');
const { SessionSynchronizer } = await import(await moduleUrl('../src/services/SessionSynchronizer.ts', {
  '../../../shared/relay-transport/HostStream': hostStream,
  '../../../shared/relay-transport/SessionRecordReplica': replica,
  './SessionRecordPresentation': presentation,
}));

const SESSION = 'session-1';
const turnRecord = (turnId, turnIndex, status, revision) => ({
  event: 'session-record',
  session_id: SESSION,
  payload: {
    sessionId: SESSION, id: `turn/${turnId}`, revision,
    turn: {
      turnId, sessionId: SESSION, turnIndex, status, timestamp: turnIndex,
      userMessage: { id: `${turnId}-user`, content: `request ${turnIndex}`, timestamp: turnIndex },
    },
  },
});
const suggestion = (sourceTurnId, text) => ({
  event: 'agentic://prompt-suggestion',
  session_id: SESSION,
  payload: { sessionId: SESSION, sourceTurnId, suggestion: text },
});

async function connect() {
  const updates = [];
  let handlers;
  const manager = {
    subscribeSessionStream: async (_sessionId, next) => {
      handlers = next;
      return { close() {}, wake() {}, loadOlder: async () => {} };
    },
  };
  const synchronizer = new SessionSynchronizer(manager, SESSION, update => updates.push(update));
  synchronizer.start();
  while (!handlers) await new Promise(resolve => setImmediate(resolve));
  return { updates, handlers, synchronizer, latest: () => updates.at(-1) };
}

test('a suggestion for the settled latest turn reaches the composer unchanged', async () => {
  const { handlers, latest, synchronizer } = await connect();
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  handlers.onCaughtUp();
  assert.equal(latest().prompt_suggestion, null);

  handlers.onEvent(suggestion('turn-1', '  Run the tests  '));
  assert.equal(latest().prompt_suggestion, '  Run the tests  ');
  synchronizer.stop();
});

test('a newer turn retires the suggestion and a stale one is never shown', async () => {
  const { handlers, latest, synchronizer } = await connect();
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  handlers.onCaughtUp();
  handlers.onEvent(suggestion('turn-1', 'Commit the change'));
  assert.equal(latest().prompt_suggestion, 'Commit the change');

  handlers.onEvent(turnRecord('turn-2', 1, 'inprogress', 2));
  assert.equal(latest().prompt_suggestion, null);
  assert.ok(latest().active_turn);

  handlers.onEvent(turnRecord('turn-2', 1, 'completed', 3));
  assert.equal(latest().prompt_suggestion, null);
  handlers.onEvent(suggestion('turn-1', 'Old idea'));
  assert.equal(latest().prompt_suggestion, null);
  synchronizer.stop();
});

test('a suggestion replayed during catch-up appears once the history is ready', async () => {
  const { handlers, updates, latest, synchronizer } = await connect();
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  handlers.onEvent(suggestion('turn-1', 'Open a pull request'));
  assert.equal(updates.length, 0);
  handlers.onCaughtUp();
  assert.equal(latest().prompt_suggestion, 'Open a pull request');

  handlers.onGap();
  assert.equal(latest().prompt_suggestion, null);
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  handlers.onCaughtUp();
  assert.equal(latest().prompt_suggestion, null);
  synchronizer.stop();
});

test('old history hints and malformed or foreign payloads cannot replace the current hint', async () => {
  const { handlers, latest, synchronizer } = await connect();
  handlers.onEvent(turnRecord('turn-2', 1, 'completed', 2));
  handlers.onCaughtUp();
  handlers.onEvent(suggestion('turn-2', 'Current idea'));
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  for (const event of [
    suggestion('turn-1', 'Old replay'),
    { ...suggestion('turn-2', 'Foreign'), payload: { sessionId: 'other', sourceTurnId: 'turn-2', suggestion: 'Foreign' } },
    { ...suggestion('turn-2', 'Invalid'), payload: null },
  ]) {
    handlers.onEvent(event);
    assert.equal(latest().prompt_suggestion, 'Current idea');
  }
  synchronizer.stop();
});

test('failed or resumed turns retire hints and deleting a newer turn does not revive them', async () => {
  const { handlers, latest, synchronizer } = await connect();
  handlers.onEvent(turnRecord('turn-1', 0, 'completed', 1));
  handlers.onCaughtUp();
  handlers.onEvent(suggestion('turn-1', 'Old idea'));
  handlers.onEvent(turnRecord('turn-2', 1, 'inprogress', 2));
  assert.equal(latest().prompt_suggestion, null);
  handlers.onEvent({ event: 'session-record', session_id: SESSION,
    payload: { sessionId: SESSION, id: 'turn/turn-2', revision: 3, deleted: true } });
  assert.equal(latest().prompt_suggestion, null);
  handlers.onEvent(turnRecord('turn-1', 0, 'error', 4));
  handlers.onEvent(suggestion('turn-1', 'Failed turn'));
  assert.equal(latest().prompt_suggestion, null);
  synchronizer.stop();
});
