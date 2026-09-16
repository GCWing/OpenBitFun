/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getRecentReasoningPreset } from '../utils/reasoningPresets';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const aiApiMocks = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  onModelCatalogUpdated: vi.fn(),
}));

const flowChatStoreMocks = vi.hoisted(() => {
  type TestSession = {
    config: { agentType?: string; modelName?: string; reasoningPreset?: string };
  };
  const sessions = new Map<string, TestSession>();
  const subscribers = new Set<() => void>();
  const configChangeListeners = new Set<(path: string) => void>();
  const store = {
    getState: () => ({ sessions }),
    subscribe: vi.fn((callback: () => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    }),
    updateSessionModelName: vi.fn(),
    updateSessionReasoningPreset: vi.fn(),
    updateSessionMaxContextTokens: vi.fn(),
    updateAcpContextUsage: vi.fn(),
  };
  return { sessions, subscribers, configChangeListeners, store };
});

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({
  aiApi: aiApiMocks,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Switch: () => null,
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: vi.fn(),
    onConfigChange: vi.fn((listener: (path: string) => void) => {
      flowChatStoreMocks.configChangeListeners.add(listener);
      return () => flowChatStoreMocks.configChangeListeners.delete(listener);
    }),
    setConfig: vi.fn(async () => undefined),
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { updateSessionModel: vi.fn(async () => undefined) },
}));

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {
    getSessionOptions: vi.fn(),
    onSessionOptionsChanged: vi.fn(() => () => undefined),
  },
}));

vi.mock('../services/flow-chat-manager/SessionModule', () => ({
  getModelMaxTokens: vi.fn(async () => 128_000),
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../store/FlowChatStore', () => ({
  FlowChatStore: { getInstance: () => flowChatStoreMocks.store },
}));

const model = (
  id: string,
  providerName: string,
  providerInstanceId: string | undefined,
  baseUrl: string,
) => ({
  id,
  name: providerName,
  model_name: `${id}-native`,
  provider: 'openai',
  base_url: baseUrl,
  enabled: true,
  category: 'text',
  capabilities: ['text_chat'],
  ...(providerInstanceId
    ? { metadata: { provider_instance_id: providerInstanceId } }
    : {}),
});

const CATALOG_MODELS = [
  model('acme-fast', 'Acme', 'provider-acme', 'https://acme.test/v1'),
  model('acme-deep', 'Acme', 'provider-acme', 'https://acme.test/v1'),
  model('umbra-main', 'Umbra', 'provider-umbra', 'https://umbra.test/v1'),
];

const providerRows = () => Array.from(
  document.body.querySelectorAll<HTMLButtonElement>(
    '[data-testid="chat-model-selector-provider"]',
  ),
);

const modelOption = (modelId: string) => document.body.querySelector<HTMLButtonElement>(
  `[data-testid="chat-model-selector-option"][data-model-id="${modelId}"]`,
);

