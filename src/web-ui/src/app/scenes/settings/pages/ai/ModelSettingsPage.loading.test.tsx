// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '@/infrastructure/api';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { i18nService } from '@/infrastructure/i18n';
import ModelSettingsPage from './ModelSettingsPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const model: AIModelConfig = {
  id: 'loading-test-model',
  name: 'Test provider',
  model_name: 'loading-test-model',
  provider: 'openai',
  base_url: 'https://example.test/v1',
  api_key: '',
  enabled: true,
  category: 'general_chat',
  capabilities: ['text_chat'],
};

// Service reads are controlled to exercise pending, failed, and recovered states.
// The actual settings and design-system components render; this is not visual QA.
describe('ModelSettingsPage independent loading', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reads: Map<string, ReturnType<typeof deferred>>;
  const copy = (key: string) => String(i18nService.getI18nInstance().t(key, { ns: 'settings/models' }));
  const button = (key: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === copy(key))!;
  const selectors = () => [...container.querySelectorAll<HTMLButtonElement>(
    '.default-model-config [role="combobox"]',
  )];

  beforeAll(async () => {
    await Promise.all((['settings', 'settings/models', 'settings/default-model', 'components'] as const).map(
      namespace => i18nService.loadNamespace(namespace),
    ));
  });

  beforeEach(() => {
    reads = new Map([
      'ai.models', 'ai.default_models', 'ai.proxy',
      'ai.stream_idle_timeout_secs', 'ai.stream_ttft_timeout_secs',
    ].map(path => [path, deferred()]));
    vi.spyOn(configManager, 'getOptionalConfig').mockImplementation(
      <T,>(path: string) => reads.get(path)!.promise as Promise<T | undefined>,
    );
    vi.spyOn(configManager, 'getConfig').mockImplementation(
      <T,>(path?: string) => reads.get(path!)!.promise as Promise<T>,
    );
    vi.spyOn(aiApi, 'getModelCatalog').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(aiApi, 'getLocalModelsDevCatalogs').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(aiApi, 'getModelsDevCatalogStatus').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(aiApi, 'listSubscriptionAccounts').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(aiApi, 'onModelCatalogUpdated').mockReturnValue(() => {});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows stable content immediately and releases models without waiting for catalogs or network settings', async () => {
    await act(async () => root.render(<ModelSettingsPage />));

    for (const key of ['sections.acquisition', 'sections.selectionModes', 'sections.pool', 'sections.more']) {
      expect(container.textContent).toContain(copy(key));
    }
    for (const key of ['acquisition.noneConfigured', 'acquisition.noneImported', 'pool.empty']) {
      expect(container.textContent).not.toContain(copy(key));
    }
    expect(selectors()).toHaveLength(4);
    expect(selectors().every(element => element.disabled)).toBe(true);
    expect(button('actions.addModel').disabled).toBe(true);
    expect(button('acquisition.import').disabled).toBe(false);

    await act(async () => {
      reads.get('ai.models')!.resolve([model]);
      reads.get('ai.default_models')!.resolve({ primary: model.id });
    });

    expect(container.querySelector('[data-testid="settings-model-pool"]')?.textContent).toContain(model.model_name);
    expect(selectors()[0].disabled).toBe(false);
    expect(selectors()[0].textContent).toContain(model.model_name);
    expect(button('actions.addModel').disabled).toBe(false);
  });

  it('isolates a failed model read, keeps network settings usable, and recovers through the section retry', async () => {
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.reject(new Error('Model host unavailable'));
      reads.get('ai.default_models')!.resolve({});
      reads.get('ai.proxy')!.resolve({ enabled: true, url: 'http://localhost:7890' });
      reads.get('ai.stream_idle_timeout_secs')!.resolve(120);
      reads.get('ai.stream_ttft_timeout_secs')!.resolve(60);
    });

    expect(container.textContent).toContain(copy('messages.loadFailedLocked'));
    expect(container.textContent).toContain(copy('sections.selectionModes'));
    expect(container.textContent).not.toContain(copy('pool.empty'));
    expect(selectors().every(element => element.disabled)).toBe(true);
    await act(async () => button('sections.more').click());
    const proxy = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find(element => element.value === 'http://localhost:7890');
    expect(proxy?.disabled).toBe(false);
    expect([...container.querySelectorAll<HTMLInputElement>('input')].some(
      element => element.value === '120' && !element.disabled,
    )).toBe(true);

    reads.set('ai.models', deferred());
    await act(async () => button('messages.retry').click());
    await act(async () => reads.get('ai.models')!.resolve([model]));
    expect(container.textContent).not.toContain(copy('messages.loadFailedLocked'));
    expect(container.querySelector('[data-testid="settings-model-pool"]')?.textContent).toContain(model.model_name);
    expect(button('actions.addModel').disabled).toBe(false);
  });
});
