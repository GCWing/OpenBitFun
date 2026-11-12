import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, frameMetrics, summarize, renderReport } from './long-session-metrics.mjs';
import { createLongSessionModel } from '../helpers/long-session-model.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_TOOL_TEMPLATE, resolveTemplateToolItems } from './long-session-multi-tool-template.mjs';

test('nearest-rank timing quantiles and empty samples cannot imply success', () => {
  assert.deepEqual(distribution([100, 16, 8, 50]), { count: 4, p50Ms: 16, p90Ms: 100, p95Ms: 100, p99Ms: 100, maxMs: 100, meanMs: 43.5 });
  assert.equal(distribution([]).p95Ms, null);
  assert.throws(() => distribution([NaN]));
});

test('RAF rate uses time-weighted intervals and excludes idle outside the input window', () => {
  const frame = frameMetrics([0, 16, 32, 82, 182, 198, 214, 230], 30, 190);
  assert.equal(frame.count, 4); assert.equal(frame.durationMs, 182);
  assert.equal(frame.rafFps, 4000 / 182);
  assert.equal(frame.overBudget[0].percent, 50);
  assert.equal(frame.stallEpisodes, 1); assert.equal(frame.longestStallFrames, 2);
  assert.equal(frameMetrics([], 0, 1).rafFps, null);
  assert.throws(() => frameMetrics([10, 9], 0, 20));
});

test('failed samples remain visible and cannot pollute successful aggregate metrics', () => {
  const sample = { state: 'static', scenario: 'first-open', valid: true, probe: { times: [0, 16, 32], actionAt: 0, endAt: 32, latencyMs: 32 } };
  const rows = summarize([sample, { ...sample, valid: false }, { ...sample, state: 'streaming' }]);
  assert.equal(rows[0].samples, 2); assert.equal(rows[0].validSamples, 1);
  assert.equal(rows[0].frame.rafFps, 62.5); assert.equal(rows[0].latency.count, 1);
  assert.equal(rows[1].name, 'streaming/first-open');
  const output = renderReport({ summary: rows, failures: ['<script>'], environment: {}, protocol: {} });
  assert.ok(output.html.includes('&lt;script&gt;')); assert.ok(!output.html.includes('<script>'));
  assert.match(output.csv, /"2\/2"|"1\/2"/);
});

test('two independent live SSE responses advance, finish explicitly and retain per-session counters', async () => {
  const fixture = await createLongSessionModel({ intervalMs: 10, paragraphChars: 64 });
  const controller = new AbortController();
  try {
    const responses = await Promise.all(['a', 'b'].map(id => fetch(fixture.url + '/v1/messages', {
      method: 'POST', signal: controller.signal, body: JSON.stringify({ messages: [{ role: 'user', content: `LONG_SESSION_STREAM:${id}` }] }),
    })));
    const bodies = responses.map(response => response.text());
    await new Promise(resolve => setTimeout(resolve, 60));
    for (const id of ['a', 'b']) {
      assert.ok(fixture.snapshot(id).emitted >= 3); assert.equal(fixture.snapshot(id).connected, true);
    }
    const a = fixture.snapshot('a').emitted; fixture.finish('a'); fixture.finish('a');
    const text = await bodies[0]; assert.match(text, /LONG_SESSION_COMPLETE:a/); assert.match(text, /event: message_stop/);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(fixture.snapshot('a').emitted, a); assert.ok(fixture.snapshot('b').emitted > a);
    fixture.finish('b'); assert.match(await bodies[1], /LONG_SESSION_COMPLETE:b/);
    assert.deepEqual(fixture.errors, []);
  } finally { controller.abort(); await fixture.close(); }
});

test('unexpected auxiliary model traffic fails visibly rather than becoming a valid stream', async () => {
  const fixture = await createLongSessionModel();
  try {
    const response = await fetch(fixture.url, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 400); assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.snapshot('missing'), null);
  } finally { await fixture.close(); }
});

