/**
 * @vitest-environment jsdom
 */

import { act, cloneElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getRecentReasoningPreset } from '../utils/reasoningPresets';
import { getRecentManualModel } from '../utils/manualModelSelection';
import { getActiveSurfaceScope, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { useConfirmDialogStore } from '@/infrastructure/confirm-dialog';
import { notificationStore } from '@/shared/notification-system';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type { AIModelCatalog } from '@/infrastructure/api/service-api/AIApi';

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
  Tooltip: ({ children, content, disabled }: {
    children: React.ReactElement<{ 'data-tooltip'?: string }>;
    content?: React.ReactNode;
    disabled?: boolean;
  }) => cloneElement(children, {
    'data-tooltip': !disabled && typeof content === 'string' ? content : undefined,
  }),
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

  const modeTrigger = () => document.body.querySelector<HTMLButtonElement>(
    '[data-testid="chat-model-selector-settings-mode"]',
  )!;

  const modeChoices = () => document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-mode-choices"]');
  const modeOption = (mode: 'manual' | 'smart' | 'pool') => modeChoices()?.querySelector<HTMLButtonElement>(
    `[data-openbitfun-value="${mode}"]`,
  ) ?? null;
  const modeTooltip = (mode: 'manual' | 'smart' | 'pool') => modeOption(mode)?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip');

  const openModeMenu = async () => {
    await openSettingsMenu();
    await act(async () => modeTrigger().click());
  };

  const openProvider = async (providerKey: string) => {
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        `[data-testid="chat-model-selector-provider"][data-provider-key="${providerKey}"]`,
      )?.click();
    });
  };

  const optionsPanel = () => document.body.querySelector<HTMLElement>(
    '[data-testid="chat-model-selector-options"]',
  );

  const sharedPanelItems = () => optionsPanel()?.querySelector<HTMLElement>(
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
    notificationStore.clearActiveNotifications();
    notificationStore.clearHistory();
    flowChatStoreMocks.sessions.clear();
    flowChatStoreMocks.subscribers.clear();
    flowChatStoreMocks.configChangeListeners.clear();
    flowChatStoreMocks.store.updateSessionModelName.mockImplementation((sessionId: string, modelName: string) => {
      const session = flowChatStoreMocks.sessions.get(sessionId);
      if (session) session.config.modelName = modelName;
      flowChatStoreMocks.subscribers.forEach(callback => callback());
    });
    flowChatStoreMocks.store.updateSessionReasoningPreset.mockImplementation((sessionId: string, preset?: string) => {
      const session = flowChatStoreMocks.sessions.get(sessionId);
      if (session) session.config.reasoningPreset = preset;
      flowChatStoreMocks.subscribers.forEach(callback => callback());
    });
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
    useConfirmDialogStore.getState().cancel();
    notificationStore.clearActiveNotifications();
    notificationStore.clearHistory();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps loading feedback through configuration and catalog loading, then focuses the ready card', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    let resolveConfig!: (config: Record<string, unknown>) => void;
    let resolveCatalog!: (catalog: AIModelCatalog) => void;
    vi.mocked(configManager.getConfigs).mockReturnValueOnce(new Promise(resolve => {
      resolveConfig = resolve;
    }));
    aiApiMocks.getModelCatalog.mockReturnValueOnce(new Promise<AIModelCatalog>(resolve => {
      resolveCatalog = resolve;
    }));
    await renderSelector();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      vi.advanceTimersToNextFrame();
    });
    const menu = document.body.querySelector('[data-testid="chat-model-selector-menu"]')!;
    const loadingState = () => menu.querySelector('[data-testid="chat-model-selector-loading"]');
    expect(loadingState()?.getAttribute('role')).toBe('status');
    expect(loadingState()?.textContent).toContain('modelSelector.status.loading');
    expect(loadingState()?.querySelector('[data-openbitfun-component="spinner"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => resolveConfig({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    }));
    expect(aiApiMocks.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(loadingState()).not.toBeNull();
    expect(menu.getAttribute('aria-busy')).toBe('true');

    await act(async () => resolveCatalog({ version: 1, models: [] }));
    await act(async () => { vi.advanceTimersToNextFrame(); });
    const modelField = menu.querySelector('[data-testid="chat-model-selector-settings-model"]');
    expect(loadingState()).toBeNull();
    expect(modelField?.textContent).toContain('acme-fast-native');
    expect(trigger.hasAttribute('aria-busy')).toBe(false);
    expect(menu.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(modelField);
  });

  it.each(['configuration', 'catalog'])('leaves loading when the %s request fails', async source => {
    let rejectLoad!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    if (source === 'configuration') {
      vi.mocked(configManager.getConfigs).mockReturnValueOnce(pending);
    } else {
      aiApiMocks.getModelCatalog.mockReturnValueOnce(pending);
    }
    await renderSelector();
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).not.toBeNull();

    await act(async () => rejectLoad(new Error('Host offline')));
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    const modelField = document.body.querySelector('[data-testid="chat-model-selector-settings-model"]');
    expect(modelField?.textContent).toContain(source === 'configuration'
      ? 'modelSelector.status.loadError' : 'acme-fast-native');
  });

  it('preserves model information during a catalog refresh', async () => {
    await renderSelector();
    await openSettingsMenu();
    const modelField = document.body.querySelector('[data-testid="chat-model-selector-settings-model"]');
    let resolveCatalog!: (catalog: AIModelCatalog) => void;
    aiApiMocks.getModelCatalog.mockReturnValueOnce(new Promise<AIModelCatalog>(resolve => {
      resolveCatalog = resolve;
    }));
    await act(async () => { aiApiMocks.onModelCatalogUpdated.mock.calls[0][0](); });

    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-busy')).toBe('true');
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
    expect(modelField?.textContent).toContain('acme-fast-native');

    await act(async () => resolveCatalog({ version: 2, models: [] }));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
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
    expect(settings?.querySelector('.openbitfun-model-selector__model-provider')?.textContent)
      .toBe('Umbra');
    const providerLabel = settings?.querySelector<HTMLElement>('.openbitfun-model-selector__model-provider');
    expect(providerLabel?.closest('button')).toBe(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-provider"]',
    ));
    expect(optionsPanel()).toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
    expect(settings?.querySelectorAll('button[role="menuitem"]')).toHaveLength(4);
    expect(settings?.querySelector('.openbitfun-model-selector__mode-footer')?.contains(modeTrigger())).toBe(true);
    expect(settings?.querySelector('.openbitfun-reasoning-control')?.contains(modeTrigger())).toBe(false);
    expect(modeTrigger().textContent).toBe('modelSelector.modes.manual');
    expect(settings?.querySelector('.openbitfun-reasoning-control__title')).toBeNull();
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

  it('opens the resolved primary provider directly and returns focus to its shortcut', async () => {
    await renderSelector();
    await openSettingsMenu();

    const providerControl = () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-provider"]',
    )!;
    expect(providerControl().textContent).toBe('Acme');
    await act(async () => providerControl().click());

    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')
      ?.getAttribute('data-menu-level')).toBe('provider');
    expect(providerRows()).toHaveLength(0);
    expect(modelOption('acme-fast')?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(modelOption('acme-fast'));
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(modelOption('primary')).toBeNull();

    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-back"]',
    )!.click());
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(providerControl());

    await act(async () => providerControl().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ));
    expect(modelOption('acme-deep')).not.toBeNull();
    await act(async () => optionsPanel()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(providerControl());
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('presents an existing enabled override as Auto without rewriting it', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'on' },
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
    expect(optionsPanel()).toBeNull();
    const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-model-selector-reasoning-options"] button',
    ));
    expect(options.every(option => option.closest('[data-testid="chat-model-selector-settings"]'))).toBe(true);
    expect(options.map(option => option.dataset.openbitfunValue))
      .toEqual(['auto', 'preset:off', 'preset:low', 'preset:medium', 'preset:high']);
    expect(options.find(option => option.dataset.openbitfunValue === 'unavailable:xhigh')).toBeUndefined();
    expect(options.every(option => (
      option.querySelector('.openbitfun-model-selector__option-desc') === null
    ))).toBe(true);
    expect(options.every(option => option.querySelector('svg') === null)).toBe(true);
    expect(options.find(option => option.dataset.openbitfunValue === 'auto')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
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
    expect(reasoningRow?.textContent).toBe('reasoningSelector.thinking · reasoningSelector.auto');

    await act(async () => reasoningRow?.click());
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-openbitfun-value="preset:high"]',
      )?.click();
    });

    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).not.toHaveBeenCalled();
    expect(container.querySelector(
      '[data-testid="chat-model-selector-trigger-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
  });

  it.each(['smart', 'pool'] as const)('selects %s mode with a notification-center notice and no blocking dialog', async (mode) => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1, default_models: { primary: 'acme-fast' },
      models: [{ id: 'umbra-main', reasoning: { status: 'unknown', presets: [] } }, { id: 'acme-fast', reasoning: {
        status: 'known', default_preset: 'high',
        presets: [{ id: 'high', label: 'High', order: 1, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] }],
      } }],
    });
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="chat-model-selector-reasoning-status"]')).toBeNull();
    expect(modeChoices()).toBeNull();
    await act(async () => modeTrigger().click());
    expect(optionsPanel()).toBeNull();
    expect(modeChoices()?.querySelectorAll('button')).toHaveLength(3);
    expect(modeChoices()?.querySelector('[role="menuitemradio"]')).toBeNull();
    expect(modeOption('manual')?.getAttribute('aria-pressed')).toBe('true');
    expect(modeOption('manual')?.textContent).toBe('modelSelector.modes.manual');
    expect(modeTooltip('manual')).toBe('umbra-main-native');
    expect(document.body.querySelector('.openbitfun-model-selector__model-summary[aria-hidden="true"][inert]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-reasoning-status"]')).toBeNull();
    expect(document.body.querySelector('.openbitfun-model-selector__mode-footer[aria-hidden="true"][inert]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')?.getAttribute('data-menu-level')).toBe('settings');
    expect(modelOption('primary')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    const entry = modeOption(mode)!;
    expect(modeTooltip(mode)).toBe('modelSelector.modes.comingSoon');
    await act(async () => entry.click());

    expect(useConfirmDialogStore.getState().isOpen).toBe(false);
    expect(notificationStore.getState().notificationHistory).toEqual([expect.objectContaining({
      title: `modelSelector.modes.${mode}`,
      message: 'modelSelector.modes.developmentNotice',
      type: 'info',
      showInCenter: true,
    })]);
    expect(notificationStore.getState().unreadCount).toBe(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.textContent).toContain(`modelSelector.modes.${mode}`);
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'primary');
    expect(document.activeElement).toBe(modeTrigger());
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')?.getAttribute('data-model-mode')).toBe(mode);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')).toBeNull();
    const settings = document.body.querySelector('[data-testid="chat-model-selector-settings"]')!;
    expect(settings.textContent).toBe(`modelSelector.modes.${mode}`);
    expect(settings.querySelector('.openbitfun-model-selector__model-provider')).toBeNull();
    expect(settings.querySelector('.openbitfun-model-selector__model-name')).toBeNull();
    expect(modeTrigger().closest('.openbitfun-model-selector__mode-summary')).not.toBeNull();
    await act(async () => settings.click());
    expect(optionsPanel()).toBeNull();
    await act(async () => modeTrigger().click());
    expect(modeChoices()).not.toBeNull();
    expect(modeOption(mode)?.getAttribute('aria-pressed')).toBe('true');
    expect(modeTooltip('manual')).toBe('umbra-main-native');
    await act(async () => modeOption('manual')!.click());
    expect(trigger.textContent).not.toContain(`modelSelector.modes.${mode}`);
    expect(trigger.textContent).toContain('umbra-main-native');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(modeTrigger().textContent).toBe('modelSelector.modes.manual');
    expect(document.activeElement).toBe(modeTrigger());
  });

  it('sends the primary model and automatic reasoning to an existing session for an upcoming mode', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'primary', reasoningPreset: 'high' },
    });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openModeMenu();
    await act(async () => modeOption('smart')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: 'primary', reasoningPreset: null,
    }));
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).toHaveBeenCalledWith('session-a', undefined);
  });

  it('does not enter an upcoming mode when switching to primary fails', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    vi.mocked(configManager.setConfig).mockRejectedValueOnce(new Error('Settings unavailable'));
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    expect(useConfirmDialogStore.getState().isOpen).toBe(false);
    expect(notificationStore.getState().notificationHistory.filter(notice => notice.type === 'info')).toEqual([]);
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent).toContain('umbra-main-native');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(modeChoices()).not.toBeNull();
    expect(document.activeElement).toBe(modeOption('pool'));
  });

  it('disables upcoming modes when their primary-model fallback is unavailable', async () => {
    await renderSelector([]);
    await openModeMenu();
    const entry = modeOption('smart')!;
    expect(entry.disabled).toBe(true);
    await act(async () => entry.click());
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(useConfirmDialogStore.getState().isOpen).toBe(false);
    expect(notificationStore.getState().notificationHistory).toEqual([]);
  });

  it('restores the last manually chosen session model after switching between both upcoming modes', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main' },
    });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openMenu();
    expect(modeOption('smart')).toBeNull();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());

    for (const mode of ['smart', 'pool'] as const) {
      await act(async () => modeTrigger().click());
      expect(modeTooltip('manual')).toBe('acme-deep-native');
      await act(async () => modeOption(mode)!.click());
    }
    await act(async () => modeTrigger().click());
    await act(async () => modeOption('manual')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: 'acme-deep',
    }));
    expect(configManager.setConfig).toHaveBeenLastCalledWith('ai.agent_model_defaults.mode', 'acme-deep');
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
    expect(getRecentManualModel(getActiveSurfaceScope().key('model-selector', 'Standard', 'session-a')))
      .toBe('acme-deep');
  });

  it('keeps manual memory through remounts and isolates it from other sessions and devices', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main' },
    });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openModeMenu();
    await act(async () => modeOption('smart')!.click());
    expect(getRecentManualModel(getActiveSurfaceScope().key('model-selector', 'Standard', 'session-b')))
      .toBeUndefined();
    expect(getRecentManualModel(surfaceScopedKey('other-device', 'model-selector', 'Standard', 'session-a')))
      .toBeUndefined();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openModeMenu();
    expect(modeTooltip('manual')).toBe('umbra-main-native');
    await act(async () => modeOption('manual')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: 'umbra-main',
    }));
  });

  it('retains the saved manual model when restoration fails and allows retrying', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    await act(async () => modeTrigger().click());
    vi.mocked(configManager.setConfig).mockRejectedValueOnce(new Error('Settings unavailable'));
    await act(async () => modeOption('manual')!.click());
    expect(modeChoices()).not.toBeNull();
    expect(modeOption('pool')?.getAttribute('aria-pressed')).toBe('true');
    expect(modeTooltip('manual')).toBe('umbra-main-native');
    expect(document.activeElement).toBe(modeOption('manual'));
    await act(async () => modeOption('manual')!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent)
      .toContain('umbra-main-native');
  });

  it('asks for another model when the remembered model has been removed', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openModeMenu();
    await act(async () => modeOption('smart')!.click());
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS.filter(model => model.id !== 'umbra-main'),
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      flowChatStoreMocks.configChangeListeners.forEach(listener => listener('ai.models'));
    });
    await act(async () => modeTrigger().click());
    vi.mocked(configManager.setConfig).mockClear();
    await act(async () => modeOption('manual')!.click());
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(getRecentManualModel(getActiveSurfaceScope().key('model-selector', 'Standard', undefined)))
      .toBe('umbra-main');
  });

  it('opens the mode picker with the keyboard and restores focus to the mode entry', async () => {
    await renderSelector();
    await openSettingsMenu();
    await act(async () => {
      modeTrigger().focus();
      modeTrigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(optionsPanel()).toBeNull();
    expect(modeChoices()).not.toBeNull();
    expect(document.activeElement).toBe(modeOption('manual'));
    await act(async () => {
      modeOption('manual')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(modeOption('smart'));
    expect(modeOption('manual')?.getAttribute('aria-pressed')).toBe('true');
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => {
      modeOption('smart')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(modeOption('manual'));
    await act(async () => {
      modeOption('manual')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(modeChoices()).toBeNull();
    expect(document.activeElement).toBe(modeTrigger());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('retains the card and its background until mode persistence succeeds, without duplicate saves', async () => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1, default_models: { primary: 'acme-fast' },
      models: [{ id: 'acme-fast', reasoning: { status: 'known', presets: [
        { id: 'high', label: 'High', order: 1, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
      ] } }],
    });
    await renderSelector();
    await openSettingsMenu();
    const sky = document.body.querySelector('[data-openbitfun-part="reasoningSliderSky"]');
    expect(sky).not.toBeNull();
    await act(async () => modeTrigger().click());
    expect(document.body.querySelector('[data-openbitfun-part="reasoningSliderSky"]')).toBe(sky);
    let finish!: () => void;
    vi.mocked(configManager.setConfig).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => modeOption('smart')!.click());
    expect(modeChoices()).not.toBeNull();
    expect(Array.from(modeChoices()!.querySelectorAll('button')).every(button => button.disabled)).toBe(true);
    expect(modeOption('manual')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => modeOption('pool')!.click());
    expect(configManager.setConfig).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(modeChoices()).toBeNull();
    expect(modeTrigger().textContent).toBe('modelSelector.modes.smart');
    expect(document.activeElement).toBe(modeTrigger());
  });

  it('selects the advertised levels inline and keeps Auto separate from Off without closing the card', async () => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'acme-fast',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: ['off', 'low', 'medium', 'high', 'xhigh'].map((id, order) => ({
            id, label: id, order, source: 'models_dev', actions: id === 'off'
              ? [{ type: 'toggle', enabled: false }] : [{ type: 'effort', value: id }],
          })),
        },
      }],
    });
    await renderSelector();
    await openSettingsMenu();
    const slider = () => document.body.querySelector<HTMLInputElement>('input[type="range"]');
    const openReasoning = async () => {
      await act(async () => document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-settings-reasoning"]',
      )!.click());
    };
    expect(slider()).toBeNull();
    expect(document.body.querySelector('[data-reasoning-mode="auto"] [data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.auto');
    expect(document.body.querySelector('[data-testid="chat-model-selector-intensity-control"]')?.getAttribute('data-intensity')).toBe('1');

    await openReasoning();
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-reasoning-options"] [aria-pressed="true"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-openbitfun-value="auto"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-openbitfun-value="preset:high"]',
    )!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(slider()).toBeNull();
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-intensity-control"]')?.getAttribute('data-intensity')).toBe('3');
    const manualRow = document.body.querySelector('[data-reasoning-mode="manual"]')!;
    expect(manualRow.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.levels.high');
    expect(manualRow.querySelectorAll('[data-testid="chat-model-selector-settings-reasoning"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-reasoning-mode="manual"] [data-openbitfun-name="reasoning-auto"]')).toBeNull();
    await openReasoning();
    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="preset:off"]')!.click();
    });
    expect(getRecentReasoningPreset('acme-fast')).toBe('off');
    expect(slider()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-intensity-control"]')?.getAttribute('data-intensity')).toBe('1');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]'));

    await openReasoning();
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-openbitfun-value="auto"]',
    )!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(slider()).toBeNull();
    expect(getRecentReasoningPreset('acme-fast')).toBeUndefined();
    const autoRow = document.body.querySelector('[data-reasoning-mode="auto"]')!;
    const autoChoice = autoRow.querySelector('[data-testid="chat-model-selector-settings-reasoning"]');
    expect(autoChoice?.textContent).toBe('reasoningSelector.thinking · reasoningSelector.auto');
    expect(document.activeElement).toBe(autoChoice);
  });

  it('offers providers first and keeps the symbolic selectors on that level', async () => {
    await renderSelector();
    await openMenu();

    const currentSelection = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-current-selection"]');
    expect(currentSelection?.textContent).toBe('acme-fast-native');
    expect(currentSelection?.dataset.tooltip).toBe('Acme');
    expect(document.body.querySelector('[data-testid="chat-model-selector-summary-back"]')
      ?.getAttribute('aria-describedby')).toBe(currentSelection?.id);

    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).toBeNull();
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(sharedPanelItems()).not.toBeNull();
    expect(providerRows().every(row => sharedPanelItems()?.contains(row))).toBe(true);
    expect(sharedPanelItems()?.contains(modelOption('primary'))).toBe(true);
    expect(sharedPanelItems()?.contains(modelOption('fast'))).toBe(true);
    expect(providerRows().map(row => row.dataset.providerKey))
      .toEqual(['provider-acme', 'provider-umbra']);
    expect(modelOption('primary')).not.toBeNull();
    expect(modelOption('fast')).not.toBeNull();
    const submenuButtons = Array.from(
      sharedPanelItems()?.querySelectorAll<HTMLButtonElement>('button') ?? [],
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
    expect(sharedPanelItems()).not.toBeNull();
    expect(sharedPanelItems()?.contains(modelOption('acme-fast'))).toBe(true);
    expect(sharedPanelItems()?.contains(modelOption('acme-deep'))).toBe(true);
    // The symbolic selectors belong to the provider level and are not repeated.
    expect(modelOption('primary')).toBeNull();

    const card = document.body.querySelector('[data-testid="chat-model-selector-menu"]');
    let finishSave!: () => void;
    vi.mocked(configManager.setConfig).mockReturnValueOnce(new Promise<void>(resolve => { finishSave = resolve; }));
    await act(async () => {
      modelOption('acme-deep')?.click();
      await Promise.resolve();
    });
    expect(card?.getAttribute('data-open')).toBe('true');
    expect(optionsPanel()).not.toBeNull();
    await act(async () => { finishSave(); });

    expect(configManager.setConfig).toHaveBeenCalledWith(
      'ai.agent_model_defaults.mode',
      'acme-deep',
    );
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(card);
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(document.body.querySelector('[data-testid="chat-model-selector-current-selection"]')?.textContent)
      .toBe('acme-deep-native');
  });

  it('marks the provider that owns the pinned model without repeating the model beneath it', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openMenu();

    const selectedKeys = providerRows()
      .filter(row => row.dataset.selected === 'true')
      .map(row => row.dataset.providerKey);
    expect(selectedKeys).toEqual(['provider-umbra']);

    const selectedProvider = providerRows().find(
      row => row.dataset.providerKey === 'provider-umbra',
    );
    expect(selectedProvider?.querySelector('[data-openbitfun-part="optionMain"]')?.textContent).toBe('Umbra');
    expect(selectedProvider?.querySelector('[data-testid="chat-model-selector-provider-selected-check"]')).not.toBeNull();
    expect(selectedProvider?.querySelector('[data-openbitfun-part="metadata"]')?.textContent).toBe('1');
    expect(selectedProvider?.textContent).not.toContain('umbra-main-native');
    const currentSelection = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-current-selection"]');
    expect(currentSelection?.textContent).toBe('umbra-main-native');
    expect(currentSelection?.dataset.tooltip).toBe('Umbra');
    expect(
      providerRows()
        .find(row => row.dataset.providerKey === 'provider-acme')
        ?.querySelector('[data-testid="chat-model-selector-provider-selected-check"]'),
    ).toBeNull();
  });

  it('returns to providers with the back control and resets to the summary on reopen', async () => {
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

    // Reopening starts at the summary; opening models resets the provider level.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-btn"]',
      )?.click();
    });
    await openSettingsMenu();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();
    expect(optionsPanel()).toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
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

    await openMenu();
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

    await openMenu();
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

    await openMenu();
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

  it('lets Escape step from a provider to the model list, then the summary, then close', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');

    const pressEscape = async () => {
      await act(async () => {
        optionsPanel()
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    };

    await pressEscape();
    expect(providerRows()).toHaveLength(2);

    await pressEscape();
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();
    const modelField = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!;
    expect(document.activeElement).toBe(modelField);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    )!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    await act(async () => modelField.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the current provider view intact until the short exit finishes', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');
    const surface = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-menu"]')!;
    const closingOptions = optionsPanel();
    const selectedProviderModel = modelOption('acme-fast');
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(surface.getAttribute('data-open')).toBe('false');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('data-menu-level')).toBe('provider');
    expect(optionsPanel()).toBe(closingOptions);
    expect(modelOption('acme-fast')).toBe(selectedProviderModel);
    act(() => vi.advanceTimersByTime(99));
    expect(surface.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
  });

  it.each(['pointer', 'keyboard'])('cancels an exit and resets the summary when reopened by %s', async (input) => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');
    const surface = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-menu"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => trigger.dispatchEvent(input === 'pointer'
      ? new MouseEvent('click', { bubbles: true, detail: 1 })
      : new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));

    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(surface.getAttribute('data-open')).toBe('true');
    expect(surface.getAttribute('data-menu-level')).toBe('settings');
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(surface.isConnected).toBe(true);
  });

  it('replaces summary contents on click and returns within the same menu surface', async () => {
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
    const surface = document.body.querySelector('[data-testid="chat-model-selector-menu"]');
    await act(async () => {
      modelRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      modelRow?.focus();
    });
    expect(optionsPanel()).toBeNull();
    await act(async () => modelRow?.click());
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);

    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-summary-back"]',
    )!.click());
    const reasoningRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )!;
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    await act(async () => reasoningRow.click());
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).not.toBeNull();
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]'));
  });

  it('supports Right and Left Arrow navigation and dismisses the card on outside click', async () => {
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
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(optionsPanel()?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      optionsPanel()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(optionsPanel()).toBeNull();
    const returnedModelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!;
    expect(document.activeElement).toBe(returnedModelRow);

    await act(async () => returnedModelRow.click());
    const closingOptions = optionsPanel();
    expect(closingOptions).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(optionsPanel()).toBe(closingOptions);
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
