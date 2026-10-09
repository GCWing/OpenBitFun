// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditorSettingsPage from '@/app/scenes/settings/pages/development/EditorSettingsPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), emit: vi.fn(), t: (key: string) => key,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('../../../../../infrastructure/config/services/ConfigManager', () => ({ configManager: { getConfig: mocks.get, updateConfig: mocks.update } }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { emit: mocks.emit } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../../../../../infrastructure/config/components/common', () => {
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    ConfigPageLayout: Container, ConfigPageContent: Container,
    ConfigPageSection: Container, ConfigPageRow: Container,
    ConfigPageHeader: () => null, ConfigLoadingState: () => null,
    ConfigRetryState: () => <div>retry</div>, ConfigFieldStatus: () => null,
    ConfigMessage: () => null,
  };
});

let root: Root;
let container: HTMLDivElement;
let persisted: Record<string, unknown>;
const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const mount = async () => { await act(async () => root.render(<EditorSettingsPage />)); };
beforeEach(() => {
  vi.clearAllMocks();
  persisted = { tab_size: 4, insert_spaces: true, detect_indentation: true };
  mocks.get.mockImplementation(async () => persisted);
  mocks.update.mockImplementation(async (_path, patch) => {
    persisted = patch(persisted);
    return persisted;
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('editor indentation settings', () => {
  it('renders consistent two-letter units using real number controls and does not save on load', async () => {
    persisted = { detect_indentation: true };
    await mount();
    expect(Array.from(container.querySelectorAll('[data-openbitfun-part="unit"]'), el => el.textContent))
      .toEqual(['px', 'em', 'ch']);
    expect(input('behavior.tabSize').value).toBe('4');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves existing preferences and disables the unsupported switch for an older host', async () => {
    persisted = { tab_size: 2, insert_spaces: false };
    await mount();
    expect(input('behavior.tabSize').value).toBe('2');
    expect(input('behavior.insertSpaces').checked).toBe(false);
    expect(input('behavior.detectIndentation').disabled).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('commits integer widths as a narrow patch and keeps unrelated preferences', async () => {
    persisted.font_family = 'Fixture Mono';
    await mount();
    const field = input('behavior.tabSize');
    await act(async () => { Simulate.focus(field); });
    await act(async () => { field.value = '3.4'; Simulate.change(field); });
    await act(async () => { Simulate.blur(field); });
    expect(persisted.tab_size).toBe(3);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(persisted.font_family).toBe('Fixture Mono');
    expect(input('behavior.tabSize').value).toBe('3');
  });

  it('rolls the detection switch back when saving fails', async () => {
    mocks.update.mockRejectedValue(new Error('offline'));
    await mount();
    const field = input('behavior.detectIndentation');
    await act(async () => { field.checked = false; Simulate.change(field); });
    expect(mocks.update.mock.calls[0][1](persisted).detect_indentation).toBe(false);
    expect(input('behavior.detectIndentation').checked).toBe(true);
  });
});
