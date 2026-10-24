import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

const preferenceKey = 'openbitfun.mobile.last_selected_model_id';
const trigger = '.chat-model-selector__trigger';
let server;
let browser;

before(async () => {
  server = await startSourceServer();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, options = {}, preference = null, width = 390) {
  const context = await browser.createIncognitoBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'fixture must not have uncaught browser errors'));
  page.setDefaultTimeout(5_000);
  await page.setViewport({ width, height: 844 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(server.origin);
  await page.evaluate(async ({ options, preference, preferenceKey }) => {
    localStorage.setItem('openbitfun-mobile-language', 'en-US');
    if (preference !== null) localStorage.setItem(preferenceKey, preference);
    else localStorage.removeItem(preferenceKey);
    window.modelFixture = (await import('/tests/fixtures/session-model.tsx')).mountSessionModelFixture(options);
  }, { options, preference, preferenceKey });
  await ready(page, 'A');
  return page;
}

async function ready(page, sessionId, epoch = 0) {
  await page.waitForFunction(({ sessionId, epoch }) => window.modelFixture.subscriptions.some(
    subscription => !subscription.closed && subscription.sessionId === sessionId && subscription.epoch === epoch,
  ), {}, { sessionId, epoch });
  await page.waitForSelector(trigger);
}
async function open(page, sessionId) {
  await page.evaluate(id => window.modelFixture.open(id), sessionId);
  await ready(page, sessionId);
}
async function label(page) {
  return page.$eval(`${trigger} .chat-model-selector__name-text`, node => node.textContent.trim());
}
async function menu(page) {
  await page.click(trigger);
  await page.waitForSelector('.chat-model-selector__dropdown', { visible: true });
  await page.$eval('.chat-model-selector__dropdown', async node => {
    const surface = node.closest('[role="dialog"]');
    await Promise.all((surface?.getAnimations({ subtree: true }) ?? []).map(animation => animation.finished.catch(() => {})));
  });
}
async function choose(page, name) {
  await menu(page);
  assert.ok(await page.evaluate(name => {
    const option = [...document.querySelectorAll('.chat-model-selector__option')].find(
      node => node.querySelector('.chat-model-selector__option-name')?.textContent.trim() === name,
    );
    option?.click();
    return Boolean(option);
  }, name), `missing model/reasoning option: ${name}`);
}
async function selectedReasoning(page) {
  await menu(page);
  const selected = await page.$eval('.chat-reasoning-options [aria-pressed="true"]', node => node.textContent.trim());
  if (await page.$('.chat-composer-sheet__close')) await page.click('.chat-composer-sheet__close');
  else await page.keyboard.press('Escape');
  await page.waitForSelector('.chat-model-selector__dropdown', { hidden: true });
  return selected;
}
async function writes(page) {
  return page.evaluate(() => window.modelFixture.commands.filter(command => command.cmd === 'set_session_model').map(
    ({ session_id, model_id, reasoning_preset }) => ({ session_id, model_id, ...(reasoning_preset !== undefined ? { reasoning_preset } : {}) }),
  ));
}
async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

for (const [legacy, width] of [[false, 390], [true, 390], [false, 1200], [true, 1200]]) {
  test(`switching sessions restores host selection and only explicit choices write (${legacy ? 'legacy' : 'modern'} host, ${width}px)`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, { legacy }, null, width);
    assert.equal(await label(page), 'Model A');
    await choose(page, 'Model C');
    await page.waitForFunction(() => document.querySelector('.chat-model-selector__name-text')?.textContent === 'Model C');
    assert.deepEqual(await writes(page), [{ session_id: 'A', model_id: 'model-c', ...(legacy ? {} : { reasoning_preset: null }) }]);
    await open(page, 'B');
    assert.equal(await label(page), 'Model B');
    assert.equal(await selectedReasoning(page), 'Low');
    await open(page, 'A');
    assert.equal(await label(page), 'Model C');
    await page.evaluate(() => window.modelFixture.remount());
    await ready(page, 'A');
    assert.equal(await label(page), 'Model C');
    await open(page, 'B');
    assert.equal(await label(page), 'Model B');
    assert.equal((await writes(page)).length, 1, 'opening, switching and remounting must be read-only');
    await page.type('.chat-page__input', 'use this session model');
    await page.click('.chat-page__send-btn');
    await page.waitForFunction(() => window.modelFixture.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{
      sessionId: 'B', content: 'use this session model', modelId: 'model-b', reasoningPreset: 'low',
    }]);
    assert.equal(await page.evaluate(() => 'model_id' in window.modelFixture.commands.find(command => command.cmd === 'send_message')), false);
  });
}

