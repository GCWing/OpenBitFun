import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture.ts';

test('bounded streaming keeps equal output work and waits for explicit completion', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-stream-fixture-'));
  const fixture = await createFlowChatStreamFixture(workspace, {
    initialParagraphs: 2, maxParagraphs: 3, intervalMs: 10, responseDelayMs: 20,
  });
  try {
    const response = await fetch(fixture.url, { method: 'POST', body: JSON.stringify({ messages: [{
      content: [{ type: 'tool_result', tool_use_id: 'flowchat-perf-0', content: 'fixture response' }],
    }] }) });
    const body = response.text();
    assert.equal(fixture.textReady, true);
    fixture.begin(); fixture.begin();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fixture.emitted, 3);
    assert.equal(fixture.disconnected, false);
    fixture.finish();
    const events = await body;
    assert.equal((events.match(/Stream paragraph /g) ?? []).length, 3);
    assert.match(events, /FLOWCHAT_STREAM_COMPLETE/);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); await rm(workspace, { recursive: true, force: true }); }
});
