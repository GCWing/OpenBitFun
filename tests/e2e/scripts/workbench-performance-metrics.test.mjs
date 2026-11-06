import assert from 'node:assert/strict';
import test from 'node:test';
import { assertComparable, assertResourceMotion, processWindow, motionDifference, sceneWindowConditions, resourceWindowConditions, unfocusedWindowConditions } from './workbench-performance-metrics.mjs';

test('background comparisons reject focus changes between otherwise matching endpoints', () => {
  const state = { documentHasFocus: false, documentHidden: false };
  const snapshot = { ...state, nativeWindowFocused: false, scenes: [{ id: 'session', active: 'true' }] };
  const window = { name: 'after-completion', before: structuredClone(snapshot), after: structuredClone(snapshot),
    windowState: [{ ...state, reason: 'start' }, { ...state, reason: 'end' }] };
  const scenes = { 'after-completion': 'session' };
  assert.equal(unfocusedWindowConditions([window], scenes).length, 1);
  for (const mutate of [w => { w.windowState.splice(1, 0, { ...state, documentHasFocus: true }); },
    w => { w.windowState.splice(1, 0, { ...state, documentHidden: true }); },
    w => { delete w.windowState; }, w => { delete w.windowState[0].documentHasFocus; },
    w => { w.after.nativeWindowFocused = true; }]) {
    const changed = structuredClone(window); mutate(changed);
    assert.throws(() => unfocusedWindowConditions([changed], scenes));
  }
});

test('resource windows validate the owning protocol scene and reject unknown windows', () => {
  const snapshot = { documentHidden: false, documentHasFocus: false,
    scenes: [{ id: 'session', active: 'true' }] };
  const window = { name: 'after-completion', before: structuredClone(snapshot), after: structuredClone(snapshot) };
  assert.deepEqual(resourceWindowConditions([window], { 'after-completion': 'session' }),
    [{ name: 'after-completion', scene: 'session', documentHasFocus: false }]);
  assert.throws(() => resourceWindowConditions([window], {}));
  assert.throws(() => resourceWindowConditions([window], { 'after-completion': 'personal-overview' }));
  window.after.documentHasFocus = true;
  assert.throws(() => resourceWindowConditions([window], { 'after-completion': 'session' }));
});

test('scene resources require recorded stable focus, a visible document and the intended scene at both endpoints', () => {
  const snapshot = { documentHidden: false, documentHasFocus: false,
    scenes: [{ id: 'personal-overview', active: 'true' }, { id: 'session', active: 'false' }] };
  const window = { name: 'home-active', before: structuredClone(snapshot), after: structuredClone(snapshot) };
  assert.deepEqual(sceneWindowConditions([window]), [{ name: 'home-active', scene: 'personal-overview', documentHasFocus: false }]);
  const focused = structuredClone(window);
  focused.before.documentHasFocus = focused.after.documentHasFocus = true;
  assert.notDeepEqual(sceneWindowConditions([window]), sceneWindowConditions([focused]));
  for (const mutate of [w => { w.after.documentHasFocus = true; },
    w => { delete w.before.documentHasFocus; }, w => { w.after.documentHidden = true; },
    w => { w.after.scenes[0].active = 'false'; w.after.scenes[1].active = 'true'; }]) {
    const changed = structuredClone(window); mutate(changed);
    assert.throws(() => sceneWindowConditions([changed]));
  }
});

test('process CPU uses cumulative time and the measured window, not whole-machine core count', () => {
  const window = { start: { at: 1000, processes: [{ pid: 4, cpuMs: 300, rssMiB: 80 }] },
    end: { at: 31000, processes: [{ pid: 4, cpuMs: 4800, rssMiB: 75 }] } };
  assert.deepEqual(processWindow(window, 4), { durationMs: 30000, cpuMs: 4500,
    cpuPercentOneCore: 15, rssStartMiB: 80, rssEndMiB: 75, rssDeltaMiB: -5 });
  assert.throws(() => processWindow(window, 5));
});

test('different guards, timing, binary, runner and experimental styles invalidate paired comparisons', () => {
  const report = { schemaVersion: 2, protocolHash: 'p', harnessHash: 'h', binarySha256: 'b',
    protocol: { idleSequence: ['home-active'] }, environment: { arch: 'arm64' },
    functionalPassed: true, coverage: {}, samples: [1], resourceWindows: [{ name: 'home-active' }] };
  assertComparable([report, structuredClone(report)]);
  for (const mutate of [r => { r.protocolHash = 'other'; }, r => { r.harnessHash = 'other'; },
    r => { r.binarySha256 = 'other'; }, r => { r.protocol.stateGuards = false; },
    r => { r.functionalPassed = false; }, r => { r.coverage.experimentalMotionOverride = true; },
    r => { r.resourceWindows = []; }]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => assertComparable([report, changed]));
  }
});

test('motion checks reject lost parts, retiming and geometry changes while allowing equivalent transforms', () => {
  const parts = ['body', 'lever', 'face', 'eyes'];
  const signature = { timing: parts.map(part => ({ part, duration: 1600, iterations: 'Infinity',
    frames: [{ offset: 0, easing: 'linear', transform: 'none' }] })),
    samples: [{ time: 0, parts: parts.map(part => ({ part, opacity: '1', matrix: [1, 0, 0, 1, 0, 0], box: [0, 0, 100, 100] })) }] };
  const equivalent = structuredClone(signature); equivalent.timing[0].frames[0].transform = 'scale(1)';
  assert.equal(motionDifference(signature, equivalent), 0);
  equivalent.samples[0].parts[0].matrix[4] = 2;
  assert.equal(motionDifference(signature, equivalent), 2);
  equivalent.timing[0].duration = 800;
  assert.throws(() => motionDifference(signature, equivalent));
  assert.throws(() => motionDifference(signature, { ...signature, timing: [] }));
});

test('resource acceptance rejects paused, hidden or slowed visible motion and running hidden motion', () => {
  const animations = ['body', 'lever', 'face', 'eyes'].map(part => ({ part, scene: 'personal-overview', visible: true, state: 'running', duration: 1600, currentTime: 100 }));
  const report = { protocol: { idleMs: 30000 }, resourceWindows: [
    { name: 'home-active', before: { animations }, after: { animations: animations.map(item => ({ ...item, currentTime: 30100 })) } },
    { name: 'todos-static', before: { animations: [] }, after: { animations: [] } },
  ] };
  assertResourceMotion(report);
  for (const mutate of [r => { r.resourceWindows[0].after.animations[0].state = 'paused'; },
    r => { r.resourceWindows[0].after.animations[0].currentTime = 200; },
    r => { r.resourceWindows[1].after.animations = animations; }]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => assertResourceMotion(changed));
  }
});
