// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ContextSettingsPage from '@/app/scenes/settings/pages/ai/ContextSettingsPage';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfig: mocks.getConfig,
    setConfig: mocks.setConfig,
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    success: mocks.success,
    error: mocks.error,
  },
}));

vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@openbitfun/ui', async original => ({
  ...await original<typeof import('@openbitfun/ui')>(),
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onChange: (event: { target: { checked: boolean } }) => void;
  }) => (
    <input
      type="checkbox"
      aria-label="prefetch-switch"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange({ target: { checked: event.target.checked } })}
    />
  ),
}));

function findSwitch(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[aria-label="prefetch-switch"]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

describe('ContextSettingsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getConfig.mockReset().mockImplementation(async () => true);
    mocks.setConfig.mockReset().mockImplementation(async () => undefined);
    mocks.success.mockReset();
    mocks.error.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the prefetch switch from the stored config value', async () => {
    mocks.getConfig.mockImplementation(async () => false);
    await act(async () => {
      root.render(<ContextSettingsPage />);
    });
    expect(findSwitch(container).checked).toBe(false);
    expect(mocks.getConfig).toHaveBeenCalledWith('ai.enable_context_compression_prefetch');
  });

  it('saves the toggled prefetch value and reports success', async () => {
    await act(async () => {
      root.render(<ContextSettingsPage />);
    });
    const switchInput = findSwitch(container);
    expect(switchInput.checked).toBe(true);
    await act(async () => {
      switchInput.click();
    });
    expect(mocks.setConfig).toHaveBeenCalledWith('ai.enable_context_compression_prefetch', false);
    expect(mocks.success).toHaveBeenCalled();
    expect(findSwitch(container).checked).toBe(false);
  });

  it('rolls the switch back and reports an error when saving fails', async () => {
    mocks.setConfig.mockImplementation(async () => {
      throw new Error('persist failed');
    });
    await act(async () => {
      root.render(<ContextSettingsPage />);
    });
    const switchInput = findSwitch(container);
    await act(async () => {
      switchInput.click();
    });
    expect(mocks.setConfig).toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
    expect(findSwitch(container).checked).toBe(true);
  });
});