for (const preference of ['model-c', 'auto', 'removed-model']) {
  test(`obsolete browser preference ${preference} cannot overwrite host models or reasoning`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, {}, preference);
    assert.equal(await label(page), 'Model A');
    assert.equal(await selectedReasoning(page), 'High');
    await open(page, 'B');
    assert.equal(await label(page), 'Model B');
    assert.equal(await selectedReasoning(page), 'Low');
    assert.deepEqual(await writes(page), []);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), preference, 'no migration or cache reset is needed');
  });
}

for (const [kind, width] of [['removed', 390], ['removed', 1200], ['disabled', 390], ['non-chat', 390], ['primary', 390]]) {
  test(`an unavailable ${kind} session model is preserved and cannot borrow another model's reasoning (${width}px)`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, {}, 'model-c', width);
    const expected = await page.evaluate(kind => {
      const fixture = window.modelFixture;
      const selection = fixture.hosts['host-a'].B;
      selection.reasoningPreset = 'high';
      if (kind === 'removed') selection.modelId = 'removed-model';
      else if (kind === 'primary') { selection.modelId = 'primary'; fixture.defaults.primary = 'removed-model'; }
      else if (kind === 'disabled') fixture.models.find(model => model.id === selection.modelId).enabled = false;
      else fixture.models.find(model => model.id === selection.modelId).capabilities = [];
      return { ...selection };
    }, kind);
    await open(page, 'B');
    assert.equal(await label(page), 'Model unavailable');
    await menu(page);
    assert.equal(await page.$('.chat-reasoning-options'), null, 'unavailable models must not expose the primary model reasoning presets');
    assert.deepEqual(await writes(page), []);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].B), expected);
    await page.evaluate(() => [...document.querySelectorAll('.chat-model-selector__option')].find(
      node => node.querySelector('.chat-model-selector__option-name')?.textContent.trim() === 'Model C',
    ).click());
    await page.waitForFunction(() => document.querySelector('.chat-model-selector__name-text')?.textContent === 'Model C');
    assert.deepEqual(await writes(page), [{ session_id: 'B', model_id: 'model-c', reasoning_preset: null }], 'recovery requires an explicit model choice');
  });
}

test('reasoning changes preserve a fast reference even when its configured model is missing', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.modelFixture.defaults.fast = 'removed-model'; });
  await open(page, 'fast');
  assert.equal(await label(page), 'Fast Model');
  await choose(page, 'High');
  await page.waitForFunction(() => !document.querySelector('.chat-model-selector__trigger')?.disabled);
  assert.deepEqual(await writes(page), [{ session_id: 'fast', model_id: 'fast', reasoning_preset: 'high' }]);
});

test('unset and symbolic session models follow the host defaults without initializing a model', { timeout: 30_000 }, async t => {
  const page = await fixture(t, {}, 'model-c');
  for (const [id, expected] of [['fresh', 'Auto'], ['auto', 'Auto'], ['default', 'Auto'], ['primary', 'Primary Model'], ['fast', 'Fast Model']]) {
    await open(page, id);
    assert.equal(await label(page), expected);
  }
  assert.deepEqual(await writes(page), []);
});

