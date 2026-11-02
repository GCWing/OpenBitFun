/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCnFlowChat from '@/locales/zh-CN/flow-chat.json';
import { ReasoningPresetSelector } from './ReasoningPresetSelector';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, string>) => {
      const template = ({
        'reasoningSelector.levels.off': 'Off',
        'reasoningSelector.levels.on': 'On',
        'reasoningSelector.levels.low': 'Low',
        'reasoningSelector.levels.medium': 'Medium',
        'reasoningSelector.levels.high': 'High',
        'reasoningSelector.levels.xhigh': 'Extra high',
        'reasoningSelector.levels.max': 'Maximum',
        'reasoningSelector.auto': 'Auto',
        'reasoningSelector.current': 'Thinking: {{preset}}',
        'reasoningSelector.currentAuto': 'Thinking: auto ({{preset}})',
      } as Record<string, string>)[key] ?? options?.defaultValue ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
    },
  }),
}));

vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

describe('ReasoningPresetSelector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it('hides unknown capability projections', () => {
    act(() => {
      root.render(
        <ReasoningPresetSelector
          projection={{ status: 'unknown', presets: [] }}
          onSelect={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('[data-testid="chat-reasoning-preset-selector-btn"]')).toBeNull();
  });

  it('selects a concrete preset and can return to Auto', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            default_preset: 'medium',
            presets: [
              { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
              { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
            ],
          }}
          selectedPreset="high"
          onSelect={onSelect}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-reasoning-preset-selector-btn"]')?.click();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-preset-id="medium"]')?.click();
    });
    expect(onSelect).toHaveBeenCalledWith('medium');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-reasoning-preset-selector-btn"]')?.click();
    });
    const auto = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find(item => !item.dataset.presetId);
    await act(async () => {
      auto?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('renders Auto and presets as text-only single-line options', async () => {
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            presets: [
              { id: 'low', label: 'Low', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'low' }] },
              { id: 'custom-low', label: 'Low', order: 20, source: 'model_config', actions: [{ type: 'effort', value: 'low' }] },
              { id: 'high', label: 'High', order: 30, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'high' }] },
            ],
          }}
          onSelect={vi.fn()}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-reasoning-preset-selector-btn"]')?.click();
    });

    const auto = document.body.querySelector<HTMLButtonElement>(
      '.openbitfun-reasoning-preset-selector__auto-row [data-openbitfun-part="trigger"]',
    );
    const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>(
      '.openbitfun-reasoning-preset-selector__options [data-preset-id]',
    ));
    expect(auto?.textContent).toBe('Auto');
    expect(options.map(option => option.textContent)).toEqual(['Low', 'Low', 'High']);
    expect([auto, ...options].every(option => (
      option?.querySelector('small, svg') === null
    ))).toBe(true);
  });

  it('uses the automatic icon and named manual levels in the trigger', async () => {
    const projection = {
      status: 'known' as const,
      default_preset: 'medium',
      presets: [
        { id: 'low', label: 'Low', order: 10, source: 'models_dev' as const, actions: [{ type: 'effort' as const, value: 'low' }] },
        { id: 'medium', label: 'Medium', order: 20, source: 'models_dev' as const, actions: [{ type: 'effort' as const, value: 'medium' }] },
        { id: 'high', label: 'High', order: 30, source: 'models_dev' as const, actions: [{ type: 'effort' as const, value: 'high' }] },
        { id: 'xhigh', label: 'Extra High', order: 40, source: 'models_dev' as const, actions: [{ type: 'effort' as const, value: 'xhigh' }] },
      ],
    };

    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={projection}
          onSelect={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="chat-reasoning-preset-selector-btn"]',
    );
    expect(trigger?.textContent).toBe('');
    expect(trigger?.getAttribute('aria-label')).toBe('Thinking: auto (Medium)');
    expect(trigger?.querySelector('[data-openbitfun-name="reasoning-auto"]')).not.toBeNull();

    for (const [presetId, label] of [
      ['low', 'Low'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ] as const) {
      await act(async () => {
        root.render(
          <ReasoningPresetSelector
            projection={projection}
            selectedPreset={presetId}
            onSelect={vi.fn()}
          />,
        );
      });
      expect(trigger?.textContent).toBe(label);
      expect(trigger?.querySelector('[data-openbitfun-component="icon"]')).toBeNull();
    }

    expect(
      container
        .querySelector('[data-testid="chat-reasoning-preset-selector-btn"]')
        ?.getAttribute('aria-label'),
    ).toBe('Thinking: Extra high');
  });

  it('renders the common four levels as an ordered text-only list', async () => {
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            default_preset: 'medium',
            presets: [
              { id: 'xhigh', label: 'Extra High', order: 40, source: 'models_dev', actions: [{ type: 'effort', value: 'xhigh' }] },
              { id: 'low', label: 'Low', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'low' }] },
              { id: 'high', label: 'High', order: 30, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
              { id: 'medium', label: 'Medium', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            ],
          }}
          selectedPreset="high"
          onSelect={vi.fn()}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-reasoning-preset-selector-btn"]')?.click();
    });

    const options = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '.openbitfun-reasoning-preset-selector__options [data-preset-id]',
      ),
    );
    expect(options.map(option => option.dataset.presetId))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(options.map(option => option.querySelector(
      '.openbitfun-reasoning-preset-selector__option-label',
    )?.textContent))
      .toEqual(['Low', 'Medium', 'High', 'Extra high']);
    expect(options.every(option => option.querySelector('small, svg') === null)).toBe(true);
    expect(options[2]?.getAttribute('aria-checked')).toBe('true');
  });

  it('presents an older enabled selection as Auto without rewriting it', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            default_preset: 'low',
            presets: [
              { id: 'max', label: 'Max', order: 40, source: 'models_dev', actions: [{ type: 'effort', value: 'max' }] },
              { id: 'off', label: 'Off', order: 0, source: 'models_dev', actions: [{ type: 'toggle', enabled: false }] },
              { id: 'high', label: 'High', order: 30, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
              { id: 'on', label: 'On', order: 1, source: 'models_dev', actions: [{ type: 'toggle', enabled: true }] },
              { id: 'low', label: 'Low', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'low' }] },
            ],
          }}
          selectedPreset="on"
          onSelect={onSelect}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-reasoning-preset-selector-btn"]',
      )?.click();
    });

    const options = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '.openbitfun-reasoning-preset-selector__options [data-preset-id]',
      ),
    );
    expect(options.map(option => option.dataset.presetId))
      .toEqual(['off', 'low', 'high', 'max']);
    expect(options.map(option => option.querySelector(
      '.openbitfun-reasoning-preset-selector__option-label',
    )?.textContent))
      .toEqual(['Off', 'Low', 'High', 'Maximum']);
    expect(options.every(option => option.querySelector('small, svg') === null)).toBe(true);

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-reasoning-preset-selector-btn"]',
    );
    expect(trigger?.getAttribute('aria-label')).toBe('Thinking: Auto');
    expect(options.find(option => option.dataset.presetId === 'low')?.getAttribute('aria-checked')).toBe('false');
    expect(document.body.querySelector('.openbitfun-reasoning-preset-selector__auto-row [aria-checked="true"]')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    for (const [label, presetId] of [['Low', 'low'], ['Off', 'off']] as const) {
      if (trigger?.getAttribute('aria-expanded') !== 'true') {
        await act(async () => trigger?.click());
      }
      const visibleChoice = Array.from(document.body.querySelectorAll<HTMLButtonElement>(
        '[data-preset-id]',
      )).find(option => option.textContent === label);
      expect(visibleChoice).toBeDefined();
      await act(async () => visibleChoice?.click());
      expect(onSelect).toHaveBeenLastCalledWith(presetId);
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    }

    expect(zhCnFlowChat.reasoningSelector.levels)
      .toMatchObject({ off: '关闭', low: '轻', medium: '中', high: '高', max: '最大' });
  });

  it('keeps the reasoning menu open and its focused choice available after selection', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            presets: [
              { id: 'high', label: 'High', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
            ],
          }}
          onSelect={onSelect}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-reasoning-preset-selector-btn"]',
    );
    trigger?.focus();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
    });

    const option = document.body.querySelector<HTMLButtonElement>('[data-preset-id="high"]');
    option?.focus();
    await act(async () => {
      option?.click();
    });

    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="chat-reasoning-preset-selector-menu"]',
    );
    expect(onSelect).toHaveBeenCalledWith('high');
    expect(document.activeElement).toBe(option);
    expect(menu?.getAttribute('aria-hidden')).toBe('false');
    expect(menu?.dataset.keyboardOpen).toBe('true');
  });

  it('restores trigger focus when Escape closes a focused menu', async () => {
    await act(async () => {
      root.render(
        <ReasoningPresetSelector
          projection={{
            status: 'known',
            presets: [
              { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            ],
          }}
          onSelect={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-reasoning-preset-selector-btn"]',
    );
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
    });
    const option = document.body.querySelector<HTMLButtonElement>('[data-preset-id="medium"]');
    option?.focus();

    await act(async () => {
      option?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[data-testid="chat-reasoning-preset-selector-menu"]')
      ?.getAttribute('aria-hidden')).toBe('true');
  });
});
