// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi, systemAPI } from '@/infrastructure/api';
import { ConfigConflictError, configManager } from '@/infrastructure/config/services/ConfigManager';
import { cancelPendingSettingsNavigation, getSettingsDraftSnapshot, requestAllSettingsDraftsExit } from '@/infrastructure/config/settingsDraftRegistry';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { i18nService } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
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
describe('ModelSettingsPage loading and provider actions', () => {
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
    configManager.clearCache();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])('shows host accounts on the page without importing a model (account slots: %s)', async slotsSupported => {
    const account = {
      provider: 'codex' as const, connected: true, account: 'shared@example.invalid',
      display_label: 'Codex', suggested_format: 'openai',
      suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [],
    };
    vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue(slotsSupported ? [
      { account_id: 'codex', is_default: true, account, enabled: true },
      { account_id: 'codex:second-slot', is_default: false, account, enabled: false },
    ] : []);
    const update = vi.spyOn(configManager, 'updateConfig');
    await act(async () => root.render(<ModelSettingsPage />));
    const summary = container.querySelector('[data-testid="settings-subscription-services"]')!;
    expect(summary.textContent).toContain('shared@example.invalid');
    expect(summary.closest('.openbitfun-config-page-row')?.textContent).toContain(copy('acquisition.subscriptions'));
    expect(summary.querySelector('ul')?.getAttribute('aria-label')).toBe(copy('acquisition.subscriptions'));
    expect(summary.querySelectorAll('[data-account-id]')).toHaveLength(slotsSupported ? 2 : 1);
    if (slotsSupported) expect(summary.textContent).toContain(copy('subscriptionAuth.pool.disabled'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    await act(async () => summary.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('shared@example.invalid');
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'subscription_pool'] as const)('merges host accounts with configured services without duplicating a %s account', async type => {
    const account = { provider: 'codex' as const, connected: true, account: 'shared@example.invalid',
      display_label: 'Codex', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [] };
    vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([
      { account_id: 'codex', is_default: true, account, enabled: true },
      { account_id: 'codex:second-slot', is_default: false, account, enabled: true },
    ]);
    const configured: AIModelConfig = { ...model, auth: type === 'subscription'
      ? { type, provider: 'codex' }
      : { type, provider: 'codex', accounts: ['codex'], revision: 0 } };
    const values: Record<string, unknown> = {
      'ai.models': [configured], 'ai.default_models': { primary: model.id },
      'ai.proxy': { enabled: false, url: '', username: '', password: '' },
      'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
    };
    vi.spyOn(configManager, 'hasCachedConfig').mockImplementation(path => path in values);
    vi.spyOn(configManager, 'getCachedConfig').mockImplementation(<T,>(path: string) => values[path] as T);
    await act(async () => root.render(<ModelSettingsPage />));
    const summary = container.querySelector('[data-testid="settings-subscription-services"]')!;
    expect(summary.querySelectorAll('li')).toHaveLength(2);
    expect(summary.querySelector('[data-account-id="codex"]')).toBeNull();
    expect(summary.querySelector('[data-account-id="codex:second-slot"]')).not.toBeNull();
    expect(summary.querySelector(`button[aria-label="${copy('actions.deleteProvider')}: ${model.name}"]`)).not.toBeNull();
  });

  it('refreshes host accounts on focus and ignores older reads without discarding accounts on failure', async () => {
    const account = { provider: 'codex' as const, connected: true, account: 'first@example.invalid',
      display_label: 'Codex', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [] };
    const list = vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([]);
    await act(async () => root.render(<ModelSettingsPage />));
    const summary = () => container.querySelector('[data-testid="settings-subscription-services"]')!;
    expect(summary().textContent).toContain(account.account);
    const old = deferred();
    list.mockImplementationOnce(() => old.promise as never).mockResolvedValueOnce([{ ...account, account: 'new@example.invalid' }]);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(summary().textContent).toContain('new@example.invalid');
    await act(async () => old.resolve([account]));
    expect(summary().textContent).not.toContain(account.account);
    list.mockRejectedValueOnce(new Error('Host account read unavailable'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(summary().textContent).toContain('new@example.invalid');
    expect(summary().textContent).toContain(copy('acquisition.loadFailed'));
  });

  it('renders a warm model pool immediately without starting a read that could overwrite edits', () => {
    const values: Record<string, unknown> = {
      'ai.models': [model], 'ai.default_models': { primary: model.id },
      'ai.proxy': { enabled: false, url: '', username: '', password: '' },
      'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
    };
    vi.spyOn(configManager, 'hasCachedConfig').mockImplementation(path => path in values);
    vi.spyOn(configManager, 'getCachedConfig').mockImplementation(<T,>(path: string) => values[path] as T);
    act(() => root.render(<ModelSettingsPage />));
    expect(container.querySelector('[data-testid="settings-model-pool"]')?.textContent).toContain(model.model_name);
    expect(selectors()[0].disabled).toBe(false);
    expect(configManager.getOptionalConfig).not.toHaveBeenCalled();
    expect(configManager.getConfig).not.toHaveBeenCalled();
  });

  it.each(['add', 'remove', 'reorder', 'manual'] as const)('protects a channel-only %s edit and saves its original model snapshot', async operation => {
    const primary: AIModelConfig = {
      ...model, api_key: 'fixture-key', context_window: 128_000, max_tokens: 8_000,
      capabilities: ['text_chat', 'function_calling'],
      metadata: { provider_instance_id: 'primary-provider' },
      ...(operation === 'add' ? {} : { channel_routing: {
        version: 1, fallback_model_ids: operation === 'reorder' ? ['backup', 'second'] : ['backup'],
      } }),
    };
    const backup: AIModelConfig = { ...primary, id: 'backup', name: 'Backup', model_name: 'backup-model',
      channel_routing: undefined, metadata: { provider_instance_id: 'backup-provider' } };
    const second: AIModelConfig = { ...backup, id: 'second', name: 'Second', model_name: 'second-model',
      metadata: { provider_instance_id: 'second-provider' } };
    const models = [primary, backup, second];
    const baseline = structuredClone(models);
    const values: Record<string, unknown> = {
      'ai.models': models, 'ai.default_models': { primary: primary.id },
      'ai.proxy': { enabled: false, url: '', username: '', password: '' },
      'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
    };
    vi.spyOn(configManager, 'hasCachedConfig').mockImplementation(path => path in values);
    vi.spyOn(configManager, 'getCachedConfig').mockImplementation(<T,>(path: string) => values[path] as T);
    const update = vi.spyOn(configManager, 'updateConfig').mockImplementation(
      async <T,>(_path: string, transform: (current: T) => T) => transform(models as T),
    );
    vi.spyOn(aiApi, 'testAIConfigConnection').mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => container.querySelector<HTMLButtonElement>(
      `[data-config-id="${primary.id}"] button[aria-label="${copy('actions.edit')}"]`,
    )!.click());
    const editor = () => document.querySelector<HTMLElement>('.openbitfun-model-settings__editor-dialog')!;
    const editorButton = (key: string) => [...editor().querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy(key))!;
    const draft = () => getSettingsDraftSnapshot().resources.find(resource => resource.id === 'model-provider-editor')!;
    expect(draft().dirty).toBe(false);
    if (operation === 'add' || operation === 'manual') {
      const label = copy(operation === 'add' ? 'channelRouting.add' : 'channelRouting.mode');
      await act(async () => editor().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent?.includes('backup-model'))!.click());
    } else {
      const label = copy(operation === 'remove' ? 'channelRouting.remove' : 'subscriptionAuth.pool.moveDown');
      await act(async () => editor().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    }
    expect(draft().dirty).toBe(true);
    const leave = vi.fn();
    expect(requestAllSettingsDraftsExit(leave)).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    cancelPendingSettingsNavigation();
    await act(async () => editorButton('actions.cancel').click());
    const confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirmation.textContent).toContain(copy('draftClose.title'));
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy('draftClose.continueEditing'))!.click());
    // A refresh/mutation of the cached object must not change the edit baseline.
    models[0].description = 'Concurrent change';
    if (operation === 'add') {
      const error = vi.spyOn(notificationService, 'error');
      update.mockRejectedValueOnce(new ConfigConflictError());
      await act(async () => editorButton('actions.save').click());
      expect(error).toHaveBeenCalledWith(copy('messages.configChanged'), undefined);
      expect(draft().dirty).toBe(true);
      expect(editor()).not.toBeNull();
      update.mockClear();
    }
    await act(async () => editorButton('actions.save').click());
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][2]).toEqual({ expectedValue: baseline });
    const saved = await update.mock.results[0].value as AIModelConfig[];
    expect(saved[0].channel_routing).toEqual({
      add: { version: 1, fallback_model_ids: ['backup'] },
      remove: undefined,
      reorder: { version: 1, fallback_model_ids: ['second', 'backup'] },
      manual: { version: 1, fallback_model_ids: ['backup'], manual_channel: 'backup' },
    }[operation]);
  });

  it.each([false, true])('cancelling a new Hermes account preserves the settings draft state (model editor: %s)', async inModelEditor => {
    const account = {
      provider: 'hermes' as const, display_label: 'Hermes', connected: true,
      account: 'Existing account', suggested_format: 'openai',
      suggested_base_url: 'https://inference-api.nousresearch.com/v1', suggested_model: 'hermes-4', api_offerings: [],
    };
    vi.spyOn(aiApi, 'listSubscriptionAccounts').mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([{
      account_id: 'hermes', is_default: true, account, enabled: true, supports_multiple_accounts: true,
    }]);
    vi.spyOn(aiApi, 'getSubscriptionAccountQuota').mockImplementation(() => new Promise(() => {}));
    const started = deferred();
    const start = vi.spyOn(aiApi, 'startSubscriptionAccountLogin').mockImplementation(() => started.promise as never);
    const cancel = vi.spyOn(aiApi, 'cancelSubscriptionLogin').mockResolvedValue(undefined);
    vi.spyOn(systemAPI, 'openExternal').mockResolvedValue(undefined);
    vi.spyOn(aiApi, 'getSubscriptionLoginStatus').mockImplementation(async (provider, sessionId) => ({
      provider, session_id: sessionId!, status: 'pending',
    }));
    const update = vi.spyOn(configManager, 'updateConfig');
    const warning = vi.spyOn(notificationService, 'warning');
    const values: Record<string, unknown> = {
      'ai.models': [model], 'ai.default_models': { primary: model.id },
      'ai.proxy': { enabled: false, url: '', username: '', password: '' },
      'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
    };
    vi.spyOn(configManager, 'hasCachedConfig').mockImplementation(path => path in values);
    vi.spyOn(configManager, 'getCachedConfig').mockImplementation(<T,>(path: string) => values[path] as T);
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => button('acquisition.import').click());
    const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
    const dialogButton = (key: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy(key))!;
    if (inModelEditor) {
      await act(async () => dialogButton('subscriptionAuth.import').click());
      await act(async () => dialogButton('subscriptionAuth.manageAccount').click());
    }
    await act(async () => dialogButton('subscriptionAuth.pool.addAccount').click());
    expect(start).toHaveBeenCalledOnce();
    if (inModelEditor) {
      vi.useFakeTimers();
      await act(async () => started.resolve({ session_id: start.mock.calls[0][2], authorization_url: 'https://example.test/login' }));
    }
    await act(async () => dialogButton('subscriptionAuth.cancel').click());
    if (inModelEditor) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      vi.useRealTimers();
    } else {
      await act(async () => started.resolve({ session_id: start.mock.calls[0][2], authorization_url: '' }));
    }
    expect(cancel).toHaveBeenCalled();
    expect(dialog().textContent).not.toContain(copy('subscriptionAuth.newAccount'));
    expect([...dialog().querySelectorAll<HTMLButtonElement>('button')].some(
      element => element.textContent === copy('subscriptionAuth.pool.addAccount') && !element.disabled,
    )).toBe(true);
    if (inModelEditor) {
      await act(async () => dialogButton('actions.done').click());
      await act(async () => dialogButton('actions.save').click());
      const missingModels = i18nService.getI18nInstance().t('messages.missingFields', {
        ns: 'settings/models', fields: copy('form.modelName'),
      });
      expect(warning).not.toHaveBeenCalled();
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(missingModels);
      expect(update).not.toHaveBeenCalled();
      vi.spyOn(aiApi, 'listModelsByConfig').mockResolvedValue([{ id: 'fixture-hermes-model' }]);
      vi.spyOn(aiApi, 'testAIConfigConnection').mockImplementation(() => new Promise(() => {}));
      update.mockImplementation(async <T,>(_path: string, transform: (current: T) => T) => transform([model] as T));
      await act(async () => dialog().querySelector<HTMLButtonElement>('[data-testid="settings-model-select"]')!.click());
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-option"]')!.click());
      await act(async () => dialogButton('actions.done').click());
      expect(document.querySelector('.openbitfun-model-settings__editor-dialog [role="alert"]')).toBeNull();
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-save-btn"]')!.click());
      expect(update).toHaveBeenCalledOnce();
      const saved = update.mock.calls[0][1]([model]) as AIModelConfig[];
      expect(saved.at(-1)?.auth).toEqual({ type: 'subscription', provider: 'hermes' });
      expect(saved.at(-1)?.model_name).toBe('fixture-hermes-model');
    } else {
      expect(getSettingsDraftSnapshot().resources.every(resource => !resource.dirty && !resource.saving)).toBe(true);
      const leave = vi.fn();
      expect(requestAllSettingsDraftsExit(leave)).toBe(true);
      expect(leave).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('shows stable content immediately and releases models without waiting for catalogs or network settings', async () => {
    await act(async () => root.render(<ModelSettingsPage />));

    for (const key of ['sections.acquisition', 'sections.selectionModes', 'sections.pool', 'sections.more']) {
      expect(container.textContent).toContain(copy(key));
    }
    for (const key of ['acquisition.noneConfigured', 'acquisition.noneImported', 'pool.empty']) {
      expect(container.textContent).not.toContain(copy(key));
    }
    expect(selectors()).toHaveLength(5);
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

  it.each([
    ['api', 'capsule'], ['api', 'editor'],
    ['subscription', 'capsule'], ['subscription', 'editor'],
  ] as const)(
    'confirms %s provider deletion from its %s before removing only that provider’s models',
    async (kind, entryPoint) => {
      const providerModels: AIModelConfig[] = [model, { ...model, id: 'second-model', model_name: 'second-model' }]
        .map(entry => ({
          ...entry,
          metadata: { provider_instance_id: 'provider-to-delete' },
          ...(kind === 'subscription' ? { auth: { type: 'subscription' as const, provider: 'codex' as const } } : {}),
        }));
      const otherModel: AIModelConfig = { ...model, id: 'other-model', name: 'Other provider' };
      let savedModels = [...providerModels, otherModel];
      const updateConfig = vi.spyOn(configManager, 'updateConfig').mockImplementation(async <T,>(_path: string, update: (current: T) => T) => {
        const updated = update(savedModels as T);
        savedModels = updated as AIModelConfig[];
        return updated;
      });
      reads.set('ai.task_models', deferred());
      reads.set('ai.agent_model_selections', deferred());
      await act(async () => root.render(<ModelSettingsPage />));
      await act(async () => {
        reads.get('ai.models')!.resolve(savedModels);
        reads.get('ai.default_models')!.resolve({ primary: model.id });
        reads.get('ai.task_models')!.resolve({});
        reads.get('ai.agent_model_selections')!.resolve({});
      });

      const providerButton = [...container.querySelectorAll<HTMLButtonElement>('.openbitfun-model-settings__source-pill')]
        .find(element => element.textContent === model.name)!;
      const capsule = providerButton.closest('[data-openbitfun-component="capsule"]')!;
      expect(capsule.getAttribute('data-action-placement')).toBe('reserved');
      expect(capsule.querySelectorAll('button')).toHaveLength(2);
      expect(providerButton.querySelector('button')).toBeNull();
      let deleteButton = capsule.querySelector<HTMLButtonElement>('.openbitfun-model-settings__source-pill-delete')!;
      expect(deleteButton.getAttribute('aria-label')).toBe(`${copy('actions.deleteProvider')}: ${model.name}`);
      if (entryPoint === 'editor') {
        await act(async () => providerButton.click());
        const editor = document.querySelector<HTMLElement>('.openbitfun-model-settings__editor-dialog')!;
        deleteButton = [...editor.querySelectorAll<HTMLButtonElement>('button')]
          .find(element => element.textContent === copy('actions.deleteProvider'))!;
      }
      await act(async () => deleteButton.click());

      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(dialog.textContent).toContain(copy('providerDeleteConfirm.title'));
      expect(dialog.textContent).toContain(String(i18nService.getI18nInstance().t('providerDeleteConfirm.message', {
        ns: 'settings/models', name: model.name, modelCount: 2, referenceCount: 1,
      })));
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(entryPoint === 'editor' ? 1 : 0);
      expect(updateConfig).not.toHaveBeenCalled();

      const cancel = dialog.querySelector<HTMLButtonElement>('button[data-openbitfun-variant="fill"]')!;
      await act(async () => cancel.click());
      expect(updateConfig).not.toHaveBeenCalled();
      expect(savedModels).toHaveLength(3);

      await act(async () => deleteButton.click());
      const confirm = document.querySelector<HTMLButtonElement>('[role="alertdialog"] button[data-openbitfun-tone="danger"]')!;
      await act(async () => confirm.click());
      expect(updateConfig).toHaveBeenCalledTimes(1);
      expect(updateConfig).toHaveBeenCalledWith('ai.models', expect.any(Function));
      expect(savedModels).toEqual([otherModel]);
      expect(container.querySelectorAll('.openbitfun-model-settings__source-pill')).toHaveLength(1);
      expect(container.querySelector('.openbitfun-model-settings__source-pill')?.textContent).toBe(otherModel.name);
    },
  );
});
