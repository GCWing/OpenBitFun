// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LivingLineSettingsSection from './LivingLineSettingsSection';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: vi.fn(), success: vi.fn() }) }));

describe('LivingLine settings section', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('renders 4 color and 8 numeric controls plus reset', async () => {
    await act(async () => root.render(<LivingLineSettingsSection />));
    expect(container.querySelectorAll('input[type="color"]').length).toBe(4);
    expect(container.querySelectorAll('input[type="range"]').length).toBe(8);
    expect(container.querySelectorAll('output').length).toBe(8);
    expect(container.querySelector('button')?.textContent).toContain('reset');
  });
});