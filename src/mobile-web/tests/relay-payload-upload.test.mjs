import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function moduleUrl(relative, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return `from ${JSON.stringify(imports[specifier])}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const endpoint = await moduleUrl('../../shared/relay-transport/RelayEndpoint.ts');
const { relayPayloadBytes, uploadRelayPayload, RELAY_INLINE_PAYLOAD_BYTES } = await import(
  await moduleUrl('../src/services/RelayPayloadUpload.ts', { '../../../shared/relay-transport/RelayEndpoint': endpoint }),
);
const reference = { $relayPayload: { id: '01234567-89ab-cdef-0123-456789abcdef', bytes: 10 } };
const quiet = async run => { const warn = console.warn; console.warn = () => {}; try { return await run(); } finally { console.warn = warn; } };

test('small parameters stay inline; image-sized ones travel by reference', () => {
  assert.equal(relayPayloadBytes({ text: 'hello' }), null);
  const bytes = relayPayloadBytes({ data: 'x'.repeat(RELAY_INLINE_PAYLOAD_BYTES) });
  assert.ok(bytes instanceof Uint8Array && bytes.length > RELAY_INLINE_PAYLOAD_BYTES);
});

test('a flaky upload is retried with the same bytes and yields one reference', async () => {
  const bodies = []; const delays = [];
  const responses = [new TypeError('Failed to fetch'), new Response('busy', { status: 503 }), Response.json(reference)];
  const fetchImpl = async (url, init) => {
    bodies.push(init.body);
    assert.equal(url, 'https://relay.example/relay/v1/rpc/payloads');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const body = new Uint8Array([1, 2, 3]);
  const result = await quiet(() => uploadRelayPayload('https://relay.example/relay', 'token', body,
    { fetchImpl, sleep: async ms => { delays.push(ms); } }));
  assert.deepEqual(result, reference);
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(sent => sent === body), 'every attempt sends the same payload');
  assert.deepEqual(delays, [1000, 2000]);
});

test('upload failures are bounded and state that nothing was submitted', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('down', { status: 502 }); };
  await quiet(() => assert.rejects(uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]),
    { fetchImpl, sleep: async () => {} }), /upload failed \(502\); request was not submitted/));
  assert.equal(calls, 3);
  calls = 0;
  const rejected = async () => { calls += 1; return new Response('too large', { status: 413 }); };
  await assert.rejects(uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]),
    { fetchImpl: rejected, sleep: async () => {} }), /413/);
  assert.equal(calls, 1, 'a permanent refusal is not retried');
  const changed = Object.assign(new Error('Account identity changed'), { name: 'AccountIdentityChangedError' });
  await assert.rejects(uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]),
    { fetchImpl, assertCurrent: () => { throw changed; } }), changed);
});

test('a timed-out upload is not sent again', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await quiet(() => assert.rejects(uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]),
    { fetchImpl, sleep: async () => {} }), /request was not submitted/));
  assert.equal(calls, 1, 'a slow link would otherwise resend the whole payload');
});

test('signing out cancels an upload in flight and between attempts', async () => {
  const lifetime = new AbortController();
  let calls = 0;
  const pending = async (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const upload = uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]),
    { fetchImpl: pending, sleep: async () => {}, signal: lifetime.signal });
  await new Promise(resolve => setImmediate(resolve));
  lifetime.abort();
  await assert.rejects(upload, /cancelled; request was not submitted/);
  assert.equal(calls, 1);

  const signedOut = new AbortController();
  const changed = Object.assign(new Error('Account identity changed'), { name: 'AccountIdentityChangedError' });
  calls = 0;
  const busy = async () => { calls += 1; return new Response('busy', { status: 503 }); };
  await quiet(() => assert.rejects(uploadRelayPayload('https://relay.example/relay', 'token', new Uint8Array([1]), {
    fetchImpl: busy,
    sleep: async () => { signedOut.abort(); },
    signal: signedOut.signal,
    assertCurrent: () => { if (signedOut.signal.aborted) throw changed; },
  }), changed, 'the owner explains the cancellation'));
  assert.equal(calls, 1, 'no attempt starts after sign-out');
});

test('the account client ties uploads to the identity it signs out', async () => {
  const client = await readFile(new URL('../src/services/RelayHttpClient.ts', import.meta.url), 'utf8');
  assert.match(client, /signal: identity\.lifetime\.signal/);
  const reset = client.slice(client.indexOf('resetConnectionIdentity(): void {'));
  assert.match(reset.slice(0, reset.indexOf('\n  }\n')), /this\.identity\?\.lifetime\.abort\(\)/);
});
