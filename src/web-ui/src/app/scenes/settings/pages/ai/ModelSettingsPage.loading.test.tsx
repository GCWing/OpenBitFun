// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi, systemAPI } from '@/infrastructure/api';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { ConfigConflictError, configManager } from '@/infrastructure/config/services/ConfigManager';
import { cancelPendingSettingsNavigation, getSettingsDraftSnapshot, requestAllSettingsDraftsExit } from '@/infrastructure/config/settingsDraftRegistry';
import type { AIModelConfig, ModelRoutingConfig } from '@/infrastructure/config/types';
import { i18nService } from '@/infrastructure/i18n';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
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
    await Promise.all((['settings', 'settings/models', 'settings/default-model', 'settings/media', 'components'] as const).map(
      namespace => i18nService.loadNamespace(namespace),
    ));
  });

  beforeEach(() => {
    activateSurface('local');
    configManager.clearCache();
    reads = new Map([
      'ai.models', 'ai.default_models', 'ai.proxy',
      'ai.stream_idle_timeout_secs', 'ai.stream_ttft_timeout_secs',
      'media',
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
    vi.spyOn(agentAPI, 'getModelRoutingStatus').mockResolvedValue({ apiVersion: 1, available: true,
      mode: 'manual', defaultMode: 'manual', ready: false, issue: null, connected: null, summaryEnabled: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    await i18nService.applyPersistedLanguage('en-US');
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    activateSurface('local');
  });

  const editor = () => document.querySelector<HTMLElement>(
    '.openbitfun-model-settings__editor-dialog:not([data-state="exiting"])',
  );
  const editorButton = (key: string) => [...editor()!.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === copy(key))!;
  const editorDraft = () => getSettingsDraftSnapshot().resources.find(resource => resource.id === 'model-provider-editor')!;
  const inputValue = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const openNewProvider = async (provider = 'custom') => {
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.resolve([]);
      reads.get('ai.default_models')!.resolve({});
    });
    await act(async () => button('actions.addModel').click());
    if (provider !== 'custom') {
      await inputValue(container.querySelector<HTMLInputElement>('[data-testid="settings-model-provider-search"]')!, provider);
    }
    await act(async () => container.querySelector<HTMLButtonElement>(`button[data-provider-id="${provider}"]`)!.click());
  };

  it.each([
    ['en-US', 'cancel'], ['zh-CN', 'escape'], ['zh-TW', 'close'],
  ] as const)('opens a neutral, pristine custom provider in %s and dismisses with %s', async (locale, dismissal) => {
    await i18nService.applyPersistedLanguage(locale);
    const update = vi.spyOn(configManager, 'updateConfig');
    const probe = vi.spyOn(aiApi, 'testAIConfigConnection');
    const discover = vi.spyOn(aiApi, 'listModelsByConfig');
    await openNewProvider();
    expect(editor()!.querySelector('[data-testid="settings-provider-editor-brand"]')?.textContent).toBe(copy('providerSelection.customTitle'));
    expect(editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-provider-name-input"]')!.value).toBe('');
    const endpoint = editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-base-url-input"]')!;
    expect(endpoint.value).toBe('');
    expect(endpoint.placeholder).toBe(copy('form.baseUrlPlaceholder'));
    expect(editor()!.textContent).not.toContain('bigmodel.cn');
    expect(editor()!.querySelector('.openbitfun-model-settings__resolved-url')).toBeNull();
    expect(editorDraft().dirty).toBe(false);
    expect(editor()!.getAttribute('data-preset')).toBe('panel');
    expect(editor()!.getAttribute('data-size')).toBe('xl');
    expect(endpoint.closest('[data-field-surface]')?.getAttribute('data-field-surface')).toBe('filled');
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-advanced-toggle"] button')!.click());
    expect(editorDraft().dirty).toBe(false);
    await act(async () => {
      if (dismissal === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (dismissal === 'close') editor()!.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')!.click();
      else editorButton('actions.cancel').click();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(editor()).toBeNull();
    expect(editorDraft().dirty).toBe(false);
    expect(container.querySelector('[data-openbitfun-view="selection"]')).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('button[data-provider-id="custom"]'));
    const backButton = container.querySelector<HTMLButtonElement>('[data-testid="settings-model-provider-back-btn"]')!;
    expect(backButton.getAttribute('aria-label')).toBe(copy('actions.back'));
    expect(backButton.closest('.openbitfun-config-page-header__extra')).not.toBeNull();
    expect(button('actions.cancel')).toBeUndefined();
    await act(async () => backButton.click());
    expect(container.querySelector('[data-openbitfun-view="settings"]')).not.toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it.each(['custom', 'zhipu'])('treats reverted %s fields as pristine and preserves real changes across reopen', async provider => {
    await openNewProvider(provider);
    const endpoint = () => editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-base-url-input"]')!;
    const initialUrl = endpoint().value;
    expect(editorDraft().dirty).toBe(false);
    if (provider === 'zhipu') expect(initialUrl).toContain('bigmodel.cn');
    await inputValue(endpoint(), 'https://custom.example.test/v1');
    expect(editorDraft().dirty).toBe(true);
    await inputValue(endpoint(), initialUrl);
    expect(editorDraft().dirty).toBe(false);
    await inputValue(endpoint(), 'https://custom.example.test/v1');
    await act(async () => editorButton('actions.cancel').click());
    const confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirmation.textContent).toContain(copy('draftClose.title'));
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy('draftClose.keepAndClose'))!.click());
    expect(editor()).toBeNull();
    expect(editorDraft().dirty).toBe(true);
    await act(async () => button('actions.addModel').click());
    expect(endpoint().value).toBe('https://custom.example.test/v1');
    expect(editorDraft().dirty).toBe(true);
    await inputValue(endpoint(), initialUrl);
    expect(editorDraft().dirty).toBe(false);
    await act(async () => editorButton('actions.cancel').click());
    expect(editor()).toBeNull();
    expect(container.querySelector('[data-openbitfun-view="selection"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-model-provider-search"]')!.value)
      .toBe(provider === 'custom' ? '' : provider);
  });

  describe('request format and endpoint presets', () => {
    const endpoint = () => editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-base-url-input"]')!;
    const presetPicker = () => editor()!.querySelector('[data-testid="settings-model-endpoint-preset-select"]');
    const resolvedUrl = () => editor()!.querySelector('.openbitfun-model-settings__resolved-url-value')!.textContent;
    const chooseFormat = async (format: string) => act(async () => {
      const select = editor()!.querySelector<HTMLSelectElement>('select[data-testid="settings-model-request-format-select"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, format);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    it('drops the format-only OpenAI preset picker and moves its endpoint with the format', async () => {
      await openNewProvider('openai');
      expect(presetPicker()).toBeNull();
      expect(resolvedUrl()).toBe('https://api.openai.com/v1/responses');
      await chooseFormat('openai');
      expect(endpoint().value).toBe('https://api.openai.com/v1');
      expect(resolvedUrl()).toBe('https://api.openai.com/v1/chat/completions');
      expect(presetPicker()).toBeNull();
      await chooseFormat('responses');
      expect(resolvedUrl()).toBe('https://api.openai.com/v1/responses');
    });

    it('keeps a region picker for presets that share the selected format', async () => {
      await openNewProvider('zhipu');
      expect(presetPicker()).not.toBeNull();
      await chooseFormat('anthropic');
      expect(endpoint().value).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(resolvedUrl()).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
      expect(presetPicker()).not.toBeNull();
    });

    it('moves a saved preset endpoint with the format instead of appending a second path', async () => {
      const saved = { ...model, id: 'saved-openai', name: 'OpenAI', provider: 'responses',
        base_url: 'https://api.openai.com/v1/responses' };
      await act(async () => root.render(<ModelSettingsPage />));
      await act(async () => {
        reads.get('ai.models')!.resolve([saved]);
        reads.get('ai.default_models')!.resolve({});
      });
      await act(async () => container.querySelector<HTMLButtonElement>('.openbitfun-model-settings__source-pill')!.click());
      await chooseFormat('openai');
      expect(endpoint().value).toBe('https://api.openai.com/v1');
      expect(resolvedUrl()).toBe('https://api.openai.com/v1/chat/completions');
    });
  });

  it.each(['custom', 'zhipu'])('returns a discarded %s draft to the same provider selection', async provider => {
    const update = vi.spyOn(configManager, 'updateConfig');
    await openNewProvider(provider);
    await act(async () => editorButton('actions.cancel').click());
    if (provider === 'custom') {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-model-provider-expand-btn"]')!.click());
    }
    const providerCount = container.querySelectorAll('button[data-provider-id]').length;
    await act(async () => container.querySelector<HTMLButtonElement>(`button[data-provider-id="${provider}"]`)!.click());
    const name = () => editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-provider-name-input"]')!;
    const initialName = name().value;
    await inputValue(name(), 'Unsaved provider');
    await act(async () => editorButton('actions.cancel').click());
    const confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy('draftClose.discard'))!.click());
    expect(editor()).toBeNull();
    expect(editorDraft().dirty).toBe(false);
    expect(container.querySelector('[data-openbitfun-view="selection"]')).not.toBeNull();
    expect(container.querySelectorAll('button[data-provider-id]')).toHaveLength(providerCount);
    expect(document.activeElement).toBe(container.querySelector(`button[data-provider-id="${provider}"]`));
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-model-provider-search"]')!.value)
      .toBe(provider === 'custom' ? '' : provider);
    await act(async () => container.querySelector<HTMLButtonElement>(`button[data-provider-id="${provider}"]`)!.click());
    expect(name().value).toBe(initialName);
    expect(editorDraft().dirty).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns an existing provider editor to the model overview', async () => {
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.resolve([model]);
      reads.get('ai.default_models')!.resolve({});
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.openbitfun-model-settings__source-pill')!.click());
    expect(editorDraft().dirty).toBe(false);
    await act(async () => editorButton('actions.cancel').click());
    expect(editor()).toBeNull();
    expect(container.querySelector('[data-openbitfun-view="settings"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-view="selection"]')).toBeNull();
  });

  it.each(['provider', 'model'])('does not dirty an existing %s when reselecting or restoring default request modes', async target => {
    const update = vi.spyOn(configManager, 'updateConfig');
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.resolve([model]);
      reads.get('ai.default_models')!.resolve({});
    });
    await act(async () => container.querySelector<HTMLButtonElement>(target === 'provider'
      ? '.openbitfun-model-settings__source-pill'
      : `[data-config-id="${model.id}"] button[aria-label="${copy('actions.edit')}"]`,
    )!.click());
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-advanced-toggle"] button')!.click());
    const mergeButtons = () => [...editor()!.querySelectorAll<HTMLButtonElement>('.openbitfun-model-settings__mode-button')]
      .filter(element => element.textContent === copy('advancedSettings.customHeaders.modeMerge'));
    expect(mergeButtons()).toHaveLength(2);
    await act(async () => mergeButtons().forEach(element => element.click()));
    expect(editorDraft().dirty).toBe(false);
    await act(async () => editorButton('advancedSettings.customHeaders.modeReplace').click());
    expect(editorDraft().dirty).toBe(true);
    await act(async () => mergeButtons().forEach(element => element.click()));
    expect(editorDraft().dirty).toBe(false);
    await act(async () => editorButton('advancedSettings.customRequestBody.modeTrim').click());
    expect(editorDraft().dirty).toBe(true);
    await act(async () => mergeButtons().forEach(element => element.click()));
    expect(editorDraft().dirty).toBe(false);
    await act(async () => editorButton('actions.cancel').click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(editor()).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['en-US', 'zh-CN', 'zh-TW'] as const)('saves nested model edits into the provider draft in %s', async locale => {
    await i18nService.applyPersistedLanguage(locale);
    const update = vi.spyOn(configManager, 'updateConfig');
    await openNewProvider();
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-add-custom-btn"]')!.click());
    const manualName = editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-manual-name-input"]')!;
    await inputValue(manualName, 'custom-model');
    await act(async () => manualName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-capsule-edit"]')!.click());
    await inputValue(editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-name-input"]')!, 'renamed-model');
    const save = editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-save-btn"]')!;
    expect(save.textContent).toBe(copy('actions.save'));
    await act(async () => save.click());
    expect(editor()!.querySelector('[data-testid="settings-model-name-input"]')).toBeNull();
    expect(editor()!.querySelector('[data-testid="settings-model-selected-row"]')?.getAttribute('data-model-name')).toBe('renamed-model');
    expect(editorDraft().dirty).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('protects a typed custom model and clears dirty state when that model is removed', async () => {
    await openNewProvider();
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-add-custom-btn"]')!.click());
    const name = editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-manual-name-input"]')!;
    await inputValue(name, 'custom-model');
    expect(editorDraft().dirty).toBe(true);
    await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(editor()!.querySelector('[data-testid="settings-model-selected-row"]')).not.toBeNull();
    expect(editorDraft().dirty).toBe(true);
    await act(async () => editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-selected-remove-btn"]')!.click());
    expect(editorDraft().dirty).toBe(false);
  });

  it.each([false, true])('shows host accounts on the page without importing a model (account slots: %s)', async slotsSupported => {
    const account = {
      provider: 'codex' as const, connected: true, account: 'shared@example.invalid',
      expires_at: 1800000000,
      display_label: 'Codex', suggested_format: 'openai',
      suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [],
    };
    vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue(slotsSupported ? [
      { account_id: 'codex', is_default: true, account, enabled: true },
      { account_id: 'codex:second-slot', is_default: false, account, enabled: false },
    ] : []);
    const quotaResponse = {
      provider: 'codex' as const, account_id: 'codex', state: 'known' as const, plan: 'Pro', valid_until: Date.now() / 1000 + 60,
      windows: [{ id: 'weekly', duration_seconds: 604800, used_percent: 25 }],
    };
    const pendingQuota = deferred();
    const quotaRead = vi.spyOn(aiApi, 'getSubscriptionAccountQuota')
      .mockImplementationOnce(() => pendingQuota.promise as never).mockResolvedValue(quotaResponse);
    const refreshAccount = vi.spyOn(aiApi, 'refreshSubscriptionAccount').mockResolvedValue(account);
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
    await act(async () => summary.querySelector<HTMLButtonElement>('[data-testid="settings-subscription-more"] button')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('data-preset')).toBe('panel');
    expect(dialog.getAttribute('data-size')).toBe('xl');
    expect(dialog.querySelector('[data-openbitfun-part="header"] [data-openbitfun-part="description"]')).toBeNull();
    expect(dialog.querySelector(`button[aria-label="${copy('subscriptionAuth.rescan')}"]`)).not.toBeNull();
    expect(dialog.textContent).toContain('shared@example.invalid');
    const quota = dialog.querySelector('[data-account-id="codex"] [data-openbitfun-part="subscriptionQuota"]')!;
    expect(quota.closest('.openbitfun-config-page-row__description')).not.toBeNull();
    expect(quota.querySelector('[data-openbitfun-component="card"]')).toBeNull();
    expect(quota.querySelector('[data-testid="subscription-quota-skeleton"]')).not.toBeNull();
    expect(quota.querySelector('[role="status"]')?.classList.contains('sr-only')).toBe(true);
    const heading = dialog.querySelector('[data-account-id="codex"] .openbitfun-config-page-row__label')!;
    expect(heading.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(quotaRead).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).not.toContain(copy('subscriptionAuth.pool.defaultAccount'));
    const expiry = dialog.querySelector('[data-account-id="codex"] .openbitfun-model-settings__cli-authorization-expiry')!;
    expect(expiry.parentElement).toBe(quota.parentElement);
    expect(expiry.getAttribute('datetime')).toBe(new Date(account.expires_at * 1000).toISOString());
    expect(expiry.textContent).not.toContain(i18nService.formatDate(new Date(account.expires_at * 1000), { dateStyle: 'medium', timeStyle: 'short' }));
    expect(quota.querySelector(`button[aria-label="${copy('quota.refresh')}"]`)).toBeNull();
    const refresh = [...quota.closest('.openbitfun-model-settings__cli-account')!.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy('subscriptionAuth.refresh'))!;
    expect(refresh.disabled).toBe(true);
    await act(async () => pendingQuota.resolve(quotaResponse));
    expect(quota.querySelector('[data-testid="subscription-quota-skeleton"]')).toBeNull();
    expect(quota.querySelectorAll('[data-filled="true"]')).toHaveLength(18);
    expect(heading.querySelector('[data-openbitfun-component="status-pill"]')?.textContent).toBe('Pro');
    expect(quota.querySelector('[data-openbitfun-component="status-pill"]')).toBeNull();
    expect(expiry.parentElement).toBe(quota.parentElement);
    expect(refresh.disabled).toBe(false);
    const refreshedQuota = deferred();
    quotaRead.mockImplementationOnce(() => refreshedQuota.promise as never);
    await act(async () => refresh.click());
    expect(refreshAccount).toHaveBeenCalledExactlyOnceWith('codex');
    expect(quotaRead).toHaveBeenLastCalledWith('codex', 'codex', true);
    expect(refresh.disabled).toBe(true);
    await act(async () => refreshedQuota.resolve({ ...quotaResponse,
      windows: [{ id: 'weekly', duration_seconds: 604800, used_percent: 50 }],
    }));
    expect(quota.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(refresh.disabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'subscription_pool'] as const)('merges host accounts with configured services without duplicating a %s account', async type => {
    const account = { provider: 'codex' as const, connected: true, account: 'shared@example.invalid',
      display_label: 'Codex', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [] };
    vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([
      { account_id: 'codex', is_default: true, account, enabled: true },
      { account_id: 'codex:second-slot', is_default: false, account: { ...account, account: 'unused@example.invalid' }, enabled: true },
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
    expect(summary.querySelectorAll('li')).toHaveLength(3);
    expect(summary.querySelector('[data-account-id="codex"]')).toBeNull();
    expect(summary.querySelector('[data-account-id="codex:second-slot"]')).not.toBeNull();
    const configuredProvider = summary.querySelector<HTMLButtonElement>('.openbitfun-model-settings__source-pill')!;
    expect(configuredProvider.textContent).toBe(`${model.name} · ${account.account}`);
    expect(configuredProvider.textContent).not.toContain('unused@example.invalid');
    expect(summary.querySelector('[data-account-id="codex:second-slot"]')?.textContent).toContain('unused@example.invalid');
    expect(summary.querySelector(`button[aria-label="${copy('actions.deleteProvider')}: ${model.name}"]`)).not.toBeNull();
  });

  it('filters the account browser by product, retains ZCode regions, and resets on device activation', async () => {
    const codex = { provider: 'codex' as const, connected: true, account: 'codex@example.invalid',
      display_label: 'Codex', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1', suggested_model: 'fixture-model', api_offerings: [] };
    const accounts = [codex,
      { ...codex, provider: 'zcode' as const, account: 'global@example.invalid' },
      { ...codex, provider: 'zcode_cn' as const, account: 'regional@example.invalid' },
      { ...codex, provider: 'hermes' as const, connected: false, account: 'signed-out@example.invalid' }];
    const list = vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue(accounts);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([]);
    vi.spyOn(aiApi, 'getSubscriptionAccountQuota').mockImplementation(async (provider, accountId) => ({
      provider, account_id: accountId || provider, state: 'unknown', windows: [],
    }));
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-subscription-more"] button')!.click());
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const filter = (value: string) => dialog().querySelector<HTMLButtonElement>(`[role="radio"][data-openbitfun-value="${value}"]`)!;
    expect(dialog().querySelectorAll('[data-account-id]')).toHaveLength(3);
    expect(filter('hermes')).toBeNull();
    expect(dialog().textContent).not.toContain('signed-out@example.invalid');
    expect(dialog().querySelector('[data-testid="settings-subscription-service"]')).toBeNull();
    expect(dialog().querySelector('[data-testid="settings-zcode-service"]')).toBeNull();
    expect(dialog().querySelector('[data-account-id]')?.closest('[data-openbitfun-component="field-group"]')?.getAttribute('data-appearance')).toBe('subtle');
    const codexRow = dialog().querySelector('[data-account-id="codex"]')!;
    expect(codexRow.querySelector('[data-provider-logo="codex"] [style*="mask-image"]')?.getAttribute('style')).toContain('/assets/ecosystem-compatibility/codex-icon.svg');
    expect(codexRow.querySelector('[data-openbitfun-component="avatar"]')).toBeNull();
    expect(codexRow.querySelector('.openbitfun-model-settings__cli-description-line')?.textContent).not.toContain('Codex');
    expect(filter('codex').querySelector('[style*="mask-image"]')?.getAttribute('style')).toContain('/assets/ecosystem-compatibility/codex-icon.svg');
    await act(async () => filter('zcode').click());
    expect(dialog().textContent).toContain('global@example.invalid');
    expect(dialog().textContent).toContain('regional@example.invalid');
    expect(dialog().textContent).not.toContain('codex@example.invalid');
    expect(dialog().querySelector('[data-account-id="zcode_cn"] [data-provider-logo="zcode_cn"] [style*="mask-image"]')?.getAttribute('style')).toContain('/assets/ecosystem-compatibility/zcode-icon.svg');
    await act(async () => filter('codex').click());
    expect(dialog().querySelectorAll('[data-account-id]')).toHaveLength(1);
    expect(dialog().textContent).toContain('codex@example.invalid');
    const pending = deferred();
    list.mockReturnValue(pending.promise as never);
    await act(async () => activateSurface('peer-account-browser'));
    expect(dialog().textContent).not.toContain('codex@example.invalid');
    expect(filter('all').getAttribute('aria-checked')).toBe('true');
    await act(async () => pending.resolve([{ ...codex, account: 'peer@example.invalid' }]));
    expect(dialog().textContent).toContain('peer@example.invalid');
    expect(dialog().textContent).not.toContain('codex@example.invalid');
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
      media: { image_services: [] },
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

  it.each([undefined, 3])('saves and clears the per-model image ceiling (previous: %s)', async previous => {
    const configured: AIModelConfig = {
      ...model, api_key: 'fixture-key', context_window: 128_000,
      max_images_per_request: previous,
      capabilities: ['text_chat', 'image_understanding'],
    };
    const models = [configured];
    const values: Record<string, unknown> = {
      'ai.models': models, 'ai.default_models': { primary: configured.id },
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
      `[data-config-id="${configured.id}"] button[aria-label="${copy('actions.edit')}"]`,
    )!.click());
    const editor = document.querySelector<HTMLElement>('.openbitfun-model-settings__editor-dialog')!;
    const advancedSection = editor.querySelector<HTMLElement>('[data-testid="settings-model-advanced-toggle"]');
    const advancedToggle = advancedSection?.querySelector<HTMLButtonElement>('button');
    expect(advancedToggle).not.toBeNull();
    if (advancedToggle?.getAttribute('aria-expanded') !== 'true') {
      await act(async () => advancedToggle?.click());
    }
    const input = editor.querySelector<HTMLInputElement>('[data-testid="settings-model-image-limit"]')!;
    expect(input.value).toBe(previous === undefined ? '' : '3');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, previous === undefined ? '3' : '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => editor.querySelector<HTMLButtonElement>('[data-testid="settings-model-save-btn"]')!.click());
    expect(update).toHaveBeenCalledOnce();
    const saved = await update.mock.results[0].value as AIModelConfig[];
    expect(saved[0].max_images_per_request).toBe(previous === undefined ? 3 : undefined);
    expect(saved[0].api_key).toBe(configured.api_key);
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

  it.each(['codex', 'zcode_cn'] as const)('signs in to %s directly from its card and closes after authorization', async loginProvider => {
    const account = { provider: 'codex' as const, connected: true, account: 'private@example.invalid',
      display_label: 'Codex', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1',
      suggested_model: 'fixture-model', api_offerings: [] };
    const catalog = [account, ...(['zcode', 'zcode_cn', 'workbuddy'] as const).map(provider => ({ ...account, provider }))];
    const catalogRead = deferred();
    const list = vi.mocked(aiApi.listSubscriptionAccounts).mockImplementation(() => catalogRead.promise as never);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([]);
    const quota = vi.spyOn(aiApi, 'getSubscriptionAccountQuota');
    const update = vi.spyOn(configManager, 'updateConfig');
    const status = deferred();
    const start = vi.spyOn(aiApi, 'startSubscriptionLogin').mockImplementation(async (_provider, sessionId) => ({
      session_id: sessionId!, authorization_url: 'https://example.test/login', user_code: 'REGION-CODE', method: 'device',
    }));
    vi.spyOn(aiApi, 'getSubscriptionLoginStatus').mockImplementation(() => status.promise as never);
    vi.spyOn(aiApi, 'cancelSubscriptionLogin').mockResolvedValue(undefined);
    vi.spyOn(systemAPI, 'openExternal').mockResolvedValue(undefined);
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => button('acquisition.addSubscription').click());
    const dialog = () => document.querySelector<HTMLElement>('.openbitfun-model-settings__subscription-dialog:not([aria-hidden="true"])')!;
    expect(dialog().querySelector(`button[aria-label="${copy('subscriptionAuth.rescan')}"]`)).toBeNull();
    const login = (provider: string) => [...dialog().querySelectorAll<HTMLButtonElement>(`[data-provider="${provider}"] button`)]
      .find(element => element.textContent === copy('subscriptionAuth.login'))!;
    expect(dialog().querySelector('[data-testid="settings-subscription-provider"]')).toBeNull();
    expect(dialog().textContent).toContain(copy('messages.loading'));
    list.mockResolvedValue(catalog);
    await act(async () => catalogRead.resolve(catalog));
    expect(dialog().querySelectorAll('[data-testid="settings-subscription-provider"]')).toHaveLength(2);
    expect(dialog().querySelector('input[type="radio"], [role="radiogroup"]')).toBeNull();
    expect(login('codex').disabled).toBe(false);
    expect(login('zcode').disabled).toBe(false);
    expect(dialog().textContent).not.toContain(account.account);
    expect(dialog().textContent).not.toContain(copy('subscriptionAuth.products.workbuddy'));
    expect(dialog().querySelector('[data-openbitfun-part="subscriptionAccounts"]')).toBeNull();
    expect(quota).not.toHaveBeenCalled();
    if (loginProvider === 'zcode_cn') {
      const zcode = dialog().querySelector<HTMLElement>('[data-provider="zcode"]')!;
      const capsule = zcode.querySelector('[data-openbitfun-component="capsule"]')!;
      expect(capsule.getAttribute('data-layout')).toBe('split');
      expect(capsule.getAttribute('data-split-sizing')).toBe('content');
      expect(capsule.querySelector('[data-openbitfun-component="select"]')?.getAttribute('data-width')).toBe('content');
      expect(capsule.children).toHaveLength(2);
      expect(capsule.querySelector('[role="combobox"]')).not.toBeNull();
      expect(login('zcode').parentElement).toBe(capsule);
      expect(zcode.querySelector('[role="combobox"]')?.textContent).toBe(copy('subscriptionAuth.regionsShort.zai'));
      await act(async () => zcode.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent === copy('subscriptionAuth.regions.bigmodel'))!.click());
      expect(zcode.querySelector('[role="combobox"]')?.textContent).toBe(copy('subscriptionAuth.regionsShort.bigmodel'));
    }
    await act(async () => login(loginProvider === 'zcode_cn' ? 'zcode' : loginProvider).click());
    expect(start).toHaveBeenCalledWith(loginProvider, expect.any(String), loginProvider === 'codex' ? 'device' : undefined);
    expect(dialog().textContent).toContain('REGION-CODE');
    expect(dialog().textContent).toContain(copy('subscriptionAuth.copyCode'));
    expect(dialog().textContent).not.toContain(account.account);
    expect(dialog().querySelector('[data-testid="settings-subscription-provider"]')).toBeNull();
    const tracking = dialog().querySelector('[data-testid="settings-subscription-login"]');
    expect(tracking?.getAttribute('data-provider')).toBe(loginProvider);
    expect(document.activeElement).toBe(tracking);
    expect(dialog().querySelector('[role="combobox"]')).toBeNull();
    expect(dialog().querySelector(`[aria-label="${copy('subscriptionAuth.rescan')}"]`)).toBeNull();
    if (loginProvider === 'zcode_cn') expect(tracking?.textContent).toContain(copy('subscriptionAuth.regions.bigmodel'));
    await act(async () => status.resolve({ provider: loginProvider, session_id: start.mock.calls[0][1], status: 'authorized' }));
    expect(dialog()).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });

  it('retries a failed provider login in the same new slot without showing saved accounts', async () => {
    const account = { provider: 'hermes' as const, connected: true, account: 'private@example.invalid',
      display_label: 'Hermes', suggested_format: 'openai', suggested_base_url: 'https://example.test/v1',
      suggested_model: 'fixture-model', api_offerings: [] };
    vi.mocked(aiApi.listSubscriptionAccounts).mockResolvedValue([account]);
    vi.spyOn(aiApi, 'listSubscriptionAccountInstances').mockResolvedValue([
      { account_id: 'hermes', is_default: true, account, enabled: true, supports_multiple_accounts: true },
    ]);
    const start = vi.spyOn(aiApi, 'startSubscriptionAccountLogin').mockRejectedValue(new Error('Authorization unavailable'));
    vi.spyOn(aiApi, 'cancelSubscriptionLogin').mockResolvedValue(undefined);
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => button('acquisition.addSubscription').click());
    const dialog = document.querySelector<HTMLElement>('.openbitfun-model-settings__subscription-dialog')!;
    const action = (key: string) => [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy(key))!;
    await act(async () => action('subscriptionAuth.login').click());
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Authorization unavailable');
    await act(async () => action('subscriptionAuth.retryLogin').click());
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0][1]).not.toBe('hermes');
    expect(start.mock.calls[1][1]).toBe(start.mock.calls[0][1]);
    expect(dialog.textContent).not.toContain(account.account);
    expect(dialog.querySelector('[data-testid="settings-subscription-provider"]')).toBeNull();
    await act(async () => action('subscriptionAuth.backToProviders').click());
    expect(dialog.querySelector('[data-testid="settings-subscription-login"]')).toBeNull();
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(action('subscriptionAuth.login'));
    await act(async () => action('subscriptionAuth.login').click());
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2][1]).not.toBe(start.mock.calls[0][1]);
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
    await act(async () => inModelEditor
      ? container.querySelector<HTMLButtonElement>('[data-testid="settings-subscription-services"] button')!.click()
      : button('acquisition.addSubscription').click());
    const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
    const dialogButton = (key: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent === copy(key))!;
    if (inModelEditor) {
      await act(async () => dialogButton('subscriptionAuth.import').click());
      await act(async () => dialogButton('subscriptionAuth.manageAccount').click());
    }
    if (!inModelEditor) {
      expect(dialog().querySelector('[data-openbitfun-part="subscriptionAccounts"]')).toBeNull();
      expect(dialog().textContent).not.toContain(account.account);
    }
    await act(async () => dialogButton(inModelEditor ? 'subscriptionAuth.pool.addAccount' : 'subscriptionAuth.login').click());
    expect(start).toHaveBeenCalledOnce();
    if (inModelEditor) {
      vi.useFakeTimers();
      await act(async () => started.resolve({ session_id: start.mock.calls[0][2], authorization_url: 'https://example.test/login' }));
    }
    if (!inModelEditor) expect(dialog().querySelector('[data-testid="settings-subscription-provider"]')).toBeNull();
    await act(async () => dialogButton(inModelEditor ? 'subscriptionAuth.cancel' : 'subscriptionAuth.cancelAndBack').click());
    if (!inModelEditor) {
      expect(dialog().querySelector('[data-openbitfun-status="cancelling"]')).not.toBeNull();
      expect(dialogButton('subscriptionAuth.cancelAndBack').disabled).toBe(true);
      expect(dialog().querySelector('[data-testid="settings-subscription-provider"]')).toBeNull();
    }
    if (inModelEditor) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      vi.useRealTimers();
    } else {
      await act(async () => started.resolve({ session_id: start.mock.calls[0][2], authorization_url: '' }));
    }
    expect(cancel).toHaveBeenCalled();
    expect(dialog().textContent).not.toContain(copy('subscriptionAuth.newAccount'));
    expect([...dialog().querySelectorAll<HTMLButtonElement>('button')].some(
      element => element.textContent === copy(inModelEditor ? 'subscriptionAuth.pool.addAccount' : 'subscriptionAuth.login') && !element.disabled,
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
    const defaultLabel = (key: string) => String(i18nService.getI18nInstance().t(key, { ns: 'settings/default-model' }));
    expect(selectors().map(element => element.getAttribute('aria-label'))).toEqual([
      'core.primary.label', 'core.fast.label', 'core.economy.label', 'optional.capabilities.image_understanding.label',
      'optional.capabilities.image_generation.label', 'optional.capabilities.speech_recognition.label',
    ].map(defaultLabel));
    expect(selectors().every(element => element.disabled)).toBe(true);
    expect(button('actions.addModel').disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="settings-smart-mode-configure"]')?.disabled).toBe(true);
    expect(button('acquisition.addSubscription').disabled).toBe(false);

    await act(async () => {
      reads.get('ai.models')!.resolve([model]);
      reads.get('ai.default_models')!.resolve({ primary: model.id });
    });

    expect(container.querySelector('[data-testid="settings-model-pool"]')?.textContent).toContain(model.model_name);
    expect(selectors()[0].disabled).toBe(false);
    expect(selectors()[0].textContent).toContain(model.model_name);
    expect(button('actions.addModel').disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="settings-smart-mode-configure"]')?.disabled).toBe(false);
    const imageSelector = container.querySelector<HTMLButtonElement>('[data-testid="image-service-default-select"] button[role="combobox"]')!;
    expect(imageSelector.disabled).toBe(true);
    const image = {
      id: 'loading-image-service', name: 'Image service', dialect: 'openai_images',
      base_url: 'https://images.example/v1', model_name: 'image-model', api_key: 'fixture-key',
      enabled: true, params: { n: 1 },
    };
    await act(async () => { reads.get('media')!.resolve({ image_services: [image], default_image_service: image.id }); });
    expect(imageSelector.disabled).toBe(false);
    expect(imageSelector.textContent).toContain(image.name);
    expect(selectors()[0].textContent).toContain(model.model_name);
  });

  it('projects an economy-only default onto its model card and finds it by the role label', async () => {
    const economyLabel = String(i18nService.getI18nInstance().t('core.economy.label', { ns: 'settings/default-model' }));
    const otherModel: AIModelConfig = { ...model, id: 'unassigned-model', model_name: 'unassigned-model' };
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.resolve([model, otherModel]);
      reads.get('ai.default_models')!.resolve({ economy: model.id });
    });
    const pool = container.querySelector<HTMLElement>('[data-testid="settings-model-pool"]')!;
    const card = pool.querySelector<HTMLElement>(`[data-config-id="${model.id}"]`)!;
    expect([...card.querySelectorAll('.openbitfun-model-settings__pool-tags [data-openbitfun-component="status-pill"]')]
      .map(badge => badge.textContent)).toEqual([economyLabel]);
    expect(pool.querySelectorAll('[data-testid="settings-model-row"]')).toHaveLength(2);

    const search = container.querySelector<HTMLInputElement>(`input[aria-label="${copy('pool.search')}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, economyLabel);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...container.querySelectorAll('[data-testid="settings-model-pool"] [data-testid="settings-model-row"]')]
      .map(row => row.getAttribute('data-config-id'))).toEqual([model.id]);
  });

  it('projects all five default roles once in a shared row outside the model name', async () => {
    const roleLabels = [
      'core.primary.label', 'core.fast.label', 'core.economy.label',
      'optional.capabilities.image_understanding.label', 'optional.capabilities.speech_recognition.label',
    ].map(key => String(i18nService.getI18nInstance().t(key, { ns: 'settings/default-model' })));
    const taggedModel: AIModelConfig = { ...model,
      metadata: { user_tags: [roleLabels[2]] }, recommended_for: [roleLabels[3]],
    };
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => {
      reads.get('ai.models')!.resolve([taggedModel]);
      reads.get('ai.default_models')!.resolve({ primary: model.id, fast: model.id, economy: model.id,
        image_understanding: model.id, speech_recognition: model.id });
    });
    const card = container.querySelector<HTMLElement>(`[data-testid="settings-model-pool"] [data-config-id="${model.id}"]`)!;
    const badges = [...card.querySelectorAll('.openbitfun-model-settings__pool-tags [data-openbitfun-component="status-pill"]')];
    expect(badges.map(badge => badge.textContent)).toEqual(roleLabels);
    const title = card.querySelector<HTMLElement>('[data-openbitfun-part="title"]')!;
    const description = card.querySelector<HTMLElement>('[data-openbitfun-part="description"]')!;
    const roleRow = card.querySelector<HTMLElement>('.openbitfun-model-settings__pool-tags')!;
    expect(title.textContent).toBe(model.model_name);
    expect(title.querySelector('[data-openbitfun-component="status-pill"]')).toBeNull();
    expect(roleRow.closest('[data-openbitfun-part="description"]')).toBe(description);
    expect(title.contains(roleRow)).toBe(false);
    expect(description.querySelectorAll('.openbitfun-model-settings__pool-tags')).toHaveLength(1);
    expect(badges.every(badge => description.contains(badge))).toBe(true);
  });

  it.each([false, undefined])('keeps the smart settings entry closed when host availability is %s', async available => {
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({ apiVersion: 1, available,
      mode: 'smart', defaultMode: 'smart', ready: true, issue: null, connected: true, summaryEnabled: true });
    const update = vi.spyOn(configManager, 'updateConfig');
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => { reads.get('ai.models')!.resolve([model]); reads.get('ai.default_models')!.resolve({ primary: model.id }); });
    const entry = container.querySelector<HTMLButtonElement>('[data-testid="settings-smart-mode-configure"]')!;
    expect(entry.disabled).toBe(true);
    expect(entry.textContent).toBe(copy('selectionModes.unavailable'));
    await act(async () => entry.click());
    expect(document.querySelector('.model-router-settings')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(vi.mocked(agentAPI.getModelRoutingStatus).mock.calls.every(([request]) => request?.probe !== true)).toBe(true);
  });

  it('opens the shared smart configuration dialog and saves without enabling routing', async () => {
    let routing: ModelRoutingConfig = { default_mode: 'manual', router_model_id: null,
      simple_threshold: .75, timeout_ms: 10000, summary_enabled: false };
    vi.spyOn(configManager, 'getConfigs').mockResolvedValue({ 'ai.model_routing': routing, 'ai.default_models': { primary: model.id } });
    vi.spyOn(configAPI, 'getConfig').mockResolvedValue({ primary: model.id });
    const updateConfig = vi.spyOn(configManager, 'updateConfig').mockImplementation(async <T,>(path: string, update: (current: T) => T) => {
      expect(path).toBe('ai.model_routing'); routing = update(routing as T) as ModelRoutingConfig; return routing as T;
    });
    vi.spyOn(agentAPI, 'getModelRoutingStatus').mockResolvedValue({ apiVersion: 1, available: true, mode: 'manual', defaultMode: 'manual',
      ready: false, issue: null, connected: null, summaryEnabled: false, estimatedTokenBudgetSupported: true });
    const updateSession = vi.spyOn(agentAPI, 'updateSessionModel');
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => { reads.get('ai.models')!.resolve([model]); reads.get('ai.default_models')!.resolve({ primary: model.id }); });
    expect(container.querySelector('.openbitfun-model-settings__mode-row [data-openbitfun-component="status-pill"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-smart-mode-configure"]')!.click());
    const dialog = document.querySelector<HTMLElement>('.model-router-settings')!.closest('[role="dialog"]')!;
    expect(dialog.textContent).toContain(copy('router.title'));
    expect(updateConfig).not.toHaveBeenCalled();
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === copy('router.save'))!.click());
    expect(document.querySelector('.model-router-settings')).toBeNull();
    expect(routing).not.toHaveProperty('tokenizer_path');
    expect(routing.summary_enabled).toBe(true);
    expect(routing.default_mode).toBe('manual');
    expect(updateConfig).toHaveBeenCalledOnce(); expect(updateSession).not.toHaveBeenCalled();
    expect(configAPI.getConfig).toHaveBeenCalledWith('ai.default_models');
  });

  it('closes smart configuration on a device switch and ignores its late read', async () => {
    const pending = deferred();
    vi.spyOn(configManager, 'getConfigs').mockReturnValue(pending.promise as ReturnType<typeof configManager.getConfigs>);
    const updateConfig = vi.spyOn(configManager, 'updateConfig');
    await act(async () => root.render(<ModelSettingsPage />));
    await act(async () => { reads.get('ai.models')!.resolve([model]); reads.get('ai.default_models')!.resolve({ primary: model.id }); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="settings-smart-mode-configure"]')!.click());
    expect(document.querySelector('.model-router-settings')).not.toBeNull();
    await act(async () => activateSurface('peer-smart-settings'));
    expect(document.querySelector('.model-router-settings')).toBeNull();
    await act(async () => pending.resolve({ 'ai.model_routing': {}, 'ai.default_models': { primary: model.id } }));
    expect(document.querySelector('.model-router-settings')).toBeNull();
    expect(updateConfig).not.toHaveBeenCalled();
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
        const brand = editor.querySelector<HTMLElement>('[data-testid="settings-provider-editor-brand"]')!;
        expect(brand.getAttribute('aria-label')).toBe(model.name);
        expect(editor.getAttribute('data-preset')).toBe('panel');
        expect(editor.querySelector('[data-openbitfun-part="title"]')?.classList.contains('sr-only')).toBe(true);
        expect(brand.closest('[data-openbitfun-part="heading"]')).not.toBeNull();
        if (kind === 'subscription') expect(brand.querySelector<HTMLElement>('[data-product-logo="codex"]')?.style.width).toBe('64px');
        else {
          expect(brand.getAttribute('role')).toBe('heading');
          expect(brand.textContent).toBe(model.name);
          expect(brand.querySelector('[data-product-logo]')).toBeNull();
          const advanced = editor.querySelector('[data-testid="settings-model-advanced-toggle"]')!;
          expect(advanced.classList.contains('openbitfun-model-settings__edit-section')).toBe(false);
          const models = editor.querySelector('[data-testid="settings-model-selected-list"]')!;
          expect(models.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
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
