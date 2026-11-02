import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { installOpenBitFunBackendAdapter } from '../src/openbitfun-backend-adapter.js';

const source = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
const images = Array.from({ length: 5 }, (_, index) => ({
  id: `reference-${index}`,
  data_url: `data:image/png;base64,${Buffer.from(`image-${index}`).toString('base64')}`,
  mime_type: 'image/png',
}));

test('PPT Live forwards all five images from its production message callback through submission and generation options', async () => {
  let handler;
  const generated = [];
  const start = source.indexOf('runtime().chat?.onUserMessage?.((payload) => {');
  const callback = source.slice(start, source.indexOf('\n});', start) + 4);
  const submit = source.slice(source.indexOf('async function submitInstruction('), source.indexOf('\nfunction ', source.indexOf('async function submitInstruction(')));
  const backend = source.slice(source.indexOf('async function runPptLiveBackend('), source.indexOf('\n/**', source.indexOf('async function runPptLiveBackend(')));
  const context = vm.createContext({
    runtime: () => ({ chat: { onUserMessage: fn => { handler = fn; } }, backend: { call() {} } }),
    topicChangeInFlight: false, promptSubmitGuard: false, backendRunInFlight: false,
    state: { agentSession: { id: 'deck' }, brief: {} },
    setStatus() {}, t: key => key, hasUsableDeckForRevision: () => false,
    updateBriefFromInputs() {}, readGenerationStyleFromPropertyPanel() {}, persist: async () => {},
    runCoworkDeckGeneration: async (...args) => { generated.push(args); },
  });
  vm.runInContext(submit + backend + callback, context);
  await handler({ text: 'Follow this design', displayText: 'My reference', imageContexts: images, sessionId: 'deck' });
  assert.equal(generated.length, 1);
  assert.equal(generated[0][1], 'Follow this design');
  assert.equal(generated[0][2].imageContexts, images);
  assert.equal(generated[0][2].displayText, 'My reference');
});

test('PPT backend passes image pixels outside its internal text protocol and retains legacy calls', async () => {
  const runs = [];
  const app = { agent: {
    onEvent() {},
    async run(...args) { runs.push(args); return { sessionId: 'deck', turnId: 'turn' }; },
  } };
  installOpenBitFunBackendAdapter(app);
  await app.backend.call('ppt.generate', { instruction: 'Use this reference' }, { imageContexts: images, sessionId: 'deck' });
  assert.equal(runs[0][1].imageContexts, images);
  for (const image of images) assert.ok(!runs[0][0].includes(image.data_url));
  await app.backend.call('ppt.generate', { instruction: 'Text only' });
  assert.equal(runs[1][1].imageContexts, undefined);
});