test('explicit reasoning updates stay in the selected session', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await choose(page, 'Low');
  await page.waitForFunction(() => !document.querySelector('.chat-model-selector__trigger')?.disabled);
  assert.deepEqual(await writes(page), [{ session_id: 'A', model_id: 'model-a', reasoning_preset: 'low' }]);
  assert.equal(await selectedReasoning(page), 'Low');
  await open(page, 'B');
  assert.equal(await label(page), 'Model B');
  await open(page, 'A');
  assert.equal(await label(page), 'Model A');
  assert.equal(await selectedReasoning(page), 'Low');
  assert.equal((await writes(page)).length, 1);
});

test('a timed-out write cannot let a later reasoning change restore the previous model', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.expirePending());
  await page.waitForFunction(() => window.modelFixture.error() !== null);
  await settled(page);
  assert.deepEqual(await page.evaluate(() => ({
    host: window.modelFixture.hosts['host-a'].A,
    pending: window.modelFixture.pending.length,
  })), { host: { modelId: 'model-a', reasoningPreset: 'high' }, pending: 1 }, 'the client deadline must not cancel the host operation');

  await page.evaluate(() => window.modelFixture.release());
  await page.waitForFunction(() => window.modelFixture.hosts['host-a'].A.modelId === 'model-c');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  await choose(page, 'Low');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'A', model_id: 'model-c', reasoning_preset: 'low' },
  ], 'changing reasoning after a late host commit must not write the stale model back');
  assert.equal(await label(page), 'Model C');
  assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), {
    modelId: 'model-c', reasoningPreset: 'low',
  });
});

test('a fenced read rejects a timed-out request that has not started executing', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'dispatch'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.expirePending());
  await page.waitForFunction(() => window.modelFixture.error() !== null);
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.equal(await label(page), 'Model A');
  await page.evaluate(() => window.modelFixture.release());
  await settled(page);
  assert.equal(await page.evaluate(() => window.modelFixture.hosts['host-a'].A.modelId), 'model-a', 'the retired token must prevent late execution, not just suppress its acknowledgement');
  await choose(page, 'Low');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), { modelId: 'model-a', reasoningPreset: 'low' });
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'A', model_id: 'model-a', reasoning_preset: 'low' },
  ]);
});

