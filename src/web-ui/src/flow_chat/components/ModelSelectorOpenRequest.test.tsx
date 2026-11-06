/**
 * @vitest-environment jsdom
 */

import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const aiApiMocks = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  onModelCatalogUpdated: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({
  aiApi: aiApiMocks,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: vi.fn(async () => ({
      'ai.models': [
        {
          id: 'model-a',
          name: 'Local provider',
          model_name: 'friendly-model-a',
          provider: 'openai',
          base_url: 'https://example.test/v1',
          enabled: true,
          category: 'text',
          capabilities: ['text_chat'],
        },
      ],
      'ai.default_models': { primary: 'model-a' },
      'ai.agent_model_selections': { mode: { kind: 'model', model_ref: 'model-a' } },
    })),
    onConfigChange: vi.fn(() => () => undefined),
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
  globalEventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({
      getState: () => ({ sessions: new Map() }),
      subscribe: () => () => undefined,
    }),
  },
}));

describe('ModelSelector open requests', () => {
  let container: HTMLDivElement;
  let root: Root;

  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]');
  const menu = () => document.body.querySelector('[data-testid="chat-model-selector-menu"]');
  const isOpen = () => trigger()?.getAttribute('aria-expanded') === 'true';

  const renderSelector = async (
    props: { openRequest?: number; disabled?: boolean; onRequestMenuClosed?: () => void } = {},
  ) => {
    await act(async () => {
      root.render(
        <ModelSelector
          currentMode="Standard"
          sessionId="session-a"
          openRequest={props.openRequest}
          disabled={props.disabled}
          onRequestMenuClosed={props.onRequestMenuClosed}
          reasoningTriggerPresentation="label"
        />,
      );
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    activateSurface('local');
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
      default_models: { primary: 'model-a' },
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

  it('opens the menu when the composer raises a request', async () => {
    await renderSelector({ openRequest: 0 });
    expect(isOpen()).toBe(false);
    expect(menu()).toBeNull();

    await renderSelector({ openRequest: 1 });
    expect(isOpen()).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it('handles each request value once, so a retained value cannot reopen a dismissed menu', async () => {
    await renderSelector({ openRequest: 1 });
    expect(isOpen()).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(isOpen()).toBe(false);

    await renderSelector({ openRequest: 1 });
    expect(isOpen()).toBe(false);

    await renderSelector({ openRequest: 2 });
    expect(isOpen()).toBe(true);
  });

  it('ignores a request while the selector refuses changes', async () => {
    const onRequestMenuClosed = vi.fn();
    await renderSelector({ openRequest: 1, disabled: true, onRequestMenuClosed });
    expect(isOpen()).toBe(false);
    expect(trigger()?.disabled).toBe(true);
    expect(onRequestMenuClosed).not.toHaveBeenCalled();
  });

  it('hands focus back to the composer once a requested menu closes', async () => {
    const onRequestMenuClosed = vi.fn();
    await renderSelector({ openRequest: 1, onRequestMenuClosed });
    expect(isOpen()).toBe(true);
    expect(onRequestMenuClosed).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(isOpen()).toBe(false);
    expect(onRequestMenuClosed).toHaveBeenCalledTimes(1);
  });

  it('does not claim focus after a menu opened by the trigger closes', async () => {
    const onRequestMenuClosed = vi.fn();
    await renderSelector({ onRequestMenuClosed });
    await act(async () => {
      trigger()?.click();
    });
    expect(isOpen()).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(isOpen()).toBe(false);
    expect(onRequestMenuClosed).not.toHaveBeenCalled();
  });
});
