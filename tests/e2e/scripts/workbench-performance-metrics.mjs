import assert from 'node:assert/strict';

/** Endpoint integrity for attributed resource windows; not continuous focus tracking. */
export function resourceWindowConditions(windows, scenes) {
  return windows.map(window => {
    const expected = scenes[window.name];
    assert.ok(expected, 'Known resource window');
    for (const snapshot of [window.before, window.after]) {
      assert.equal(snapshot.documentHidden, false, `${window.name} document must remain visible`);
      assert.equal(typeof snapshot.documentHasFocus, 'boolean', 'Record actual document focus');
      assert.deepEqual(snapshot.scenes.filter(scene => scene.active === 'true').map(scene => scene.id),
        [expected], `${window.name} must start and end on its intended scene`);
    }
    assert.equal(window.before.documentHasFocus, window.after.documentHasFocus,
      `${window.name} focus changed between endpoint snapshots`);
    return { name: window.name, scene: expected, documentHasFocus: window.before.documentHasFocus };
  });
}

export function sceneWindowConditions(windows) {
  return resourceWindowConditions(windows, {
    'home-history-navigation': 'session', 'home-active': 'personal-overview',
    'todos-static': 'todos', 'home-return': 'personal-overview',
  });
}

export function unfocusedWindowConditions(windows, scenes) {
  for (const window of windows) {
    for (const snapshot of [window.before, window.after]) {
      assert.equal(snapshot.nativeWindowFocused, false, `${window.name}: native main window must remain unfocused`);
      assert.equal(snapshot.documentHasFocus, false, `${window.name}: main document must remain unfocused`);
    }
    assert.ok(window.windowState?.length >= 2, `${window.name}: window state observation required`);
    assert.ok(window.windowState.every(state => state.documentHidden === false && state.documentHasFocus === false),
      `${window.name}: document focus or visibility changed during observation`);
  }
  return resourceWindowConditions(windows, scenes);
}

export function assertComparable(reports) {
  assert.ok(reports.length >= 2, 'At least two runs are required');
  const first = reports[0];
  for (const report of reports) {
    assert.equal(report.schemaVersion, 2);
    for (const key of ['protocolHash', 'harnessHash', 'binarySha256']) {
      assert.ok(report[key], `${key} must be recorded`);
      assert.equal(report[key], first[key], `Cannot compare different ${key}`);
    }
    assert.deepEqual(report.protocol, first.protocol);
    assert.deepEqual(report.environment, first.environment);
    assert.ok(report.functionalPassed, 'Incomplete functional runs stay diagnostic');
    assert.ok(!report.coverage.experimentalMotionOverride && !report.coverage.experimentalStyleOverride,
      'Injected experiments cannot be acceptance runs');
    assert.deepEqual(report.resourceWindows.map(window => window.name), first.protocol.idleSequence);
    assert.equal(report.samples.length, first.samples.length);
  }
}

export function processWindow(window, pid) {
  const start = window.start.processes.find(process => process.pid === pid);
  const end = window.end.processes.find(process => process.pid === pid);
  assert.ok(start && end, 'The same process must exist at both boundaries');
  const durationMs = window.end.at - window.start.at;
  assert.ok(durationMs > 0);
  const cpuMs = end.cpuMs - start.cpuMs;
  assert.ok(cpuMs >= 0, 'Cumulative process CPU cannot decrease');
  return { durationMs, cpuMs, cpuPercentOneCore: cpuMs / durationMs * 100,
    rssStartMiB: start.rssMiB, rssEndMiB: end.rssMiB, rssDeltaMiB: end.rssMiB - start.rssMiB };
}

export function motionDifference(before, after) {
  assert.equal(before.timing.length, 4, 'The four authored motion parts must still animate');
  assert.equal(after.timing.length, 4);
  for (const part of before.timing) {
    const next = after.timing.find(item => item.part === part.part);
    assert.ok(next);
    assert.equal(next.duration, part.duration);
    assert.equal(next.iterations, part.iterations);
    assert.deepEqual(next.frames.map(frame => [frame.offset, frame.easing, frame.opacity]), part.frames.map(frame => [frame.offset, frame.easing, frame.opacity]));
  }
  assert.equal(before.samples.length, after.samples.length);
  let maximumGeometryDifference = 0;
  before.samples.forEach((sample, index) => {
    const next = after.samples[index];
    assert.equal(sample.time, next.time);
    for (const part of sample.parts) {
      const other = next.parts.find(item => item.part === part.part);
      assert.ok(other);
      assert.equal(other.opacity, part.opacity);
      for (const field of ['matrix', 'box']) {
        assert.equal(other[field].length, part[field].length);
        part[field].forEach((value, coordinate) => {
          const difference = Math.abs(other[field][coordinate] - value);
          assert.ok(Number.isFinite(difference));
          maximumGeometryDifference = Math.max(maximumGeometryDifference, difference);
        });
      }
    }
  });
  return maximumGeometryDifference;
}

export function assertResourceMotion(report) {
  for (const window of report.resourceWindows) {
    const before = window.before.animations.filter(item => item.scene === 'personal-overview');
    const after = window.after.animations.filter(item => item.scene === 'personal-overview');
    if (window.name === 'todos-static') {
      assert.ok([...before, ...after].every(item => item.state !== 'running'), 'Hidden home must not keep running animation work');
      continue;
    }
    assert.equal(before.length, 4);
    assert.equal(after.length, 4);
    for (const part of before) {
      const next = after.find(item => item.part === part.part);
      assert.ok(part.visible && next?.visible);
      assert.equal(part.state, 'running');
      assert.equal(next.state, 'running');
      assert.equal(part.duration, 1600);
      assert.equal(next.duration, 1600);
      assert.ok(next.currentTime - part.currentTime >= report.protocol.idleMs * 0.9, 'Visible motion must keep advancing throughout the resource window');
    }
  }
}
