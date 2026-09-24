const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, dependencies = {}, timers = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const result = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', js)(name => dependencies[name] || {}, result, timers.set || (() => 1), timers.clear || (() => {}));
  return result;
}
const goal = load('model/ThreadGoal.ets');
const { RemoteGoalController } = load('pages/viewmodel/RemoteGoalController.ets', { '../../model/ThreadGoal': goal });
function fixture(supported = true) {
  const commands = [];
  const remote = { activeSession: { sessionId: 's' }, chatInput: '/goal ship it', threadGoal: new goal.ThreadGoalState(),
    supportsHostCapability: () => supported,
    conversation: { prepareComposerSubmission: () => ({ commit() { remote.chatInput = ''; } }) } };
  const manager = { generation: 1, goalTargetGeneration() { return this.generation; },
    async threadGoal(...args) { commands.push(args); return { resp: 'thread_goal', goal: { sessionId: 's', objective: 'ship it', status: 'active' } }; } };
  return { remote, manager, commands, controller: new RemoteGoalController(remote, manager) };
}
test('goal parser distinguishes objectives, multiline instructions, and controls', () => {
  assert.equal(goal.parseGoalCommand('/goalie x'), undefined);
  assert.equal(goal.parseGoalCommand('hello /goal'), undefined);
  assert.equal(goal.parseGoalCommand(' /GOAL ').action, 'open');
  assert.equal(goal.parseGoalCommand('/goal pause').action, 'pause');
  assert.equal(goal.parseGoalCommand('/goal pause\nthen test').action, 'start');
  assert.equal(goal.parseGoalCommand('/goal\n目标').objective, '目标');
});
test('unsupported host receives no command and retains draft', async () => {
  const f = fixture(false);
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Start, 'ship it'), f.remote.chatInput);
  assert.equal(f.remote.threadGoal.failure, 'unsupported');
  assert.equal(f.remote.chatInput, '/goal ship it');
  assert.equal(f.commands.length, 0);
});
test('goal controls project the host response', async () => {
  const f = fixture();
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Start, 'ship it'), f.remote.chatInput);
  assert.deepEqual(f.commands[0], ['s', 'start', 'ship it']);
  assert.equal(f.remote.threadGoal.goal.status, 'active');
  assert.equal(f.remote.chatInput, '');
  for (const action of ['pause', 'resume', 'edit', 'clear']) {
    await f.controller.dispatch(new goal.GoalRequest(action));
    assert.equal(f.commands.at(-1)[1], action);
  }
});
for (const change of ['session', 'target']) test(`late goal response cannot publish after ${change} changes`, async () => {
  const f = fixture(); let resolve;
  f.manager.threadGoal = () => new Promise(done => { resolve = done; });
  const pending = f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Open));
  if (change === 'session') f.remote.activeSession = { sessionId: 'other' };
  if (change === 'target') f.manager.generation++;
  if (change === 'close') await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Close));
  resolve({ goal: { sessionId: 's', objective: 'stale', status: 'active' } }); await pending;
  assert.equal(f.remote.threadGoal.goal, undefined);
});
test('failed mutation retains the last confirmed goal', async () => {
  const f = fixture();
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Open));
  f.manager.threadGoal = async () => { throw new Error('offline'); };
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Pause));
  assert.equal(f.remote.threadGoal.goal.status, 'active');
  assert.equal(f.remote.threadGoal.failure, 'failed');
  assert.equal(f.remote.threadGoal.busy, false);
});

test('opening an in-flight snapshot works and closing keeps the strip without reopening', async () => {
  const f = fixture(); let resolve;
  f.manager.threadGoal = () => new Promise(done => { resolve = done; });
  const pending = f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Read));
  assert.equal(f.remote.threadGoal.visible, false);
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Open));
  assert.equal(f.remote.threadGoal.visible, true);
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Close));
  resolve({ goal: { sessionId: 's', objective: 'live goal', status: 'active' } }); await pending;
  assert.equal(f.remote.threadGoal.visible, false);
  assert.equal(f.remote.threadGoal.goal.objective, 'live goal');
});
test('background observation waits for foreground', async () => {
  const f = fixture();
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Read));
  f.controller.setForeground(false);
  await f.controller.dispatch(new goal.GoalRequest(goal.GoalAction.Read));
  assert.equal(f.commands.length, 1);
  f.controller.setForeground(true);
  assert.equal(f.commands.length, 2);
});
