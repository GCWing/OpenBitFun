/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBillingDetails } from './ModelBillingDetails';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { configManager } from '../services/ConfigManager';
import { getModelBilling, modelBillingBinding, withModelBilling } from '../services/modelBilling';
import type { AIModelConfig } from '../types';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatDate: () => 'date' }) }));
vi.mock('../services/ConfigManager', () => ({ configManager: { updateConfig: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('billing editor', () => {
  let root: Root;
  let container: HTMLDivElement;
  let model: AIModelConfig;
  let hostModels: AIModelConfig[];
  const onClose = vi.fn(); const onSaved = vi.fn();
  const render = async () => { await act(async () => root.render(<ModelBillingDetails model={model} onClose={onClose} onSaved={onSaved} />)); };
  const saveButton = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'billing.save')!;
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    model = { id: 'configured', name: 'Account channel', model_name: 'model', base_url: 'https://provider.test', provider: 'openai', category: 'text', capabilities: ['text_chat'], enabled: true };
    model = withModelBilling(model, { version: 1, kind: 'api', currency: 'CNY', input: 0, source: 'Account rates', account: '', updatedAt: '2026-10-16T00:00:00Z', binding: modelBillingBinding(model) });
    hostModels = [model];
    vi.mocked(configManager.updateConfig).mockImplementation(async (_path, update) => { hostModels = update(hostModels) as AIModelConfig[]; return hostModels; });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('round-trips explicit free input and blank unknown rates through the real config owner', async () => {
    await render();
    const rates = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    expect(rates.map(input => input.value)).toEqual(['0', '', '']);
    await act(async () => saveButton().click());
    expect(configManager.updateConfig).toHaveBeenCalledWith('ai.models', expect.any(Function));
    expect(getModelBilling(hostModels[0])?.input).toBe(0);
    expect(getModelBilling(hostModels[0])?.output).toBeUndefined();
    expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves an unsupported future billing record instead of replacing it with defaults', async () => {
    model = { ...model, metadata: { billing_v1: { version: 2, privateField: 'keep' } } };
    await render();
    expect(document.body.textContent).toContain('billing.unsupported');
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it('describes subscription pools and scopes their quotes without inferring a price', async () => {
    model = { ...model, auth: { type: 'subscription_pool', provider: 'codex', accounts: ['one', 'two'], revision: 1 }, metadata: {} };
    hostModels = [model];
    await render();
    expect(document.body.textContent).toContain('billing.subscriptionAuthHint');
    expect(document.body.textContent).not.toContain('billing.apiAuthHint');
    expect(document.body.textContent).toContain('billing.routingScopeHint');
    expect(document.body.querySelectorAll('input[type="number"]')).toHaveLength(0);
    await act(async () => saveButton().click());
    expect(getModelBilling(hostModels[0])?.kind).toBe('unknown');
    expect(getModelBilling(hostModels[0])?.input).toBeUndefined();
  });

  it('keeps the editor open and retains newer host data when the channel changed', async () => {
    await render(); hostModels = [{ ...model, base_url: 'https://new-provider.test' }];
    await act(async () => saveButton().click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('billing.saveFailed');
    expect(onClose).not.toHaveBeenCalled();
    expect(hostModels[0].base_url).toBe('https://new-provider.test');
  });

  it('prevents duplicate writes and ignores late success after switching devices', async () => {
    let finish!: () => void;
    vi.mocked(configManager.updateConfig).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(hostModels); }));
    await render(); await act(async () => saveButton().click());
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(configManager.updateConfig).toHaveBeenCalledOnce();
    activateSurface('peer'); await act(async () => finish());
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});
