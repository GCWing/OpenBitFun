/**
 * @vitest-environment jsdom
 *
 * The composer's mode picker for ACP sessions. An agent publishes its modes as
 * a `mode`-category config option, and it gets a trigger of its own beside the
 * model picker — the two are unrelated choices and used to share one dropdown.
 * This covers the agent that publishes only a mode, the agent that publishes
 * both, and the agent that has fixed the mode and left exactly one choice.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { ACPClientAPI, type AcpSessionOptions } from '@/infrastructure/api/service-api/ACPClientAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const aiApiMocks = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  onModelCatalogUpdated: vi.fn(),
}));

const flowChatStoreMocks = vi.hoisted(() => {
  type TestSession = {
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
    config: { agentType?: string; modelName?: string; workspacePath?: string };
  };
  const sessions = new Map<string, TestSession>();
  const store = {
    getState: () => ({ sessions }),
    subscribe: vi.fn(() => () => undefined),
    updateSessionModelName: vi.fn(),
    updateSessionReasoningPreset: vi.fn(),
    updateSessionMaxContextTokens: vi.fn(),
    updateAcpContextUsage: vi.fn(),
  };
  return { sessions, store };
});

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: aiApiMocks }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  // Keep the hover copy inspectable: descriptions live only in the tooltip now.
  Tooltip: ({ children, content }: { children: React.ReactNode; content?: React.ReactNode }) => (
    <span data-tooltip={typeof content === 'string' ? content : undefined}>{children}</span>
  ),
  Switch: () => null,
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: vi.fn(async () => ({ 'ai.models': [] })),
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
    setSessionModel: vi.fn(),
    setSessionConfigOption: vi.fn(),
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

/** The mode option as an unlocked agent publishes it. */
const MODE_OPTION = {
  id: 'agent-preset',
  name: 'Mode',
  category: 'mode',
  type: 'select' as const,
  currentValue: 'standard',
  options: [
    { value: 'standard', name: 'Standard', description: 'the default toolset' },
    { value: 'minimal', name: 'Minimal', description: 'bash and an editor' },
  ],
};