for (const options of [{ legacy: true }, { fencing: false }]) {
  test(`an unfenced host cannot clear an unknown write with an ordinary snapshot (${JSON.stringify(options)})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.evaluate(() => window.modelFixture.expirePending());
    await page.waitForFunction(() => window.modelFixture.error() === 'Model update not confirmed. Update and restart the host, then reopen this page.');
    assert.equal(await page.$(trigger), null);
    await page.evaluate(() => window.modelFixture.release());
    await page.waitForFunction(() => window.modelFixture.hosts['host-a'].A.modelId === 'model-c');
    await page.click('.chat-model-selector__retry');
    await page.waitForFunction(() => !document.querySelector('.chat-model-selector__retry')?.disabled);
    assert.equal(await page.$(trigger), null, 'a legacy snapshot must not be advertised as proof that the request can no longer execute');
    await page.type('.chat-page__input', 'keep this draft');
    await page.click('.chat-page__send-btn');
    await page.waitForFunction(() => !document.querySelector('.chat-page__send-btn')?.disabled);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), []);
    assert.equal(await page.$eval('.chat-page__input', node => node.value), 'keep this draft');
    assert.equal(await page.evaluate(() => window.modelFixture.commands.some(command => command.cmd === 'set_session_model' && 'model_write_token' in command)), false, 'old hosts must not receive unnegotiated fields');
  });
}

test('another controller reading the catalog cannot revoke an explicit model choice', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'dispatch'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.readFromOtherController('A'));
  await page.evaluate(() => window.modelFixture.release());
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.equal(await page.evaluate(() => window.modelFixture.hosts['host-a'].A.modelId), 'model-c');
  assert.equal(await label(page), 'Model C');
  assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
});

test('same-tick service writes serialize before sending with the final host selection', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  const results = await page.evaluate(async () => {
    const manager = window.modelFixture.manager;
    const first = manager.setSessionModelSelection('A', 'model-c', null);
    const second = manager.setSessionModelSelection('A', 'model-b', 'low');
    const send = manager.sendMessage('A', 'after both writes');
    return Promise.allSettled([first, second, send]);
  });
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'A', model_id: 'model-b', reasoning_preset: 'low' },
  ]);
  assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{ sessionId: 'A', content: 'after both writes', modelId: 'model-b', reasoningPreset: 'low' }]);
});

test('a delayed catalog cannot replace the current session, including A -> B -> A', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.modelFixture.holdNext('get_model_catalog'); window.modelFixture.remount(); });
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await open(page, 'B');
  assert.equal(await label(page), 'Model B');
  await page.evaluate(() => { window.modelFixture.hosts['host-a'].A = { modelId: 'model-c', reasoningPreset: 'low' }; });
  await open(page, 'A');
  assert.equal(await label(page), 'Model C');
  await page.evaluate(() => window.modelFixture.release());
  await settled(page);
  assert.equal(await label(page), 'Model C');
  assert.equal(await selectedReasoning(page), 'Low');
  assert.deepEqual(await writes(page), []);
});

test('late model-write errors cannot leak into a different session', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await open(page, 'B');
  await page.evaluate(() => window.modelFixture.release('Old session model write failed'));
  await settled(page);
  assert.equal(await label(page), 'Model B');
  assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
  assert.equal(await page.$eval(trigger, node => node.disabled), false);
});

for (const choice of ['Model C', 'Low']) {
  test(`late ${choice} acknowledgement cannot overwrite a reopened session`, { timeout: 30_000 }, async t => {
    const page = await fixture(t);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
    await choose(page, choice);
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await open(page, 'B');
    // Another controller changes A after the held write was accepted by the host.
    await page.evaluate(() => { window.modelFixture.hosts['host-a'].A = { modelId: 'model-b', reasoningPreset: 'high' }; });
    await page.evaluate(() => window.modelFixture.open('A'));
    await page.waitForFunction(() => window.modelFixture.subscriptions.some(subscription => subscription.sessionId === 'A' && !subscription.closed));
    assert.equal(await page.$(trigger), null);
    await page.evaluate(() => window.modelFixture.release());
    await ready(page, 'A');
    assert.equal(await label(page), 'Model B');
    assert.equal(await selectedReasoning(page), 'High');
  });
}

for (const reusePage of [false, true]) {
  test(`returning to a session before an old write executes waits for the host selection (${reusePage ? 'reused page' : 'production keyed page'})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, { reusePage });
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await open(page, 'B');
    await page.evaluate(() => window.modelFixture.open('A'));
    await page.waitForFunction(() => window.modelFixture.subscriptions.some(subscription => subscription.sessionId === 'A' && !subscription.closed));
    await settled(page);
    assert.equal(await page.$(trigger), null, 'an unsettled model write must not expose stale controls, but must not block the transcript stream');
    await page.evaluate(() => window.modelFixture.release());
    await ready(page, 'A');
    assert.equal(await label(page), 'Model C');
    await choose(page, 'Low');
    await page.waitForFunction(() => !document.querySelector('.chat-model-selector__trigger')?.disabled);
    assert.deepEqual(await writes(page), [
      { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
      { session_id: 'A', model_id: 'model-c', reasoning_preset: 'low' },
    ]);
    await page.type('.chat-page__input', 'use the reconciled model');
    await page.click('.chat-page__send-btn');
    await page.waitForFunction(() => window.modelFixture.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{
      sessionId: 'A', content: 'use the reconciled model', modelId: 'model-c', reasoningPreset: 'low',
    }]);
  });
}

