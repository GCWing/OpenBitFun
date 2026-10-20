/**
 * @vitest-environment jsdom
 */

import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { act, cloneElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getRecentReasoningPreset } from '../utils/reasoningPresets';
import { useConfirmDialogStore } from '@/infrastructure/confirm-dialog';
import { notificationStore } from '@/shared/notification-system';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { quickActions } from '@/shared/services/ide-control';
import type { AIModelCatalog } from '@/infrastructure/api/service-api/AIApi';
import type { AIModelConfig, DefaultModelsConfig } from '@/infrastructure/config/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const poolApiMocks = vi.hoisted(() => ({
  supported: false,
  btwSupported: true,
  select: vi.fn(),
  target: vi.fn(),
  list: vi.fn(),
  status: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/ModelPoolAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/ModelPoolAPI')>(),
  supportsModelPools: () => poolApiMocks.supported,
  supportsBtwModelPools: () => poolApiMocks.supported && poolApiMocks.btwSupported,
  modelPoolAPI: { list: poolApiMocks.list, status: poolApiMocks.status, select: poolApiMocks.select, target: poolApiMocks.target },
}));
beforeEach(() => {
  poolApiMocks.supported = false;
  poolApiMocks.btwSupported = true;
  poolApiMocks.target.mockReset().mockResolvedValue({ selection: { kind: 'model', model_ref: 'acme-fast' } });
  poolApiMocks.select.mockReset().mockImplementation(async (_request, selection) => {
    const target = { selection };
    poolApiMocks.target.mockResolvedValue(target);
    return target;
  });
  poolApiMocks.list.mockResolvedValue({ version: 1, pools: [] });
  poolApiMocks.status.mockResolvedValue([]);
});

const aiApiMocks = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  onModelCatalogUpdated: vi.fn(),
}));