test('multi-tool CLI writes 100 diverse calls across 26 rounds in every historical turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-multi-tool-contract-'));
  const execute = promisify(execFile), workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const generator = fileURLToPath(new URL('./generate-long-session-fixture.mjs', import.meta.url));
  const base = [generator, '--workspace', workspace, '--openbitfun-home', path.join(root, 'home'),
    '--openbitfun-user-root', path.join(root, 'user'), '--session-count', '2', '--long-turns', '3', '--short-turns', '2',
    '--assistant-chars', '700', '--tool-result-chars', '256'];
  try {
    const run = await execute(process.execPath, [...base, '--session-prefix', 'multi', '--scenario', 'multi-tool'], { windowsHide: true });
    const manifest = JSON.parse(run.stdout);
    assert.equal(manifest.toolItems, 100); assert.deepEqual(manifest.template, MULTI_TOOL_TEMPLATE);
    for (const [suffix, turnCount] of [['000', 3], ['001', 2]]) {
      const sessionDirectory = path.join(manifest.sessionsRoot, `multi-${suffix}`);
      const metadata = JSON.parse(await readFile(path.join(sessionDirectory, 'metadata.json'), 'utf8'));
      assert.equal(metadata.toolCallCount, turnCount * 100);
      const files = await readdir(path.join(sessionDirectory, 'turns'));
      assert.equal(files.length, turnCount);
      for (const file of files) {
        const turn = JSON.parse(await readFile(path.join(sessionDirectory, 'turns', file), 'utf8'));
        assert.equal(turn.modelRounds.length, 26);
        assert.deepEqual(turn.modelRounds.map(round => round.roundIndex), Array.from({ length: 26 }, (_, index) => index));
        const tools = turn.modelRounds.flatMap(round => round.toolItems);
        assert.equal(tools.length, 100); assert.equal(new Set(tools.map(tool => tool.id)).size, 100);
        assert.deepEqual(Object.fromEntries(Object.keys(MULTI_TOOL_TEMPLATE.toolsPerTurn).map(name => [name, tools.filter(tool => tool.toolName === name).length])),
          { Read: 25, Edit: 25, Write: 25, ExecCommand: 25 });
        for (const round of turn.modelRounds.slice(0, 25)) {
          assert.equal(round.textItems.length, 1); assert.equal(round.textItems[0].content.length, 320);
          assert.deepEqual(round.toolItems.map(tool => tool.toolName), ['Read', 'Edit', 'Write', 'ExecCommand']);
          const [read, edit, write, exec] = round.toolItems;
          assert.equal(read.toolCall.input.file_path, edit.toolCall.input.file_path);
          assert.equal(read.toolResult.result.content.length, 256);
          assert.equal(read.toolCall.input.file_path.startsWith('/workspace/'), true);
          assert.notEqual(edit.toolCall.input.old_string, edit.toolCall.input.new_string);
          assert.ok(read.toolResult.result.content.includes(edit.toolCall.input.old_string), 'Edit must target the previously read source');
          assert.ok(write.toolCall.input.content.startsWith('// Recorded fixture:'));
          assert.equal(write.toolResult.result.bytes_written, Buffer.byteLength(write.toolCall.input.content));
          assert.equal(exec.toolCall.input.cmd, `node --check ${write.toolCall.input.file_path}`);
          assert.equal(exec.toolResult.result.exit_code, 0); assert.equal(exec.toolResult.result.output.length, 256);
          assert.equal(round.endTime <= turn.endTime, true);
          assert.deepEqual(round.toolItems.map(tool => tool.orderIndex), [1, 2, 3, 4]);
          assert.ok(round.toolItems.every(tool => tool.status === 'completed' && tool.toolResult.success));
        }
        assert.equal(turn.modelRounds.at(-1).toolItems.length, 0);
        assert.equal(turn.modelRounds.at(-1).textItems[0].content.length, 700);
        assert.equal(turn.endTime, turn.modelRounds.at(-1).endTime);
        assert.equal(turn.durationMs, turn.endTime - turn.startTime);
      }
    }
    // The same generator must preserve the existing default two-round / Read-only fixture.
    const legacy = await execute(process.execPath, [...base, '--session-prefix', 'legacy'], { windowsHide: true });
    const oldManifest = JSON.parse(legacy.stdout);
    assert.equal(oldManifest.scenario, 'mixed-visible'); assert.equal(oldManifest.toolItems, 2);
    const oldTurn = JSON.parse(await readFile(path.join(oldManifest.sessionsRoot, 'legacy-000', 'turns', 'turn-0000.json'), 'utf8'));
    assert.equal(oldTurn.modelRounds.length, 2);
    assert.deepEqual(oldTurn.modelRounds[0].toolItems.map(tool => tool.toolName), ['Read', 'Read']);
    assert.equal(oldTurn.modelRounds[1].textItems[0].content.length, 700);
    const generated = (await readdir(workspace));
    assert.deepEqual(generated, [], 'Recorded tools must never create actual workspace files');
  } finally {
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('openbitfun-multi-tool-contract-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('multi-tool count is fixed and contradictory CLI requests fail explicitly', () => {
  assert.equal(resolveTemplateToolItems('multi-tool', 3), 100);
  assert.equal(resolveTemplateToolItems('multi-tool', 100, true), 100);
  assert.equal(resolveTemplateToolItems('mixed-visible', 3, true), 3);
  assert.throws(() => resolveTemplateToolItems('multi-tool', 99, true), /exactly 100/);
});