for (const options of [{}, { legacy: true }, { queue: true }]) {
  const host = options.queue ? 'queued host' : options.legacy ? 'legacy host' : 'direct host';
  test(`message submission waits for an outstanding model write (${host})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.type('.chat-page__input', 'wait for my model');
    await page.click('.chat-page__send-btn');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [], 'do not submit using the previous model while its replacement is pending');
    await page.evaluate(() => window.modelFixture.release());
    await page.waitForFunction(() => window.modelFixture.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{
      sessionId: 'A', content: 'wait for my model', modelId: 'model-c', reasoningPreset: options.legacy ? 'high' : null,
    }]);
  });

  test(`a rejected model write cancels the waiting submission and preserves its draft (${host})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.type('.chat-page__input', 'keep this draft');
    await page.click('.chat-page__send-btn');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), []);
    await page.evaluate(() => window.modelFixture.release('Model update rejected'));
    await page.waitForFunction(() => window.modelFixture.error() === 'Model update rejected');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), []);
    assert.equal(await page.$eval('.chat-page__input', node => node.value), 'keep this draft');
    assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), { modelId: 'model-a', reasoningPreset: 'high' });
  });

  test(`a waiting submission cannot migrate to a replacement device (${host})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.type('.chat-page__input', 'original device only');
    await page.click('.chat-page__send-btn');
    await settled(page);
    await page.evaluate(() => window.modelFixture.switchTarget('host-b'));
    await ready(page, 'A', 1);
    assert.equal(await label(page), 'Model B', 'the new target must not wait for old-target writes');
    await page.evaluate(() => window.modelFixture.release());
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), []);
    assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
    assert.equal(await label(page), 'Model B');
    assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-b'].A), { modelId: 'model-b', reasoningPreset: 'low' });
  });

  test(`a new submission after device return survives an old write's retired epoch (${host})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.evaluate(() => window.modelFixture.switchTarget('host-b'));
    await ready(page, 'A', 1);
    await page.evaluate(() => window.modelFixture.switchTarget('host-a'));
    await page.waitForFunction(() => window.modelFixture.subscriptions.some(subscription => subscription.epoch === 2 && !subscription.closed));
    await page.type('.chat-page__input', 'send after returning');
    await page.click('.chat-page__send-btn');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), []);
    await page.evaluate(() => window.modelFixture.release());
    await page.waitForFunction(() => document.querySelector('.chat-model-selector__name-text')?.textContent === 'Model C'
      && (!document.querySelector('.chat-page__send-btn')?.disabled || window.modelFixture.sent.length === 1));
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{
      sessionId: 'A', content: 'send after returning', modelId: 'model-c', reasoningPreset: options.legacy ? 'high' : null,
    }]);
    assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
  });

  test(`model writes remain isolated between accounts with matching device and session IDs (${host})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, options);
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, 'Model C');
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.evaluate(() => window.modelFixture.switchAccount('account-b'));
    await ready(page, 'A', 1);
    assert.equal(await label(page), 'Model B', 'another account must not wait for or inherit the previous account model write');
    await page.type('.chat-page__input', 'current account only');
    await page.click('.chat-page__send-btn');
    await page.waitForFunction(() => window.modelFixture.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.modelFixture.sent), [{
      sessionId: 'A', content: 'current account only', modelId: 'model-b', reasoningPreset: 'low',
    }]);
    await page.evaluate(() => { window.modelFixture.switchAccount('account-a'); window.modelFixture.remount(); });
    await page.waitForFunction(() => window.modelFixture.subscriptions.some(subscription => subscription.epoch === 2 && !subscription.closed));
    assert.equal(await page.$(trigger), null);
    await page.evaluate(() => window.modelFixture.release());
    await ready(page, 'A', 2);
    assert.equal(await label(page), 'Model C');
    assert.deepEqual(await page.evaluate(() => window.modelFixture.accountHosts['account-b']['host-a'].A), { modelId: 'model-b', reasoningPreset: 'low' });
    assert.deepEqual(await page.evaluate(() => window.modelFixture.commands.filter(command => command.cmd === 'set_session_model').map(command => command.accountId)), ['account-a']);
    assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
  });
}

test('an old acknowledgement cannot unlock another session model write in progress', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await open(page, 'B');
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Model A');
  await page.waitForFunction(() => window.modelFixture.pending.length === 2);
  await page.evaluate(() => window.modelFixture.release());
  await settled(page);
  assert.equal(await label(page), 'Model B');
  assert.equal(await page.$eval(trigger, node => node.disabled), true);
  await page.evaluate(() => window.modelFixture.release());
  await page.waitForFunction(() => !document.querySelector('.chat-model-selector__trigger')?.disabled);
  assert.equal(await label(page), 'Model A');
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'B', model_id: 'model-a', reasoning_preset: null },
  ]);
});

test('failed catalog loads show an error instead of reusing another session selection', { timeout: 30_000 }, async t => {
  const page = await fixture(t, {}, 'model-c');
  await page.evaluate(() => { window.modelFixture.holdNext('get_model_catalog'); window.modelFixture.open('B'); });
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.release('Catalog unavailable'));
  await page.waitForFunction(() => window.modelFixture.error() === 'Catalog unavailable');
  assert.equal(await page.evaluate(() => window.modelFixture.error()), 'Catalog unavailable');
  assert.equal(await page.$(trigger), null, 'the previous session model must not remain visible');
  assert.deepEqual(await writes(page), []);
});

for (const width of [390, 768, 1200]) {
  test(`catalog retry remains visible and keyboard-operable after a reduced viewport (${width}px)`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, {}, null, width);
    await page.evaluate(() => { window.modelFixture.holdNext('get_model_catalog'); window.modelFixture.open('B'); });
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.evaluate(() => window.modelFixture.release('Catalog unavailable'));
    await page.waitForSelector('.chat-model-selector__retry:not([disabled])');
    await page.setViewport({ width, height: 460 });
    await settled(page);
    assert.equal(await page.$eval('.chat-model-selector__retry', button => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth
        && rect.top >= 0 && rect.bottom <= innerHeight
        && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, 'the retry must fit in the composer and remain unobstructed');
    await page.focus('.chat-page__input');
    let focused = false;
    for (let step = 0; step < 20 && !focused; step += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.classList.contains('chat-model-selector__retry'));
    }
    assert.equal(focused, true, 'keyboard users must be able to reach the recovery control');
    await page.keyboard.press('Enter');
    await page.waitForSelector(trigger);
    assert.equal(await label(page), 'Model B');
    assert.deepEqual(await writes(page), [], 'retry is a read, not a model mutation');
  });
}

test('device changes reject old catalogs even when the session ID is the same', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.modelFixture.holdNext('get_model_catalog'); window.modelFixture.remount(); });
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.switchTarget('host-b'));
  await ready(page, 'A', 1);
  assert.equal(await label(page), 'Model B');
  await page.evaluate(() => window.modelFixture.release());
  await settled(page);
  assert.equal(await label(page), 'Model B');
  assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
  assert.deepEqual(await writes(page), []);
});

test('returning to the original device waits for its earlier model write across target epochs', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.switchTarget('host-b'));
  await ready(page, 'A', 1);
  assert.equal(await label(page), 'Model B');
  await page.evaluate(() => window.modelFixture.switchTarget('host-a'));
  await page.waitForFunction(() => window.modelFixture.subscriptions.some(subscription => subscription.epoch === 2 && !subscription.closed));
  await settled(page);
  assert.equal(await page.$(trigger), null, 'returning to the same host must not forget its outstanding mutation');
  await page.evaluate(() => window.modelFixture.release());
  await ready(page, 'A', 2);
  assert.equal(await label(page), 'Model C');
  assert.equal(await page.evaluate(() => window.modelFixture.error()), null);
  await choose(page, 'Low');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'A', model_id: 'model-c', reasoning_preset: 'low' },
  ]);
});

for (const [legacy, choice] of [[false, 'Model C'], [true, 'Model C'], [false, 'Low']]) {
  test(`host rejection preserves model and reasoning and unlocks the controls (${legacy ? 'legacy' : 'modern'}, ${choice})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, { legacy });
    await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
    await choose(page, choice);
    await page.waitForFunction(() => window.modelFixture.pending.length === 1);
    await page.evaluate(() => window.modelFixture.release('Model update rejected'));
    await page.waitForFunction(() => window.modelFixture.error() === 'Model update rejected');
    assert.equal(await label(page), 'Model A');
    assert.equal(await selectedReasoning(page), 'High');
    assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), { modelId: 'model-a', reasoningPreset: 'high' });
    assert.equal(await page.$eval(trigger, node => node.disabled), false);
    await page.evaluate(() => window.modelFixture.offline(true));
    await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled);
    assert.equal((await writes(page)).length, 1, 'disconnecting must not retry a model mutation');
  });
}

