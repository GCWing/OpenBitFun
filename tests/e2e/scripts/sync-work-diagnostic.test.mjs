import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { instrumentSyncWork, createSyncWorkProbe } from './sync-work-diagnostic.mjs';

test('synchronous attribution keeps nested self time separate and detects incomplete stacks', () => {
  let now = 0;
  const probe = createSyncWorkProbe(() => now);
  const outer = probe.begin('outer'); now = 2;
  const inner = probe.begin('inner'); now = 5; probe.end(inner); now = 8; probe.end(outer);
  const result = probe.stop();
  assert.deepEqual(result.groups, [
    { label: 'outer', calls: 1, totalMs: 8, selfMs: 5, maxMs: 8 },
    { label: 'inner', calls: 1, totalMs: 3, selfMs: 3, maxMs: 3 },
  ]);
  assert.equal(result.stackDepth, 0); assert.equal(result.mismatchCount, 0);
  assert.equal(probe.begin('after-stop'), undefined);
  const incomplete = createSyncWorkProbe(() => now); incomplete.begin('pending');
  assert.equal(incomplete.stop().stackDepth, 1);
});

test('instrumentation preserves returns, throws, recursive calls and lexical this', async () => {
  const source = `function recursive(n) { if (n === 0) return 1; return n * recursive(n - 1); }
  function fail() { throw new Error('expected'); }
  class Example { constructor() { this.value = 3; } work(n) { const add = x => { return this.value + x; }; return add(n); } }
  async function deferred() { await Promise.resolve(); return 7; }
  function* values() { yield 1; }
  globalThis.results = [recursive(4), new Example().work(5), deferred(), [...values()]];
  try { fail(); } catch (error) { globalThis.failure = error.message; }`;
  let clock = 0;
  const probe = createSyncWorkProbe(() => ++clock);
  const { code, labels } = instrumentSyncWork(source, 'fixture.ts');
  const context = vm.createContext({ __openbitfunSyncWork: probe });
  vm.runInContext(code, context);
  assert.equal(context.results[0], 24); assert.equal(context.results[1], 8);
  assert.equal(await context.results[2], 7); assert.equal(context.results[3][0], 1);
  assert.equal(context.failure, 'expected');
  assert.ok(labels.some(label => label.endsWith(':recursive')));
  assert.ok(!labels.some(label => /:(deferred|values)$/.test(label)));
  const result = probe.stop();
  assert.equal(result.stackDepth, 0); assert.equal(result.mismatchCount, 0);
  assert.equal(result.groups.find(group => group.label.endsWith(':recursive')).calls, 5);
  const withoutProbe = vm.createContext({}); vm.runInContext(code, withoutProbe);
  assert.equal(withoutProbe.results[0], 24);
});

test('selection instruments only requested functions and rejects double transformation', () => {
  const source = 'function chosen() { return 1; } function untouched() { return 2; }';
  const result = instrumentSyncWork(source, 'fixture.ts', new Set(['chosen']));
  assert.equal(result.labels.length, 1);
  assert.ok(result.code.includes('function untouched() { return 2; }'));
  assert.throws(() => instrumentSyncWork(result.code, 'fixture.ts'));
});

test('empty function and hook callback bodies retain valid balanced instrumentation', () => {
  const source = 'function empty() {} const saved = useRef(() => {}); empty(); saved();';
  const probe = createSyncWorkProbe(() => 0);
  const { code } = instrumentSyncWork(source, 'fixture.ts');
  vm.runInNewContext(code, { __openbitfunSyncWork: probe, useRef: callback => callback });
  const result = probe.stop();
  assert.equal(result.groups.length, 2); assert.equal(result.stackDepth, 0); assert.equal(result.mismatchCount, 0);
});