describe('ModelSelector ACP mode picker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    flowChatStoreMocks.sessions.clear();
    flowChatStoreMocks.sessions.set('acp-session', {
      workspacePath: '/tmp/project',
      config: { agentType: 'acp:dsh' },
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
    aiApiMocks.getModelCatalog.mockResolvedValue({ version: 1, default_models: {}, models: [] });
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Render the selector against one set of ACP session options. */
  const renderWithOptions = async (
    configOptions: unknown[],
    session: { availableModels?: unknown[]; currentModelId?: string } = {},
  ) => {
    vi.mocked(ACPClientAPI.getSessionOptions).mockResolvedValue({
      availableModels: session.availableModels ?? [],
      ...(session.currentModelId ? { currentModelId: session.currentModelId } : {}),
      configOptions,
    } as never);
    await act(async () => {
      root.render(<ModelSelector currentMode="acp:dsh" sessionId="acp-session" reasoningTriggerPresentation="label" />);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
  };

  it('shows loading without duplicating the request and closes the model card for a mode-only response', async () => {
    let resolveOptions!: (options: AcpSessionOptions) => void;
    vi.mocked(ACPClientAPI.getSessionOptions).mockReturnValueOnce(new Promise(resolve => {
      resolveOptions = resolve;
    }));
    await act(async () => root.render(<ModelSelector currentMode="acp:dsh" sessionId="acp-session" />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')?.textContent)
      .toContain('modelSelector.status.loading');
    expect(ACPClientAPI.getSessionOptions).toHaveBeenCalledTimes(1);

    await act(async () => resolveOptions({ availableModels: [], configOptions: [MODE_OPTION] }));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-acp-mode-selector-btn"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves loading after an ACP failure and retries when the card is reopened', async () => {
    let rejectOptions!: (error: Error) => void;
    const onAvailabilityChange = vi.fn();
    vi.mocked(ACPClientAPI.getSessionOptions).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectOptions = reject;
    }));
    await act(async () => root.render(
      <ModelSelector currentMode="acp:dsh" sessionId="acp-session" onAvailabilityChange={onAvailabilityChange} />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    await act(async () => trigger.click());
    await act(async () => rejectOptions(new Error('Host offline')));
    expect(trigger.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-status"]')?.getAttribute('data-model-status')).toBe('load-error');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({ status: 'load-error', canSend: false });

    let resolveRetry!: (options: AcpSessionOptions) => void;
    vi.mocked(ACPClientAPI.getSessionOptions).mockReturnValueOnce(new Promise(resolve => {
      resolveRetry = resolve;
    }));
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).not.toBeNull();
    expect(ACPClientAPI.getSessionOptions).toHaveBeenCalledTimes(2);
    await act(async () => resolveRetry({
      currentModelId: 'remote-model',
      availableModels: [{ id: 'remote-model', name: 'Remote Model' }],
      configOptions: [],
    }));
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-model-id="remote-model"]')).not.toBeNull();
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({ status: 'ready', canSend: true });
  });

  it('preserves cached ACP information when a background refresh fails', async () => {
    await renderWithOptions([], {
      currentModelId: 'remote-model',
      availableModels: [{ id: 'remote-model', name: 'Remote Model' }],
    });
    let rejectRefresh!: (error: Error) => void;
    vi.mocked(ACPClientAPI.getSessionOptions).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-model-id="remote-model"]')).not.toBeNull();

    await act(async () => rejectRefresh(new Error('Host offline')));
    expect(trigger.hasAttribute('aria-busy')).toBe(false);
    expect(trigger.textContent).toContain('Remote Model');
    expect(document.body.querySelector('[data-model-id="remote-model"]')).not.toBeNull();
  });

  it('ignores an earlier session response after the selected session changes', async () => {
    let resolvePrevious!: (options: AcpSessionOptions) => void;
    vi.mocked(ACPClientAPI.getSessionOptions).mockReturnValueOnce(new Promise(resolve => {
      resolvePrevious = resolve;
    })).mockResolvedValueOnce({
      currentModelId: 'new-model',
      availableModels: [{ id: 'new-model', name: 'New Model' }],
      configOptions: [],
    });
    flowChatStoreMocks.sessions.set('new-session', {
      workspacePath: '/tmp/new-project',
      config: { agentType: 'acp:dsh' },
    });
    await act(async () => root.render(<ModelSelector currentMode="acp:dsh" sessionId="acp-session" />));
    await act(async () => root.render(<ModelSelector currentMode="acp:dsh" sessionId="new-session" />));
    await act(async () => resolvePrevious({
      currentModelId: 'old-model',
      availableModels: [{ id: 'old-model', name: 'Old Model' }],
      configOptions: [],
    }));
    const trigger = container.querySelector('[data-testid="chat-model-selector-btn"]');
    expect(trigger?.textContent).toContain('New Model');
    expect(trigger?.textContent).not.toContain('Old Model');
    expect(trigger?.hasAttribute('aria-busy')).toBe(false);
  });

  it('renders the mode as the whole picker when the agent offers no models', async () => {
    await renderWithOptions([MODE_OPTION]);

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-acp-mode-selector-btn"]');
    // Without this the ACP branch used to return null on an empty model list,
    // leaving a dsh session with no picker at all.
    expect(trigger, 'the mode picker must render without models').not.toBeNull();
    expect(trigger?.textContent).toContain('Standard');
    // Nothing left for the model picker to show, so it stays away entirely.
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')).toBeNull();

    await act(async () => { trigger?.click(); });
    const options = document.body.querySelectorAll('[data-testid="chat-acp-mode-option"]');
    expect([...options].map(option => option.getAttribute('data-mode-value')))
      .toEqual(['standard', 'minimal']);
  });

  it('keeps the mode out of the model dropdown when the agent offers both', async () => {
    await renderWithOptions([MODE_OPTION], {
      availableModels: [
        { id: 'deepseek-official/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-official/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      currentModelId: 'deepseek-official/deepseek-v4-flash',
    });

    const modelTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]');
    const modeTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-acp-mode-selector-btn"]');
    expect(modelTrigger, 'the model picker keeps its own trigger').not.toBeNull();
    expect(modeTrigger?.textContent).toContain('Standard');

    // The whole point of the split: one button, one kind of choice.
    await act(async () => { modelTrigger?.click(); });
    const modelMenu = document.body.querySelector('[data-testid="chat-model-selector-menu"]');
    expect(modelMenu?.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(2);
    expect(modelMenu?.querySelectorAll('[data-testid="chat-acp-mode-option"]')).toHaveLength(0);

    await act(async () => { modeTrigger?.click(); });
    expect(
      document.body.querySelectorAll('[data-testid="chat-acp-mode-selector-menu"] [data-testid="chat-acp-mode-option"]'),
    ).toHaveLength(2);
  });

  it('sends the chosen mode to the agent', async () => {
    await renderWithOptions([MODE_OPTION]);
    vi.mocked(ACPClientAPI.setSessionConfigOption).mockResolvedValue({
      availableModels: [],
      configOptions: [{ ...MODE_OPTION, currentValue: 'minimal' }],
    } as never);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-acp-mode-selector-btn"]')?.click();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-acp-mode-option"][data-mode-value="minimal"]',
      )?.click();
      await Promise.resolve();
    });

    expect(ACPClientAPI.setSessionConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'acp-session',
      clientId: 'dsh',
      configId: 'agent-preset',
      value: { type: 'select', value: 'minimal' },
    }));
    expect(
      container.querySelector('[data-testid="chat-acp-mode-selector-btn"]')?.textContent,
    ).toContain('Minimal');
  });

  it('disables the picker once the agent leaves one mode', async () => {
    // How an agent says "fixed" without a flag ACP does not have: it publishes
    // only the mode in force, and explains itself in the option description.
    await renderWithOptions([{
      ...MODE_OPTION,
      description: 'This conversation has already started, so its mode is fixed.',
      options: [MODE_OPTION.options[0]],
    }]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-acp-mode-selector-btn"]')?.click();
    });
    const options = document.body.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-acp-mode-option"]',
    );
    expect(options).toHaveLength(1);
    expect(options[0]?.disabled).toBe(true);
    // The row itself stays a bare mode name; the reason is hover-only.
    expect(options[0]?.textContent).toBe('Standard');
    expect(options[0]?.getAttribute('title')).toContain('already started');

    await act(async () => {
      options[0]?.click();
      await Promise.resolve();
    });
    expect(ACPClientAPI.setSessionConfigOption).not.toHaveBeenCalled();
  });

  const reasoningOption = {
    id: 'reasoning-effort', name: 'Reasoning', category: 'thought_level',
    type: 'select' as const, currentValue: 'medium',
    options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
  };
  const modelOptions = {
    availableModels: [{ id: 'remote-model', name: 'Remote Model' }],
    currentModelId: 'remote-model',
  };
  const click = async (testId: string) => {
    const button = document.body.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); });
  };

  it('opens only the current ACP provider and switches models through the remote adapter', async () => {
    Object.assign(flowChatStoreMocks.sessions.get('acp-session')!, {
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'a100',
    });
    const sessionOptions = {
      availableModels: [
        { id: 'model-one', name: 'Model One', providerName: 'Acme' },
        { id: 'model-two', name: 'Model Two', providerName: 'Acme' },
        { id: 'other-model', name: 'Other Model', providerName: 'Umbra' },
      ],
      currentModelId: 'model-one',
    };
    await renderWithOptions([reasoningOption], sessionOptions);
    await click('chat-model-selector-btn');
    await click('chat-model-selector-settings-provider');

    expect(document.body.querySelector('[data-testid="chat-model-selector-provider"]')).toBeNull();
    expect(document.body.querySelector('[data-model-id="other-model"]')).toBeNull();
    expect(document.body.querySelector('[data-model-id="model-one"]')?.getAttribute('aria-checked')).toBe('true');
    vi.mocked(ACPClientAPI.setSessionModel).mockResolvedValue({
      ...sessionOptions, currentModelId: 'model-two', configOptions: [reasoningOption],
    } as never);
    const model = document.body.querySelector<HTMLButtonElement>('[data-model-id="model-two"]');
    expect(model).not.toBeNull();
    await act(async () => { model!.click(); });

    expect(ACPClientAPI.setSessionModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'acp-session', clientId: 'dsh', modelId: 'model-two',
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'a100',
    }));
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('shares model and reasoning settings and writes the selected value through the remote ACP adapter', async () => {
    Object.assign(flowChatStoreMocks.sessions.get('acp-session')!, {
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'a100',
    });
    await renderWithOptions([MODE_OPTION, reasoningOption], modelOptions);
    expect(container.querySelector('[data-testid="chat-reasoning-preset-selector-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-trigger-reasoning"]')?.textContent)
      .toContain('reasoningSelector.levels.medium');
    await click('chat-model-selector-btn');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).not.toBeNull();
    await click('chat-model-selector-settings-model');
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(1);
    await click('chat-model-selector-summary-back');
    await click('chat-model-selector-settings-reasoning');
    expect(document.body.querySelector('[data-openbitfun-value="preset:auto"]')).toBeNull();
    vi.mocked(ACPClientAPI.setSessionConfigOption).mockResolvedValue({
      ...modelOptions, configOptions: [MODE_OPTION, { ...reasoningOption, currentValue: 'high' }],
    } as never);
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="preset:high"]')?.click();
    });
    expect(ACPClientAPI.setSessionConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'acp-session', clientId: 'dsh', configId: 'reasoning-effort',
      remoteConnectionId: 'ssh-connection', remoteSshHost: 'a100',
      value: { type: 'select', value: 'high' },
    }));
    expect(container.querySelector('[data-testid="chat-model-selector-trigger-reasoning"]')?.textContent)
      .toContain('reasoningSelector.levels.high');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]'));
  });

  it('keeps reasoning accessible when ACP advertises no model list', async () => {
    await renderWithOptions([MODE_OPTION, reasoningOption]);
    await click('chat-model-selector-btn');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBeNull();
    await click('chat-model-selector-settings-reasoning');
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-reasoning-options"] button:not(:disabled)')).toHaveLength(2);
    expect(document.body.querySelector('[data-openbitfun-value="unavailable:xhigh"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-acp-mode-selector-btn"]')).not.toBeNull();
  });

  it.each(['choices', 'summary'] as const)('preserves keyboard focus when the opening frame runs in the %s view', async (frameTarget) => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    await renderWithOptions([reasoningOption], modelOptions);
    await click('chat-model-selector-btn');
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-reasoning"]')!;
    await act(async () => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement?.getAttribute('data-openbitfun-value')).toBe('preset:medium');
    if (frameTarget === 'choices') {
      await act(async () => { vi.advanceTimersToNextFrame(); });
      expect(document.activeElement?.getAttribute('data-openbitfun-value')).toBe('preset:medium');
    }
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    const returnedRow = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-reasoning"]')!;
    expect(document.activeElement).toBe(returnedRow);
    // Deliver the initial menu-focus frame after the user has already returned
    // from the choices, as can happen under a busy browser or CI runner.
    await act(async () => { vi.advanceTimersToNextFrame(); });
    expect(document.activeElement).toBe(returnedRow);
    await act(async () => {
      returnedRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="chat-model-selector-btn"]'));
  });

  it('retains the current reasoning value after an ACP update fails', async () => {
    await renderWithOptions([reasoningOption], modelOptions);
    vi.mocked(ACPClientAPI.setSessionConfigOption).mockRejectedValueOnce(new Error('Host offline'));
    await click('chat-model-selector-btn');
    await click('chat-model-selector-settings-reasoning');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="preset:high"]')?.click();
    });
    expect(container.querySelector('[data-testid="chat-model-selector-trigger-reasoning"]')?.textContent)
      .toContain('reasoningSelector.levels.medium');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')?.disabled).toBe(false);
  });

  it('keeps the advertised fast mode available in the shared settings menu', async () => {
    const fastMode = { id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: false };
    await renderWithOptions([reasoningOption, fastMode], modelOptions);
    await click('chat-model-selector-btn');
    const fastRow = document.body.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
    expect(fastRow).not.toBeNull();
    vi.mocked(ACPClientAPI.setSessionConfigOption).mockResolvedValue({
      ...modelOptions, configOptions: [reasoningOption, { ...fastMode, currentValue: true }],
    } as never);
    await act(async () => { fastRow?.click(); });
    expect(ACPClientAPI.setSessionConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'fast-mode', value: { type: 'boolean', value: true },
    }));
  });


  it('uses an advertised ACP auto value instead of synthesizing a local reset', async () => {
    const withAuto = { ...reasoningOption, options: [...reasoningOption.options, { value: 'auto', name: 'Auto' }] };
    await renderWithOptions([withAuto], modelOptions);
    await click('chat-model-selector-btn');
    await click('chat-model-selector-settings-reasoning');
    expect(document.body.querySelectorAll('[data-openbitfun-value="auto"]')).toHaveLength(1);
    const autoOptions = {
      ...modelOptions, configOptions: [{ ...withAuto, currentValue: 'auto' }],
    };
    vi.mocked(ACPClientAPI.setSessionConfigOption).mockResolvedValue(autoOptions as never);
    vi.mocked(ACPClientAPI.getSessionOptions).mockResolvedValue(autoOptions as never);
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="auto"]')?.click(); });
    expect(ACPClientAPI.setSessionConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'reasoning-effort', value: { type: 'select', value: 'auto' },
    }));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-reasoning-mode="auto"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-intensity-option"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.auto');
  });

  it('shows an advertised model when an older ACP payload omits the current model id', async () => {
    await renderWithOptions([reasoningOption], { availableModels: modelOptions.availableModels });
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent).toContain('Remote Model');
  });

});