test('a lost write response reports an error and reconciles the accepted host selection without remounting', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.release('Model response lost'));
  await page.waitForFunction(() => window.modelFixture.error() === 'Model response lost');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.equal(await label(page), 'Model C', 'the error stays visible, but the label must match the host rather than presume that the write was rejected');
  assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), { modelId: 'model-c', reasoningPreset: null });
  assert.equal((await writes(page)).length, 1, 'reconciliation must read without retrying the write');
  await choose(page, 'Low');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.deepEqual(await writes(page), [
    { session_id: 'A', model_id: 'model-c', reasoning_preset: null },
    { session_id: 'A', model_id: 'model-c', reasoning_preset: 'low' },
  ], 'changing reasoning after an uncertain response must not restore the old model');
  await page.evaluate(() => window.modelFixture.remount());
  await ready(page, 'A');
  assert.equal(await label(page), 'Model C');
  assert.equal(await selectedReasoning(page), 'Low');
});

test('a lost reasoning response reconciles the accepted preset instead of assuming rollback', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Low');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => window.modelFixture.release('Reasoning response lost'));
  await page.waitForFunction(() => window.modelFixture.error() === 'Reasoning response lost');
  await page.waitForFunction(() => document.querySelector('.chat-model-selector__trigger')?.disabled === false);
  assert.equal(await label(page), 'Model A');
  assert.equal(await selectedReasoning(page), 'Low');
  assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].A), { modelId: 'model-a', reasoningPreset: 'low' });
  assert.equal((await writes(page)).length, 1);
});

