/**
 * Live opt-in: a completed real-model turn offers a one-sentence next input
 * in the empty ChatInput, and Tab moves it into the editor.
 *
 * OPENBITFUN_E2E_PROMPT_SUGGESTION_MODELS points to a JSON file
 * `{ "models": [...], "default_models": {...} }` applied to the isolated
 * profile; credentials stay outside the test source and retained evidence.
 */

import { $, browser, expect } from '@wdio/globals';
import * as fs from 'fs';
import { ChatInput } from '../page-objects/components/ChatInput';
import { Header } from '../page-objects/components/Header';
import { StartupPage } from '../page-objects/StartupPage';
import { saveScreenshot } from '../helpers/screenshot-utils';
import { ensureWorkspaceOpen } from '../helpers/workspace-utils';

const SUGGESTION = '[data-testid="chat-input-prompt-suggestion"]';
const SUGGESTION_TEXT = '.openbitfun-chat-input__prompt-suggestion-text';

async function setConfig(path: string, value: unknown): Promise<void> {
  await browser.execute(async (configPath: string, configValue: unknown) => {
    const host = window as typeof window & {
      __TAURI__: { core: { invoke: (name: string, params: unknown) => Promise<unknown> } };
    };
    await host.__TAURI__.core.invoke('set_config', { request: { path: configPath, value: configValue } });
  }, path, value);
}

const modelsFile = process.env.OPENBITFUN_E2E_PROMPT_SUGGESTION_MODELS;
const live = modelsFile ? describe : describe.skip;

live('L1 prompt suggestion with a real model', () => {
  const chatInput = new ChatInput();
  const header = new Header();
  const startupPage = new StartupPage();

  before(async () => {
    if (process.env.OPENBITFUN_E2E_STORAGE_GUARD !== '1') throw new Error('Isolated E2E storage required');
    const { models, default_models: defaultModels } = JSON.parse(fs.readFileSync(modelsFile!, 'utf8'));
    await header.waitForLoad();
    await setConfig('ai.models', models);
    await setConfig('ai.default_models', defaultModels);
    await setConfig('app.ai_experience.enable_prompt_suggestion', true);
    await browser.refresh();
    await header.waitForLoad();
    expect(await ensureWorkspaceOpen(startupPage)).toBe(true);
    await chatInput.waitForLoad();
  });

  it('shows a one-sentence suggestion after the reply and accepts it with Tab', async () => {
    await chatInput.sendMessageWithEnter('In one short sentence, what is 2 + 2? Do not use any tools.');

    const suggestion = await $(SUGGESTION);
    await suggestion.waitForExist({ timeout: 180000, interval: 500 });
    const text = (await $(SUGGESTION_TEXT).getText()).trim();
    console.log('PROMPT_SUGGESTION_TEXT', JSON.stringify(text));
    await saveScreenshot('prompt-suggestion-visible');

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('\n');

    await chatInput.focus();
    await browser.keys(['Tab']);
    await browser.waitUntil(async () => (await chatInput.getValue()).trim() === text, {
      timeout: 5000,
      timeoutMsg: 'Tab did not move the suggestion into the editor',
    });
    expect(await $(SUGGESTION).isExisting()).toBe(false);
    await saveScreenshot('prompt-suggestion-accepted');
  });
});