const flowChatStoreMocks = vi.hoisted(() => {
  type TestSession = {
    sessionId?: string;
    sessionKind?: string;
    agentBackedTransient?: boolean;
    isTransient?: boolean;
    dialogTurns?: unknown[];
    config: { agentType?: string; modelName?: string; reasoningPreset?: string;
      modelPoolId?: string; modelPoolSelectionPending?: boolean };
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
    updateSessionModelPool: vi.fn(),
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
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: vi.fn(),
    onConfigChange: vi.fn((listener: (path: string) => void) => {
      flowChatStoreMocks.configChangeListeners.add(listener);
      return () => flowChatStoreMocks.configChangeListeners.delete(listener);
    }),
    setConfig: vi.fn(async () => undefined),
    updateConfig: vi.fn(),
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
) ?? document.body.querySelector<HTMLButtonElement>(`[data-testid="chat-model-selector-${modelId}-action"]`);

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

  const openMenu = async () => openModelList();

  const openModelList = async () => {
    if (container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded') !== 'true') {
      await openSettingsMenu();
    }
    const entry = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    if (entry) await act(async () => entry.click());
  };

  const reopenModelList = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    if (trigger.getAttribute('aria-expanded') === 'true') await act(async () => trigger.click());
    await openModelList();
  };

  const modeTrigger = () => document.body.querySelector<HTMLButtonElement>(
    '[data-testid="chat-model-selector-settings-model"]',
  )!;

  const searchTrigger = () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-search-toggle"]')!;
  const searchInput = () => document.body.querySelector<HTMLInputElement>('[data-testid="chat-model-selector-search-input"]')!;
  const searchFor = async (query: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), query);
      searchInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const modeAction = (mode: 'smart' | 'pool') => document.body.querySelector<HTMLButtonElement>(
    `[data-testid="chat-model-selector-${mode}-action"]`,
  );

  const openModeMenu = async () => {
    await openModelList();
    const showActions = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-show-actions"]');
    if (showActions) await act(async () => showActions.click());
  };
  const modeOption = (mode: 'smart' | 'pool') => modeAction(mode);

  const openProvider = async (providerKey: string) => {
    const search = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-search-toggle"]');
    if (search) await act(async () => search.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-provider-filter"]')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[data-testid="chat-model-selector-provider-filter-menu"] [data-menu-id="${providerKey}"]`)!.click());
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
    defaultModels: DefaultModelsConfig = { primary: 'acme-fast', fast: 'umbra-main' },
  ) => {
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': models,
      'ai.default_models': defaultModels,
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: modeModel }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
    activateSurface('local');
    vi.mocked(configManager.getConfigs).mockReset();
    vi.mocked(configManager.setConfig).mockReset().mockResolvedValue(undefined);
    vi.mocked(configManager.updateConfig).mockReset().mockImplementation(async (_path, update) => {
      const config = await configManager.getConfigs(['ai.models']);
      return update(config['ai.models']);
    });
    aiApiMocks.getModelCatalog.mockReset();
    vi.mocked(agentAPI.updateSessionModel).mockReset().mockImplementation(async request => {
      poolApiMocks.target.mockResolvedValue({ selection: { kind: 'model', model_ref: request.modelName } });
    });
    notificationStore.clearActiveNotifications();
    notificationStore.clearHistory();
    flowChatStoreMocks.store.updateSessionModelPool.mockReset().mockImplementation((sessionId: string, poolId?: string, _binding?: unknown, pending = false) => {
      const session = flowChatStoreMocks.sessions.get(sessionId);
      if (session) Object.assign(session.config, { modelPoolId: poolId, modelPoolSelectionPending: pending });
      flowChatStoreMocks.subscribers.forEach(callback => callback());
    });
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

  it('searches selectable models across providers without changing the selection while typing', async () => {
    await renderSelector([
      ...CATALOG_MODELS,
      { ...model('disabled-model', 'Hidden', 'disabled-provider', 'https://hidden.test'), enabled: false },
      { ...model('image-model', 'Images', 'image-provider', 'https://images.test'), category: 'multimodal', capabilities: ['image_understanding'] },
    ]);
    await openModelList();
    await act(async () => searchTrigger().click());
    expect(document.activeElement).toBe(searchInput());
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    expect(modelOption('disabled-model')).toBeNull();
    expect(modelOption('image-model')).toBeNull();
    expect(modelOption('acme-fast')?.getAttribute('aria-checked')).toBe('true');
    expect(modelOption('acme-fast')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();

    await searchFor('  ACME deep  ');
    expect(document.activeElement).toBe(searchInput());
    expect(modelOption('acme-deep')?.textContent).toContain('acme-deep-native');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('acme-deep-native Acme');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(modelOption('acme-fast')).toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    await searchFor('deep');
    expect(modelOption('acme-deep')?.textContent).toBe('acme-deep-native');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    await searchFor('Umbra');
    expect(modelOption('umbra-main')).not.toBeNull();
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('umbra-main-native Umbra');
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(modelOption('acme-deep')).toBeNull();
    await searchFor('  ');
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('keeps text editing inside search and supports keyboard selection and return focus', async () => {
    await renderSelector();
    await openModelList();
    await act(async () => searchTrigger().click());
    await searchFor('deep');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => searchInput().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(searchInput());
    }
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(modelOption('acme-deep'));
    await act(async () => modelOption('acme-deep')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(searchInput());
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(configManager.setConfig).toHaveBeenCalledExactlyOnceWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'acme-deep' });
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-input"]')).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('focuses and scrolls the selected model when opening a long list', async () => {
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      const models = Array.from({ length: 24 }, (_, index) => model(`model-${index}`, 'Acme', 'provider-acme', 'https://acme.test/v1'));
      await renderSelector(models, 'model-23');
      await openModelList();
      const selected = modelOption('model-23');
      expect(document.activeElement).toBe(selected);
      expect(selected?.getAttribute('aria-checked')).toBe('true');
      expect(scrollIntoView.mock.contexts).toContain(selected);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    } finally {
      if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('keeps model rows above the actions and combines provider filtering with search', async () => {
    await renderSelector();
    await openModelList();
    const results = document.body.querySelector('[data-testid="chat-model-selector-results"]')!;
    const actions = document.body.querySelector('[data-testid="chat-model-selector-actions"]')!;
    expect(results.nextElementSibling).toBe(actions);
    expect(results.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    expect(actions.contains(modelOption('primary'))).toBe(true);
    expect(actions.contains(modelOption('fast'))).toBe(true);
    expect(actions.contains(modeAction('pool'))).toBe(true);
    expect(actions.contains(modeAction('smart'))).toBe(true);
    expect(document.activeElement).toBe(modelOption('acme-fast'));
    expect(searchInput()).toBeNull();
    expect(actions.querySelector('[data-testid="chat-model-selector-summary-back"]')).toBeNull();
    const divider = actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')!;
    expect(searchTrigger().parentElement?.previousElementSibling).toBe(divider);
    const quickActions = actions.querySelector('[data-testid="chat-model-selector-quick-actions"]')!;
    expect(divider.previousElementSibling?.contains(quickActions)).toBe(true);
    expect(quickActions.firstElementChild).toBe(modelOption('primary'));
    expect(modelOption('primary')?.textContent).toBe('modelSelector.primaryModel');
    for (const action of [modelOption('fast'), modeAction('pool'), modeAction('smart')]) expect(action?.textContent).toBe('');

    await act(async () => searchTrigger().click());
    expect(document.activeElement).toBe(searchInput());
    expect(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')).not.toBeNull();
    const showActions = actions.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-show-actions"]')!;
    expect(showActions.querySelector('.lucide-layout-grid')).not.toBeNull();
    expect(showActions.parentElement?.nextElementSibling).toBe(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]'));
    expect(actions.querySelector('[data-testid="chat-model-selector-search-collapse"]')).toBeNull();
    for (const action of [modelOption('primary'), modelOption('fast'), modeAction('pool'), modeAction('smart')]) expect(action).toBeNull();

    const filter = actions.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-provider-filter"]')!;
    const searchCapsule = searchInput().closest('[data-openbitfun-component="input"]')!;
    expect(searchCapsule.getAttribute('data-shape')).toBe('pill');
    expect(searchCapsule.contains(filter)).toBe(true);
    const filterMenu = () => document.body.querySelector<HTMLElement>(
      '[data-testid="chat-model-selector-provider-filter-menu"]:not([aria-hidden="true"])',
    );
    expect(actions.querySelector('[role="combobox"]')).toBeNull();
    expect(filter.textContent).toBe('');
    expect(filter.getAttribute('aria-expanded')).toBe('false');
    expect(filterMenu()).toBeNull();
    const selectProvider = async (providerKey: string) => {
      await act(async () => filter.click());
      expect(filter.getAttribute('aria-expanded')).toBe('true');
      const option = filterMenu()!.querySelector<HTMLButtonElement>(`[data-menu-id="${providerKey}"]`)!;
      await act(async () => {
        option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        option.click();
      });
      expect(filter.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(filter);
      expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    };
    await selectProvider('provider-acme');
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(modelOption('acme-fast')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(modelOption('acme-fast')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(searchInput().closest('.openbitfun-model-selector__picker-actions')).toBe(actions.firstElementChild);
    expect(actions.childElementCount).toBe(1);
    await searchFor('deep');
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('acme-fast')).toBeNull();
    await selectProvider('provider-umbra');
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-empty"]')).not.toBeNull();
    await searchFor('main');
    expect(modelOption('umbra-main')).not.toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();

    await act(async () => filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    const popup = filterMenu()!;
    await act(async () => popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(filterMenu()).toBeNull();
    expect(document.activeElement).toBe(filter);
    expect(document.body.querySelector('[data-testid="chat-model-selector-actions"]')).toBe(actions);
    await searchFor('');
    await selectProvider('all-providers');
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    expect(results.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    await act(async () => showActions.click());
    expect(document.activeElement).toBe(searchTrigger());
    expect(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')).not.toBeNull();
    expect(modelOption('primary')?.textContent).toBe('modelSelector.primaryModel');
    expect(modeAction('smart')).not.toBeNull();
  });

  it('shows empty results, ignores IME confirmation and resets the query after leaving search', async () => {
    await renderSelector();
    await openModelList();
    await act(async () => searchTrigger().click());
    await searchFor('does-not-exist');
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-empty"]')?.textContent).toBe('modelSelector.noSearchResults');
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await searchFor('deep');
    for (const key of ['Enter', 'Escape', 'ArrowDown']) {
      await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(searchInput());
    }
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(searchTrigger());
    await act(async () => searchTrigger().click());
    expect(searchInput().value).toBe('');
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await act(async () => searchTrigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
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
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'primary' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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

    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
    expect(modelField?.textContent).toContain('acme-fast-native');

    await act(async () => resolveCatalog({ version: 2, models: [] }));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
  });

  it('opens a settings homepage with context, effort and model rows', async () => {
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
    expect(Array.from(settings!.querySelectorAll('[data-testid]'))
      .map(element => element.getAttribute('data-testid'))
      .filter(id => ['chat-model-selector-settings-fast', 'chat-model-selector-settings-context', 'chat-model-selector-settings-reasoning', 'chat-model-selector-settings-model'].includes(id!)))
      .toEqual(['chat-model-selector-settings-context', 'chat-model-selector-settings-reasoning', 'chat-model-selector-settings-model']);
    expect(settings?.querySelector('[role="separator"]')).not.toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-model"]',
    )?.textContent).toContain('umbra-main-native');
    expect(settings?.querySelector('[data-testid="chat-model-selector-settings-provider"]')).toBeNull();
    expect(settings?.querySelector('[data-testid="chat-model-selector-settings-mode"]')).toBeNull();
    expect(optionsPanel()).toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
    expect(settings?.querySelectorAll('button[role="menuitem"]')).toHaveLength(3);
    expect(settings?.querySelector('.openbitfun-model-selector__mode-footer')).toBeNull();
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

  it.each([
    ['primary', 'modelSelector.primaryModel', 'acme-fast-native'],
    ['fast', 'modelSelector.fastModel', 'umbra-main-native'],
  ])('labels the %s model on the homepage without a fast toggle', async (selection, label, modelName) => {
    await renderSelector(CATALOG_MODELS, selection);
    await openSettingsMenu();
    const row = document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')!;
    expect(row.getAttribute('aria-label')).toBe(`${label}: ${modelName}`);
    expect(row.textContent).toBe(`${label}${modelName}`);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-fast-row"]')).toBeNull();
    expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();
  });

  const contextInput = () => document.body.querySelector<HTMLInputElement>('[data-testid="chat-model-selector-context-input"]')!;
  const editContext = async (value: string) => {
    if (!contextInput()) await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-context"]')!.click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(contextInput(), value);
      contextInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const saveContext = async () => {
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-context-save"]')!.click());
  };

  it('edits the resolved model context inline and preserves other configuration fields', async () => {
    const openSettings = vi.spyOn(quickActions, 'openSettings').mockImplementation(() => undefined);
    try {
      const models = CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000, api_key: 'preserved-key', future_option: { enabled: true } }));
      flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
      await renderSelector(models, 'primary', 'session-a');
      await openSettingsMenu();
      expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('300K');
      await editContext('512000');
      expect(document.activeElement).toBe(contextInput());
      await saveContext();
      expect(configManager.updateConfig).toHaveBeenCalledExactlyOnceWith('ai.models', expect.any(Function));
      expect(await vi.mocked(configManager.updateConfig).mock.results[0].value).toEqual([
        { ...models[0], context_window: 512_000 }, models[1], models[2],
      ]);
      expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
      expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenCalledExactlyOnceWith('session-a', 512_000);
      expect(openSettings).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]'));
      expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      openSettings.mockRestore();
    }
  });

  it('validates context limits and respects composition and cancellation before saving', async () => {
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })));
    await openSettingsMenu();
    for (const invalid of ['', '31000', '2000001', '64000.5', 'tokens']) {
      await editContext(invalid);
      await saveContext();
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('modelSelector.home.contextInvalid');
      expect(configManager.updateConfig).not.toHaveBeenCalled();
    }
    await editContext('512000');
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(contextInput()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('300K');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    await editContext('512000');
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
  });

  it('retains the context draft and committed limit after failure, then allows retry', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })), 'primary', 'session-a');
    await openSettingsMenu();
    await editContext('512000');
    vi.mocked(configManager.updateConfig).mockRejectedValueOnce(new Error('Host offline'));
    await saveContext();
    expect(contextInput().value).toBe('512000');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('modelSelector.home.contextSaveFailed');
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).not.toHaveBeenCalled();
    await saveContext();
    expect(contextInput()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenCalledExactlyOnceWith('session-a', 512_000);
  });

  it('does not apply an old context save to the newly activated device', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })), 'primary', 'session-a');
    await openSettingsMenu();
    let finish!: (models: AIModelConfig[]) => void;
    vi.mocked(configManager.updateConfig).mockImplementationOnce(async (_path, update) => {
      const current = (await configManager.getConfigs(['ai.models']))['ai.models'];
      const updated = update(current) as AIModelConfig[];
      return new Promise(resolve => { finish = resolve; }).then(() => updated);
    });
    await editContext('512000');
    await saveContext();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS.map(model => ({ ...model, context_window: 128_000 })),
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => { activateSurface('peer-context-host'); });
    await act(async () => finish([]));
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).not.toHaveBeenCalled();
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('128K');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['primary', 'fast', 'acme-deep'])('shows concrete models above the default shortcut actions for %s', async modelId => {
    await renderSelector(CATALOG_MODELS, modelId);
    await openSettingsMenu();

    const modelControl = () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!;
    await act(async () => modelControl().click());

    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')
      ?.getAttribute('data-menu-level')).toBe('models');
    expect(providerRows()).toHaveLength(0);
    const choices = Array.from(sharedPanelItems()!.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-model-selector-option"]',
    ));
    expect(choices.map(row => row.dataset.modelId)).toEqual(['acme-fast', 'acme-deep', 'umbra-main']);
    expect(modelOption('primary')?.getAttribute('aria-pressed')).toBe(String(modelId === 'primary'));
    expect(modelOption('fast')?.getAttribute('aria-pressed')).toBe(String(modelId === 'fast'));
    expect(modelOption('primary')?.getAttribute('aria-label')).toBe('modelSelector.primaryModel');
    expect(modelOption('primary')?.dataset.modelName).toBe('acme-fast-native');
    expect(modelOption('primary')?.dataset.tooltip).toBe('modelSelector.primaryModel · acme-fast-native');
    expect(modelOption('fast')?.getAttribute('aria-label')).toBe('modelSelector.fastModel');
    expect(modelOption('fast')?.dataset.modelName).toBe('umbra-main-native');
    expect(modelOption('fast')?.dataset.tooltip).toBe('modelSelector.fastModel · umbra-main-native');
    expect(modelOption('primary')?.textContent).toBe(modelId === 'primary' ? 'modelSelector.primaryModel' : '');
    expect(modelOption('fast')?.textContent).toBe(modelId === 'fast' ? 'modelSelector.fastModel' : '');
    for (const role of ['primary', 'fast']) {
      const action = modelOption(role)!;
      expect(Boolean(action.querySelector('.lucide-check'))).toBe(modelId === role);
      expect(Boolean(action.querySelector(role === 'primary' ? '.lucide-gem' : '.lucide-rocket'))).toBe(modelId !== role);
    }
    expect(document.activeElement).toBe(modelOption(modelId === 'primary' ? 'acme-fast' : modelId === 'fast' ? 'umbra-main' : modelId));

    expect(document.body.querySelector('[data-testid="chat-model-selector-summary-back"]')).toBeNull();
    await act(async () => optionsPanel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(modelControl());

    await act(async () => modelControl().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ));
    expect(modelOption('primary')).not.toBeNull();
    await act(async () => optionsPanel()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(modelControl());
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it.each(['primary', 'fast'])('persists the %s shortcut as a symbolic session selection', async modelId => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'acme-deep' } });
    await renderSelector(CATALOG_MODELS, 'acme-deep', 'session-a');
    await openModelList();
    await act(async () => modelOption(modelId)!.click());

    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: modelId,
    }));
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: modelId });
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe(modelId);
    expect(optionsPanel()).toBeNull();
    const defaultIcon = container.querySelector('[data-testid="chat-model-selector-default-icon"]');
    expect(defaultIcon?.getAttribute('data-model-role')).toBe(modelId);
    expect(defaultIcon?.querySelector(modelId === 'primary' ? '.lucide-gem' : '.lucide-rocket')).not.toBeNull();
    const triggerLabel = container.querySelector('[data-testid="chat-model-selector-btn"] .openbitfun-model-selector__name');
    expect(triggerLabel?.textContent).toBe(modelId === 'primary' ? 'acme-fast-native' : 'umbra-main-native');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption(modelId)?.getAttribute('aria-pressed')).toBe('true');
  });

  it.each([undefined, 'removed-model', 'disabled-fast'])('resolves the fast shortcut through primary when fast is %s', async fast => {
    await renderSelector([
      ...CATALOG_MODELS,
      { ...CATALOG_MODELS[2], id: 'disabled-fast', enabled: false },
    ], 'acme-deep', undefined, { primary: 'acme-fast', fast });
    await openModelList();
    expect(modelOption('fast')?.disabled).toBe(false);
    expect(modelOption('fast')?.dataset.modelName).toBe('acme-fast-native');
    await act(async () => modelOption('fast')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'fast' });
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')?.textContent)
      .toContain('acme-fast-native');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption('fast')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('disables unresolved default shortcuts while keeping concrete models selectable', async () => {
    await renderSelector(CATALOG_MODELS, 'acme-deep', undefined, {});
    await openModelList();
    for (const modelId of ['primary', 'fast']) {
      expect(modelOption(modelId)?.disabled).toBe(true);
      expect(modelOption(modelId)?.dataset.tooltip).toBe(`${modelId === 'primary' ? 'modelSelector.primaryModel' : 'modelSelector.fastModel'} · modelSelector.modelNotConfigured`);
      await act(async () => modelOption(modelId)!.click());
    }
    for (const mode of ['pool', 'smart'] as const) {
      expect(modeAction(mode)?.disabled).toBe(true);
      expect(modeAction(mode)?.dataset.tooltip).toContain(mode === 'pool' ? 'modelSelector.pools.surfaceUnsupported' : 'modelSelector.modes.primaryRequired');
      await act(async () => modeAction(mode)!.click());
    }
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => modelOption('acme-fast')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'acme-fast' });
  });

  it.each(['pool', 'smart'] as const)('switches to %s from the model-list actions and back through a model shortcut', async mode => {
    poolApiMocks.supported = true;
    poolApiMocks.list.mockResolvedValue({ version: 1, pools: [{ id: 'daily', name: 'Daily pool', strategy: 'ordered', member_model_ids: ['acme-fast'] }] });
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openModelList();
    const action = modeAction(mode)!;
    expect(action.getAttribute('aria-label')).toBe(`modelSelector.modes.${mode}`);
    expect(action.dataset.tooltip).toBe(`modelSelector.modes.${mode} · ${mode === 'pool' ? 'modelSelector.pools.choose' : 'modelSelector.modes.comingSoon'}`);
    expect(action.getAttribute('aria-pressed')).toBe('false');
    expect(action.querySelector(mode === 'smart' ? '.lucide-galaxy' : '.lucide-battery-full')).not.toBeNull();
    await act(async () => action.click());

    if (mode === 'pool') {
      expect(poolApiMocks.select).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a' }), { kind: 'pool', pool_id: 'daily' });
      expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    } else {
      expect(agentAPI.updateSessionModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: 'session-a', modelName: 'primary', reasoningPreset: null,
      }));
    }
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(modeTrigger());
    expect(container.querySelector('[data-testid="chat-model-selector-mode-icon"]')?.getAttribute('data-model-mode')).toBe(mode);
    expect(notificationStore.getState().notificationHistory.filter(notice => notice.type === 'info')).toHaveLength(mode === 'pool' ? 0 : 1);

    await reopenModelList();
    expect(modeAction(mode)?.getAttribute('aria-pressed')).toBe('true');
    expect(modeAction(mode)?.textContent).toBe(`modelSelector.modes.${mode}`);
    expect(modeAction(mode)?.querySelector('.lucide-check')).not.toBeNull();
    expect(modeAction(mode)?.querySelector(mode === 'smart' ? '.lucide-galaxy' : '.lucide-battery-full')).toBeNull();
    for (const row of document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')) {
      expect(row.getAttribute('aria-checked')).toBe('false');
      expect(row.getAttribute('data-selected')).toBe('false');
      expect(row.querySelector('.lucide-check')).toBeNull();
    }
    expect(modelOption('primary')?.getAttribute('aria-pressed')).toBe('false');
    expect(modelOption('primary')?.textContent).toBe('');
    await act(async () => modeAction(mode)!.click());
    expect(optionsPanel()).toBeNull();
    expect(agentAPI.updateSessionModel).toHaveBeenCalledTimes(mode === 'pool' ? 0 : 1);
    expect(notificationStore.getState().notificationHistory.filter(notice => notice.type === 'info')).toHaveLength(mode === 'pool' ? 0 : 1);

    await reopenModelList();
    await act(async () => modelOption('fast')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: 'fast',
    }));
    expect(container.querySelector('[data-testid="chat-model-selector-mode-icon"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-default-icon"]')?.getAttribute('data-model-role')).toBe('fast');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modeAction(mode)?.getAttribute('aria-pressed')).toBe('false');
    expect(modelOption('fast')?.getAttribute('aria-pressed')).toBe('true');
    expect(modelOption('umbra-main')?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the selected named pool in the new settings rows and returns focus after browsing pools', async () => {
    poolApiMocks.supported = true;
    poolApiMocks.list.mockResolvedValue({ version: 1, pools: [
      { id: 'daily', name: 'Daily pool', strategy: 'ordered', member_model_ids: ['acme-fast'] },
      { id: 'batch', name: 'Batch pool', strategy: 'balanced', member_model_ids: ['umbra-main'] },
    ] });
    await renderSelector();
    await openModelList();
    await act(async () => modeAction('pool')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-pool-id="daily"]')!.click());
    const homepage = () => document.body.querySelector('[data-testid="chat-model-selector-settings"]')!;
    const poolRow = () => homepage().querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-pool"]')!;
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-context"]')).toBeNull();
    expect(homepage().querySelector('[data-testid="chat-model-selector-context-input"]')).toBeNull();
    expect(homepage().querySelector('[data-testid="chat-model-selector-pool-current"]')?.textContent).toBe('modelSelector.pools.unassigned');
    expect(poolRow().getAttribute('aria-label')).toBe('modelSelector.pools.title: Daily pool');
    expect(Array.from(homepage().querySelectorAll('[data-testid]')).map(row => row.getAttribute('data-testid'))
      .filter(id => ['chat-model-selector-settings-current-model', 'chat-model-selector-settings-pool', 'chat-model-selector-settings-model'].includes(id!)))
      .toEqual(['chat-model-selector-settings-current-model', 'chat-model-selector-settings-pool', 'chat-model-selector-settings-model']);
    const writesBeforeViewing = vi.mocked(configManager.setConfig).mock.calls.length;
    await act(async () => poolRow().click());
    expect(optionsPanel()?.dataset.panelKind).toBe('pools');
    expect(document.body.querySelector('[data-pool-id="daily"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(poolRow());
    await act(async () => poolRow().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(optionsPanel()?.dataset.panelKind).toBe('pools');
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-summary-back"]')!.click());
    expect(document.activeElement).toBe(poolRow());
    expect(vi.mocked(configManager.setConfig).mock.calls).toHaveLength(writesBeforeViewing);
    await openModelList();
    await act(async () => modelOption('primary')!.click());
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-current-model"]')).toBeNull();
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-pool"]')).toBeNull();
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-context"]')).not.toBeNull();
  });

  it('opens the smart model list from the homepage instead of editing a fallback model context', async () => {
    await renderSelector();
    await openModelList();
    await act(async () => modeAction('smart')!.click());
    const homepage = () => document.body.querySelector('[data-testid="chat-model-selector-settings"]')!;
    const poolRow = () => homepage().querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-pool"]')!;
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-context"]')).toBeNull();
    expect(poolRow().getAttribute('aria-label')).toBe('modelSelector.home.modelList: 3');
    expect(homepage().querySelector('[data-testid="chat-model-selector-settings-model"]')?.getAttribute('aria-label'))
      .toBe('modelSelector.home.mode: modelSelector.modes.smart');
    const writesBeforeViewing = vi.mocked(configManager.setConfig).mock.calls.length;
    await act(async () => poolRow().click());
    const connections = document.body.querySelector('[data-testid="chat-model-selector-pool-connections"]')!;
    expect(connections.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('modelSelector.home.modelList');
    expect(Array.from(connections.querySelectorAll('[data-testid="chat-model-selector-pool-model"]'))
      .map(model => model.getAttribute('data-model-id'))).toEqual(['acme-fast', 'acme-deep', 'umbra-main']);
    expect(connections.querySelector('[role="menuitemradio"]')).toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-pool-back"]')!.click());
    expect(document.activeElement).toBe(poolRow());
    expect(vi.mocked(configManager.setConfig).mock.calls).toHaveLength(writesBeforeViewing);
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps mode actions disabled while a selection is being saved', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openModelList();
    let finish!: () => void;
    vi.mocked(configManager.setConfig).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => modeAction('smart')!.click());
    expect(modeAction('smart')?.disabled).toBe(true);
    expect(modeAction('pool')?.disabled).toBe(true);
    await act(async () => modeAction('pool')!.click());
    expect(configManager.setConfig).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(optionsPanel()).toBeNull();
    const homepage = document.body.querySelector('[data-testid="chat-model-selector-settings"]')!;
    expect(homepage.querySelector('[data-testid="chat-model-selector-settings-model-value"]')?.textContent).toBe('modelSelector.modes.smart');
    expect(homepage.querySelector('[data-testid="chat-model-selector-settings-mode"]')).toBeNull();
    expect(homepage.querySelector('[data-testid="chat-model-selector-settings-provider"]')).toBeNull();
  });

  it('preserves the model list and focuses a failed mode action for retry', async () => {
    poolApiMocks.supported = true;
    poolApiMocks.list.mockResolvedValue({ version: 1, pools: [{ id: 'daily', name: 'Daily pool', strategy: 'ordered', member_model_ids: ['acme-fast'] }] });
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openModelList();
    vi.mocked(configManager.setConfig).mockRejectedValueOnce(new Error('Settings unavailable'));
    await act(async () => modeAction('pool')!.click());

    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(modelOption('umbra-main')?.getAttribute('aria-checked')).toBe('true');
    expect(modeAction('pool')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(modeAction('pool'));
    expect(notificationStore.getState().notificationHistory.filter(notice => notice.type === 'info')).toHaveLength(0);
    await act(async () => modeAction('pool')!.click());
    expect(optionsPanel()).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-mode-icon"]')?.getAttribute('data-model-mode')).toBe('pool');
  });

  it('resolves shortcuts from the selected peer surface without retaining local model labels', async () => {
    await renderSelector();
    await openModelList();
    expect(modelOption('primary')?.dataset.modelName).toBe('acme-fast-native');

    let finishPeerConfig!: (config: Record<string, unknown>) => void;
    vi.mocked(configManager.getConfigs).mockReturnValueOnce(new Promise(resolve => { finishPeerConfig = resolve; }));
    await act(async () => { activateSurface('peer-model-host'); });
    expect(document.body.textContent).not.toContain('acme-fast-native');
    expect(modelOption('primary')).toBeNull();

    await act(async () => finishPeerConfig({
      'ai.models': [model('peer-model', 'Peer', 'provider-peer', 'https://peer.test/v1')],
      'ai.default_models': { primary: 'peer-model' },
      'ai.agent_model_defaults': { mode: 'primary' },
    }));
    await openModelList();
    expect(modelOption('primary')?.dataset.modelName).toBe('peer-model-native');
    expect(modelOption('fast')?.dataset.modelName).toBe('peer-model-native');
    expect(document.body.textContent).not.toContain('acme-fast-native');
    await act(async () => modelOption('fast')!.click());
    // This peer advertises only the legacy config shape; preserve its write contract.
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'fast');
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
    expect(reasoningRow?.textContent).toBe('modelSelector.home.effortreasoningSelector.auto');

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

  it.each([false, true])('allows Battery mode in BTW and updates the appropriate owner (started=%s)', async started => {
    poolApiMocks.supported = true;
    poolApiMocks.list.mockResolvedValue({ version: 1, pools: [
      { id: 'daily', name: 'Daily pool', strategy: 'ordered', member_model_ids: ['acme-fast'] },
      { id: 'batch', name: 'Batch pool', strategy: 'balanced', member_model_ids: ['umbra-main'] },
    ] });
    flowChatStoreMocks.sessions.set('side', { sessionId: 'side', sessionKind: 'btw',
      agentBackedTransient: true, isTransient: true, dialogTurns: started ? [{}] : [],
      config: { modelName: 'acme-fast' } });
    await renderSelector(CATALOG_MODELS, 'primary', 'side');
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-pool-id="daily"]')!.click());
    expect(flowChatStoreMocks.sessions.get('side')?.config.modelPoolId).toBe('daily');
    if (started) {
      expect(poolApiMocks.select).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'side', includeInternal: true }),
        { kind: 'pool', pool_id: 'daily' });
    } else {
      expect(poolApiMocks.select).not.toHaveBeenCalled();
      expect(flowChatStoreMocks.sessions.get('side')?.config.modelPoolSelectionPending).toBe(true);
    }
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it('offers only model pool configuration when battery mode has no pools', async () => {
    poolApiMocks.supported = true;
    const openSettings = vi.spyOn(quickActions, 'openSettings').mockImplementation(() => undefined);
    try {
      await renderSelector();
      await openModeMenu();
      expect(modeOption('pool')?.dataset.tooltip).toContain('modelSelector.pools.configure');
      await act(async () => modeOption('pool')!.click());
      const panel = optionsPanel()!;
      expect(panel.dataset.panelKind).toBe('pools');
      expect(panel.textContent).toBe('modelSelector.pools.configure');
      expect(panel.querySelector('[data-testid="chat-model-selector-summary-back"]')).toBeNull();
      expect(panel.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
      await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-open-settings"]')!.click());
      expect(openSettings).toHaveBeenCalledExactlyOnceWith({ pageId: 'ai.models' });
      expect(configManager.setConfig).not.toHaveBeenCalled();
      expect(poolApiMocks.select).not.toHaveBeenCalled();
    } finally {
      openSettings.mockRestore();
    }
  });

  it('keeps pending and failed pool reads distinct from an empty catalog', async () => {
    poolApiMocks.supported = true;
    let failRead!: (reason: Error) => void;
    poolApiMocks.list.mockReturnValue(new Promise((_resolve, reject) => { failRead = reject; }));
    await renderSelector();
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    expect(optionsPanel()?.textContent).toContain('modelSelector.status.loading');
    expect(optionsPanel()?.textContent).not.toContain('modelSelector.pools.configure');
    await act(async () => { failRead(new Error('Catalog unavailable')); });
    expect(optionsPanel()?.textContent).toContain('modelSelector.pools.loadError');
    expect(optionsPanel()?.textContent).not.toContain('modelSelector.pools.configure');
  });

  it('keeps pools inside battery mode and commits only after choosing a pool', async () => {
    poolApiMocks.supported = true;
    poolApiMocks.list.mockResolvedValue({ version: 1, pools: [
      { id: 'daily', name: 'Daily pool', strategy: 'ordered', member_model_ids: ['acme-fast'] },
      { id: 'batch', name: 'Batch pool', strategy: 'balanced', member_model_ids: ['umbra-main'] },
    ] });
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    expect(optionsPanel()?.dataset.panelKind).toBe('pools');
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(0);
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-summary-back"]',
    )!.click());
    expect(modeTrigger().textContent).toContain('umbra-main-native');
    await act(async () => modeTrigger().click());
    await act(async () => modeOption('pool')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-pool-id="daily"]')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', {
      kind: 'pool', pool_id: 'daily',
    });
    expect(modeTrigger().textContent).toContain('modelSelector.modes.pool');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-pool"]')?.textContent).toContain('Daily pool');
    expect(document.body.querySelector('[data-testid="chat-model-selector-pool-current"]')?.textContent).toBe('modelSelector.pools.unassigned');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')).toBeNull();
    expect(notificationStore.getState().notificationHistory.some(notice => notice.message === 'modelSelector.modes.developmentNotice')).toBe(false);
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
      .toBe('modelSelector.home.effortreasoningSelector.auto');

    await openReasoning();
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-reasoning-options"] [aria-pressed="true"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-openbitfun-value="auto"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-openbitfun-value="preset:high"]',
    )!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(slider()).toBeNull();
    expect(optionsPanel()).toBeNull();
    const manualRow = document.body.querySelector('[data-reasoning-mode="manual"]')!;
    expect(manualRow.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('modelSelector.home.effortreasoningSelector.levels.high');
    expect(manualRow.querySelectorAll('[data-testid="chat-model-selector-settings-reasoning"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-reasoning-mode="manual"] [data-openbitfun-name="reasoning-auto"]')).toBeNull();
    await openReasoning();
    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="preset:off"]')!.click();
    });
    expect(getRecentReasoningPreset('acme-fast')).toBe('off');
    expect(slider()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('modelSelector.home.effortreasoningSelector.levels.off');
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
    expect(autoChoice?.textContent).toBe('modelSelector.home.effortreasoningSelector.auto');
    expect(document.activeElement).toBe(autoChoice);
  });

  it('commits the session before remembering defaults and leaves the selector usable during that save', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    let commitSession!: () => void;
    let saveDefault!: () => void;
    vi.mocked(agentAPI.updateSessionModel).mockReturnValueOnce(new Promise(resolve => { commitSession = resolve; }));
    vi.mocked(configManager.setConfig).mockReturnValueOnce(new Promise(resolve => { saveDefault = resolve; }));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledTimes(1);
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => commitSession());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'acme-deep' });
    expect(optionsPanel()).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!.disabled).toBe(false);
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
    await act(async () => saveDefault());
  });

  it('preserves a committed session selection when remembering the default fails', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    vi.mocked(configManager.setConfig).mockRejectedValueOnce(new Error('default save failed'));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
    expect(notificationStore.getState().activeNotifications.some(item => item.message === 'modelSelector.defaultSaveFailed')).toBe(true);
    expect(optionsPanel()).toBeNull();
  });

  it('skips an identical session update while remembering the default and clears a preset in automatic mode', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'acme-fast' } });
    await renderSelector(CATALOG_MODELS, 'acme-fast', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-fast')!.click());
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'acme-fast' });
    flowChatStoreMocks.sessions.get('session-a')!.config.modelName = 'primary';
    flowChatStoreMocks.sessions.get('session-a')!.config.reasoningPreset = 'high';
    await act(async () => flowChatStoreMocks.subscribers.forEach(callback => callback()));
    await openModeMenu();
    await act(async () => modeOption('smart')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'primary', reasoningPreset: null }));
    await openModeMenu();
    await act(async () => modeOption('pool')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledTimes(1);
  });

  it('rolls back an unpinned selection and context limit when the session update fails', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: {} });
    vi.mocked(agentAPI.updateSessionModel).mockRejectedValueOnce(new Error('session write failed'));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(flowChatStoreMocks.store.updateSessionModelName).toHaveBeenLastCalledWith('session-a', undefined);
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenLastCalledWith('session-a', undefined);
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('shows only the chosen provider\'s models and applies a selection', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openMenu();
    await openProvider('provider-acme');

    expect(document.body.querySelector('[data-testid="chat-model-selector-back"]')).toBeNull();
    expect(providerRows()).toHaveLength(0);
    expect(modelOption('acme-fast')).not.toBeNull();
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(sharedPanelItems()).not.toBeNull();
    expect(sharedPanelItems()?.contains(modelOption('acme-fast'))).toBe(true);
    expect(sharedPanelItems()?.contains(modelOption('acme-deep'))).toBe(true);
    // Model choices are concrete models owned by this provider.
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
      'ai.agent_model_selections.mode', { kind: 'model', model_ref: 'acme-deep' },
    );
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(card);
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption('acme-deep')?.getAttribute('aria-checked')).toBe('true');
    expect(modelOption('umbra-main')).not.toBeNull();
  });

  it('keeps the selector visible and actionable when no model is configured', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [],
      'ai.default_models': {},
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'primary' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'primary' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'primary' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'legacy-chat' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(1);
    await openProvider('provider-legacy');
    expect(modelOption('legacy-chat')).not.toBeNull();
  });

  it('keeps model choices available when the optional catalog request fails', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast', fast: 'umbra-main' },
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'acme-fast' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
  });

  it('refreshes the selector after the model configuration is saved', async () => {
    const onAvailabilityChange = vi.fn();
    const firstModel = model('first-model', 'First', 'provider-first', 'https://first.test/v1');
    const secondModel = model('second-model', 'Second', 'provider-second', 'https://second.test/v1');

    vi.mocked(configManager.getConfigs)
      .mockResolvedValueOnce({
        'ai.models': [firstModel],
        'ai.default_models': { primary: 'first-model' },
        'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'first-model' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
      })
      .mockResolvedValueOnce({
        'ai.models': [secondModel],
        'ai.default_models': { primary: 'second-model' },
        'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'second-model' }, subagents: { default: { kind: 'model', model_ref: 'fast' }, builtin: {}, fork: { kind: 'inherit' } } },
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
    expect(listeners).toHaveLength(2);
    await act(async () => {
      // ModelSettingsPage writes ai.models through ConfigManager's ai-scoped
      // mutation notification, so this is the post-save event to handle.
      listeners.forEach(listener => listener('ai'));
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

  it('keeps the current filtered list intact until the short exit finishes', async () => {
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
    expect(surface.getAttribute('data-menu-level')).toBe('models');
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

    await act(async () => optionsPanel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
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
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
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

    await openProvider('legacy-model');
    expect(modelOption('legacy-model')).not.toBeNull();
  });
});