describe('ModelSelector provider levels', () => {
  let container: HTMLDivElement;
  let root: Root;

  const openSettingsMenu = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-btn"]',
      )?.click();
    });
  };

  const openMenu = async () => {
    await openSettingsMenu();
    const settingsModel = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    if (settingsModel) {
      await act(async () => settingsModel.click());
    }
  };

  const openProvider = async (providerKey: string) => {
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        `[data-testid="chat-model-selector-provider"][data-provider-key="${providerKey}"]`,
      )?.click();
    });
  };

  const nativeSubmenu = () => document.body.querySelector<HTMLElement>(
    '[data-testid="chat-model-selector-submenu"]',
  );

  const sharedSubmenuItems = () => nativeSubmenu()?.querySelector<HTMLElement>(
    '[data-openbitfun-part="section-items"]',
  ) ?? null;

  const renderSelector = async (
    models: unknown[] = CATALOG_MODELS,
    modeModel = 'primary',
    sessionId?: string,
  ) => {
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': models,
      'ai.default_models': { primary: 'acme-fast', fast: 'umbra-main' },
      'ai.agent_model_defaults': { mode: modeModel },
    });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          sessionId={sessionId}
          reasoningTriggerPresentation="label"
        />,
      );
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    flowChatStoreMocks.sessions.clear();
    flowChatStoreMocks.subscribers.clear();
    flowChatStoreMocks.configChangeListeners.clear();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [],
    });
    aiApiMocks.onModelCatalogUpdated.mockImplementation(() => () => undefined);
    class TestResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens with model and reasoning settings while omitting speed and reset actions', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: {
        agentType: 'Standard',
        modelName: 'umbra-main',
        reasoningPreset: 'high',
      },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();

    const settings = document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    );
    expect(settings).not.toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-model"]',
    )?.textContent).toContain('umbra-main-native');
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
    expect(settings?.querySelectorAll('button[role="menuitem"]')).toHaveLength(2);
    expect(settings?.textContent).not.toContain('modelSelector.fastMode');
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reset"]',
    )).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    const reasoningSummary = trigger?.querySelector(
      '[data-testid="chat-model-selector-trigger-reasoning"]',
    );
    const dropdownIndicator = trigger?.querySelector(
      '[data-testid="chat-model-selector-dropdown-indicator"]',
    );
    expect(reasoningSummary?.textContent).toContain('reasoningSelector.levels.high');
    expect(reasoningSummary?.nextElementSibling).toBe(dropdownIndicator);
    expect(
      container.querySelector('[data-testid="chat-reasoning-preset-selector-btn"]'),
    ).toBeNull();

  });

  it('opens generic reasoning defaults from the settings summary', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'off', label: 'Off', order: 0, source: 'adapter_fallback', actions: [{ type: 'toggle', enabled: false }] },
            { id: 'on', label: 'On', order: 1, source: 'adapter_fallback', actions: [{ type: 'toggle', enabled: true }] },
            { id: 'low', label: 'Low', order: 10, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'low' }] },
            { id: 'medium', label: 'Medium', order: 11, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 12, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-settings-reasoning"]',
      )?.click();
    });

    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('reasoning');
    const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-model-selector-reasoning-option"]',
    ));
    expect(sharedSubmenuItems()).not.toBeNull();
    expect(options.every(option => sharedSubmenuItems()?.contains(option))).toBe(true);
    expect(options.map(option => option.dataset.presetId))
      .toEqual(['auto', 'off', 'on', 'low', 'medium', 'high']);
    expect(options.every(option => (
      option.querySelector('.openbitfun-model-selector__option-desc') === null
    ))).toBe(true);
    expect(options.every(option => option.querySelector('svg') === null)).toBe(true);
    expect(options.find(option => option.dataset.presetId === 'high')?.getAttribute('aria-checked'))
      .toBe('true');
  });

  it('offers and remembers reasoning presets before a session is created', async () => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'acme-fast',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector();
    await openSettingsMenu();

    const reasoningRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    );
    expect(reasoningRow?.textContent).toContain('reasoningSelector.levels.medium');

    await act(async () => reasoningRow?.click());
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-reasoning-option"][data-preset-id="high"]',
      )?.click();
    });

    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).not.toHaveBeenCalled();
    expect(container.querySelector(
      '[data-testid="chat-model-selector-trigger-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
  });

  it('offers providers first and keeps the symbolic selectors on that level', async () => {
    await renderSelector();
    await openMenu();

    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).toBeNull();
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('models');
    expect(sharedSubmenuItems()).not.toBeNull();
    expect(providerRows().every(row => sharedSubmenuItems()?.contains(row))).toBe(true);
    expect(sharedSubmenuItems()?.contains(modelOption('primary'))).toBe(true);
    expect(sharedSubmenuItems()?.contains(modelOption('fast'))).toBe(true);
    expect(providerRows().map(row => row.dataset.providerKey))
      .toEqual(['provider-acme', 'provider-umbra']);
    expect(modelOption('primary')).not.toBeNull();
    expect(modelOption('fast')).not.toBeNull();
    const submenuButtons = Array.from(
      sharedSubmenuItems()?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    expect(submenuButtons.indexOf(modelOption('primary')!))
      .toBeLessThan(submenuButtons.indexOf(modelOption('fast')!));
    expect(submenuButtons.indexOf(modelOption('fast')!))
      .toBeLessThan(submenuButtons.indexOf(providerRows()[0]));
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-provider-selected-model"]',
    )).toBeNull();
    // A concrete model is only reachable through its provider now.
    expect(modelOption('acme-deep')).toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
  });

  it('shows only the chosen provider\'s models and applies a selection', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');

    expect(document.body.querySelector('[data-testid="chat-model-selector-back"]')).not.toBeNull();
    expect(providerRows()).toHaveLength(0);
    expect(modelOption('acme-fast')).not.toBeNull();
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(sharedSubmenuItems()).not.toBeNull();
    expect(sharedSubmenuItems()?.contains(modelOption('acme-fast'))).toBe(true);
    expect(sharedSubmenuItems()?.contains(modelOption('acme-deep'))).toBe(true);
    // The symbolic selectors belong to the provider level and are not repeated.
    expect(modelOption('primary')).toBeNull();

    await act(async () => {
      modelOption('acme-deep')?.click();
      await Promise.resolve();
    });

    expect(configManager.setConfig).toHaveBeenCalledWith(
      'ai.agent_model_defaults.mode',
      'acme-deep',
    );
  });

  it('marks the provider that owns the pinned model and shows that model beneath it', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openMenu();

    const selectedKeys = providerRows()
      .filter(row => row.dataset.selected === 'true')
      .map(row => row.dataset.providerKey);
    expect(selectedKeys).toEqual(['provider-umbra']);

    const selectedProvider = providerRows().find(
      row => row.dataset.providerKey === 'provider-umbra',
    );
    const selectedModel = selectedProvider?.querySelector<HTMLElement>(
      '[data-testid="chat-model-selector-provider-selected-model"]',
    );
    expect(selectedModel?.dataset.modelId).toBe('umbra-main');
    expect(selectedModel?.textContent).toBe('umbra-main-native');
    expect(selectedModel?.lastElementChild?.getAttribute('data-testid'))
      .toBe('chat-model-selector-provider-selected-check');
    expect(
      providerRows()
        .find(row => row.dataset.providerKey === 'provider-acme')
        ?.querySelector('[data-testid="chat-model-selector-provider-selected-model"]'),
    ).toBeNull();
  });

  it('returns to the provider level from the back control and on reopen', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-back"]',
      )?.click();
    });
    expect(providerRows()).toHaveLength(2);
    expect(modelOption('acme-deep')).toBeNull();

    await openProvider('provider-acme');
    expect(modelOption('acme-deep')).not.toBeNull();

    // Closing and reopening opens the direct model list again.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-btn"]',
      )?.click();
    });
    await openSettingsMenu();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).toBeNull();
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('models');
    expect(providerRows()).toHaveLength(2);
    expect(modelOption('acme-deep')).toBeNull();
  });

  it('keeps the selector visible and actionable when no model is configured', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [],
      'ai.default_models': {},
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('modelSelector.status.unconfigured');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'unconfigured',
      canSend: false,
    });

    await act(async () => trigger?.click());
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-status"][data-model-status="unconfigured"]',
    )).not.toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-open-settings"]',
    )).not.toBeNull();
  });

  it('blocks sending with a missing pinned ID while keeping replacement models selectable', async () => {
    const onAvailabilityChange = vi.fn();
    flowChatStoreMocks.sessions.set('missing-model-session', {
      config: { agentType: 'Standard', modelName: 'removed-id' },
    });
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(<ModelSelector currentMode="Standard" sessionId="missing-model-session"
        onAvailabilityChange={onAvailabilityChange} />);
      await Promise.resolve();
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'target-model-unavailable', canSend: false,
    });
    await openMenu();
    await openProvider('provider-acme');
    expect(modelOption('acme-fast')).not.toBeNull();
  });

  it('distinguishes configured models from enabled chat models', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [{
        ...model('disabled-model', 'Disabled', 'provider-disabled', 'https://disabled.test/v1'),
        enabled: false,
      }],
      'ai.default_models': { primary: 'disabled-model' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('modelSelector.status.noEnabledChatModel');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'no-enabled-chat-model',
      canSend: false,
    });
  });

  it('treats empty capabilities as the category default for legacy chat models', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [{
      ...model('legacy-chat', 'Legacy', 'provider-legacy', 'https://legacy.test/v1'),
      category: 'general_chat',
      capabilities: [],
      }],
      'ai.default_models': { primary: 'legacy-chat' },
      'ai.agent_model_defaults': { mode: 'legacy-chat' },
    });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'ready',
      canSend: true,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')?.click();
    });
    expect(providerRows()).toHaveLength(1);
    await openProvider('provider-legacy');
    expect(modelOption('legacy-chat')).not.toBeNull();
  });

  it('keeps model choices available when the optional catalog request fails', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast', fast: 'umbra-main' },
      'ai.agent_model_defaults': { mode: 'acme-fast' },
    });
    aiApiMocks.getModelCatalog.mockRejectedValueOnce(new Error('catalog unavailable'));

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          modeDefaultModelId="acme-fast"
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'catalog-unavailable',
      canSend: true,
    });
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')?.click();
    });
    expect(providerRows()).toHaveLength(2);
  });

  it('refreshes the selector after the model configuration is saved', async () => {
    const onAvailabilityChange = vi.fn();
    const firstModel = model('first-model', 'First', 'provider-first', 'https://first.test/v1');
    const secondModel = model('second-model', 'Second', 'provider-second', 'https://second.test/v1');

    vi.mocked(configManager.getConfigs)
      .mockResolvedValueOnce({
        'ai.models': [firstModel],
        'ai.default_models': { primary: 'first-model' },
        'ai.agent_model_defaults': { mode: 'first-model' },
      })
      .mockResolvedValueOnce({
        'ai.models': [secondModel],
        'ai.default_models': { primary: 'second-model' },
        'ai.agent_model_defaults': { mode: 'second-model' },
      });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent)
      .toContain('first-model-native');

    const listeners = [...flowChatStoreMocks.configChangeListeners];
    expect(listeners).toHaveLength(1);
    await act(async () => {
      // ModelSettingsPage writes ai.models through ConfigManager's ai-scoped
      // mutation notification, so this is the post-save event to handle.
      listeners[0]?.('ai');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent)
      .toContain('second-model-native');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'ready',
      canSend: true,
    });
  });

  it('lets Escape step out of a provider, then closes the direct model list', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');

    const pressEscape = async () => {
      await act(async () => {
        nativeSubmenu()
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    };

    await pressEscape();
    expect(providerRows()).toHaveLength(2);

    await pressEscape();
    expect(nativeSubmenu()).toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    )?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens native submenus only by click, keeps the parent stable, and toggles them explicitly', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    const modelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    const reasoningRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    );

    await act(async () => {
      modelRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      modelRow?.focus();
    });
    expect(nativeSubmenu()).toBeNull();

    await act(async () => modelRow?.click());
    expect(modelRow?.getAttribute('aria-expanded')).toBe('true');
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('models');
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();

    await act(async () => {
      modelRow?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      reasoningRow?.focus();
    });
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('models');

    await act(async () => reasoningRow?.click());
    expect(modelRow?.getAttribute('aria-expanded')).toBe('false');
    expect(reasoningRow?.getAttribute('aria-expanded')).toBe('true');
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('reasoning');

    await act(async () => reasoningRow?.click());
    expect(nativeSubmenu()).toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();
  });

  it('supports Right and Left Arrow navigation and closes both menus on outside click', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    const modelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    modelRow?.focus();

    await act(async () => {
      modelRow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise(resolve => window.setTimeout(resolve, 25));
    });
    expect(nativeSubmenu()?.dataset.submenuKind).toBe('models');
    expect(nativeSubmenu()?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      nativeSubmenu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(nativeSubmenu()).toBeNull();
    expect(document.activeElement).toBe(modelRow);

    await act(async () => modelRow?.click());
    expect(nativeSubmenu()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(nativeSubmenu()).toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-menu"]',
    )?.getAttribute('data-open')).toBe('false');
  });

  it('keeps a config written before the provider-instance migration visible', async () => {
    // Upgraded installs can still hold models without the grouping metadata;
    // they must stay selectable as their own provider rather than disappear.
    await renderSelector([
      ...CATALOG_MODELS,
      model('legacy-model', 'Legacy endpoint', undefined, 'https://legacy.test/v1'),
    ]);
    await openMenu();

    expect(providerRows().map(row => row.dataset.providerKey))
      .toEqual(['provider-acme', 'provider-umbra', 'legacy-model']);

    await openProvider('legacy-model');
    expect(modelOption('legacy-model')).not.toBeNull();
  });
});
