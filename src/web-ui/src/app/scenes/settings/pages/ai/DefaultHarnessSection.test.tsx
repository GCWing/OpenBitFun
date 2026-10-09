// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatInputModePreference } from '@/flow_chat/services/ChatInputModePreferenceService';
import { DefaultHarnessSection } from '@/app/scenes/settings/pages/ai/DefaultHarnessSection';

const mocks = vi.hoisted(() => ({
  preference: {
    strategy: 'follow_last',
    fixedModeId: null,
    lastModeId: 'Creative',
  } as ChatInputModePreference,
  getPreference: vi.fn(),
  setStrategy: vi.fn(),
  setFixedMode: vi.fn(),
  subscribe: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/flow_chat/services/ChatInputModePreferenceService', async original => ({
  ...await original<typeof import('@/flow_chat/services/ChatInputModePreferenceService')>(),
  chatInputModePreferenceService: {
    getPreference: mocks.getPreference,
    setStrategy: mocks.setStrategy,
    setFixedMode: mocks.setFixedMode,
    subscribe: mocks.subscribe,
  },
}));

vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.name ? `${key}:${values.name}` : values?.id ? `${key}:${values.id}` : key,
  }),
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    success: mocks.success,
    error: mocks.error,
  },
}));

vi.mock('@openbitfun/ui', async original => ({
  ...await original<typeof import('@openbitfun/ui')>(),
  Select: ({
    value,
    options,
    disabled,
    onValueChange,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={event => onValueChange(event.target.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

describe('DefaultHarnessSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.preference = {
      strategy: 'follow_last',
      fixedModeId: null,
      lastModeId: 'Creative',
    };
    mocks.getPreference.mockReset().mockImplementation(async () => mocks.preference);
    mocks.setStrategy.mockReset().mockImplementation(async strategy => {
      mocks.preference = {
        ...mocks.preference,
        strategy,
        fixedModeId: strategy === 'fixed'
          ? mocks.preference.fixedModeId ?? mocks.preference.lastModeId ?? 'Standard'
          : mocks.preference.fixedModeId,
      };
      return mocks.preference;
    });
    mocks.setFixedMode.mockReset().mockImplementation(async modeId => {
      mocks.preference = { ...mocks.preference, strategy: 'fixed', fixedModeId: modeId };
      return mocks.preference;
    });
    mocks.subscribe.mockReset().mockReturnValue(() => undefined);
    mocks.success.mockReset();
    mocks.error.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => root.render(<DefaultHarnessSection />));
  };

  it('shows follow-last memory and reveals a seeded fixed selector when requested', async () => {
    await render();

    const strategySelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-strategy"] select',
    );
    expect(strategySelect?.value).toBe('follow_last');
    expect(container.textContent).toContain('defaultHarness.followLastDescription:chatInput.harness.profiles.Creative.name');
    expect(container.querySelector('[data-testid="default-harness-fixed-mode"]')).toBeNull();

    await act(async () => {
      strategySelect!.value = 'fixed';
      strategySelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.setStrategy).toHaveBeenCalledWith('fixed');
    const fixedSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-fixed-mode"] select',
    );
    expect(fixedSelect?.value).toBe('Creative');

    await act(async () => {
      fixedSelect!.value = 'Ultimate';
      fixedSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.setFixedMode).toHaveBeenCalledWith('Ultimate');
  });

  it('keeps an existing custom fixed default visible as compatibility config', async () => {
    mocks.preference = {
      strategy: 'fixed',
      fixedModeId: 'PlannerPlus',
      lastModeId: null,
    };

    await render();

    const fixedSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-fixed-mode"] select',
    );
    expect(fixedSelect?.value).toBe('PlannerPlus');
    expect(fixedSelect?.selectedOptions[0]?.textContent).toBe(
      'defaultHarness.compatibilityMode:PlannerPlus',
    );
  });

  it('locks the section instead of presenting defaults after a failed read', async () => {
    mocks.getPreference.mockRejectedValue(new Error('Host is unavailable'));

    await render();

    expect(container.textContent).toContain('defaultHarness.loadFailed');
    expect(container.querySelector('select')).toBeNull();
  });

  it('does not let a late initial read overwrite a newer config notification', async () => {
    let resolveInitialRead: ((value: ChatInputModePreference) => void) | undefined;
    let publishPreference: ((value: ChatInputModePreference) => void) | undefined;
    mocks.getPreference.mockImplementationOnce(() => new Promise(resolve => {
      resolveInitialRead = resolve;
    }));
    mocks.subscribe.mockImplementation(listener => {
      publishPreference = listener;
      return () => undefined;
    });

    await render();
    await act(async () => {
      publishPreference?.({
        strategy: 'fixed',
        fixedModeId: 'Ultimate',
        lastModeId: 'Creative',
      });
      resolveInitialRead?.({
        strategy: 'follow_last',
        fixedModeId: null,
        lastModeId: 'Minimal',
      });
      await Promise.resolve();
    });

    const strategySelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-strategy"] select',
    );
    const fixedSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-fixed-mode"] select',
    );
    expect(strategySelect?.value).toBe('fixed');
    expect(fixedSelect?.value).toBe('Ultimate');
  });

  it('rolls an optimistic change back when persistence fails', async () => {
    mocks.setStrategy.mockRejectedValueOnce(new Error('save failed'));
    await render();

    const strategySelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="default-harness-strategy"] select',
    );
    await act(async () => {
      strategySelect!.value = 'fixed';
      strategySelect!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(strategySelect?.value).toBe('follow_last');
    expect(mocks.error).toHaveBeenCalledWith('messages.saveFailed');
  });
});