test('failed reconciliation cannot re-enable a stale model selection', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await page.evaluate(() => { window.modelFixture.holdNext('get_model_catalog', 'execution'); window.modelFixture.release('Model response lost'); });
  await page.waitForFunction(() => window.modelFixture.pending.some(request => request.cmd === 'get_model_catalog'));
  assert.equal(await page.$(trigger), null);
  await page.evaluate(() => window.modelFixture.release('Reconciliation unavailable'));
  await page.waitForFunction(() => window.modelFixture.error() === 'Model update not confirmed. Reconnect, then reload the model.');
  assert.equal(await page.$(trigger), null, 'unknown host selection must not fall back to a stale one');
  assert.equal((await writes(page)).length, 1);
  await page.waitForSelector('.chat-model-selector__retry:not([disabled])');
  await page.click('.chat-model-selector__retry');
  await page.waitForSelector(trigger);
  assert.equal(await label(page), 'Model C', 'the same page must recover through a fenced read, without remounting');
  assert.equal(await page.$('.chat-model-selector__retry'), null);
  assert.equal((await writes(page)).length, 1, 'recovery must never retry the mutation');
});

test('a write executed after navigation still targets its original session', { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.modelFixture.holdNext('set_session_model', 'execution'));
  await choose(page, 'Model C');
  await page.waitForFunction(() => window.modelFixture.pending.length === 1);
  await open(page, 'B');
  await page.evaluate(() => window.modelFixture.release());
  await settled(page);
  assert.equal(await label(page), 'Model B');
  assert.deepEqual(await page.evaluate(() => window.modelFixture.hosts['host-a'].B), { modelId: 'model-b', reasoningPreset: 'low' });
  await open(page, 'A');
  assert.equal(await label(page), 'Model C');
  assert.deepEqual(await writes(page), [{ session_id: 'A', model_id: 'model-c', reasoning_preset: null }]);
});
