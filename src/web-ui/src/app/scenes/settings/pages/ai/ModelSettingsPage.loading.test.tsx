// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi, systemAPI } from '@/infrastructure/api';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getSettingsDraftSnapshot, requestAllSettingsDraftsExit } from '@/infrastructure/config/settingsDraftRegistry';
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

  it.each([false, true])('cancelling a new WorkBuddy account preserves the settings draft state (model editor: %s)', async inModelEditor => {
    const account = {
      provider: 'workbuddy' as const, display_label: 'WorkBuddy', connected: true,
      account: 'Existing account', suggested_format: 'openai',
      suggested_base_url: 'https://copilot.tencent.com/v2', suggested_model: 'auto', api_offerings: [],
    };
    vi.spyOn(aiApi, 'listSubscriptionAccounts').mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([{
      account_id: 'workbuddy', is_default: true, account, enabled: true, supports_multiple_accounts: true,
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
      vi.spyOn(aiApi, 'listModelsByConfig').mockResolvedValue([{ id: 'fixture-workbuddy-model' }]);
      vi.spyOn(aiApi, 'testAIConfigConnection').mockImplementation(() => new Promise(() => {}));
      update.mockImplementation(async <T,>(_path: string, transform: (current: T) => T) => transform([model] as T));
      await act(async () => dialog().querySelector<HTMLButtonElement>('[data-testid="settings-model-select"]')!.click());
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-option"]')!.click());
      await act(async () => dialogButton('actions.done').click());
      expect(document.querySelector('.openbitfun-model-settings__editor-dialog [role="alert"]')).toBeNull();
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-save-btn"]')!.click());
      expect(update).toHaveBeenCalledOnce();
      const saved = update.mock.calls[0][1]([model]) as AIModelConfig[];
      expect(saved.at(-1)?.auth).toEqual({ type: 'subscription', provider: 'workbuddy' });
      expect(saved.at(-1)?.model_name).toBe('fixture-workbuddy-model');
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

  it.each(['api', 'subscription'] as const)(
    'confirms %s capsule deletion before removing only that provider’s models',
    async kind => {
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

      const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('.openbitfun-model-settings__source-pill-delete')]
        .find(element => element.getAttribute('aria-label')?.endsWith(`: ${model.name}`))!;
      expect(deleteButton.getAttribute('aria-label')).toContain(model.name);
      expect(deleteButton.parentElement?.closest('button')).toBeNull();
      await act(async () => deleteButton.click());

      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(dialog.textContent).toContain(copy('providerDeleteConfirm.title'));
      expect(dialog.textContent).toContain(String(i18nService.getI18nInstance().t('providerDeleteConfirm.message', {
        ns: 'settings/models', name: model.name, modelCount: 2, referenceCount: 1,
      })));
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
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
