/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningPresetDescriptor } from '@/infrastructure/config/types';
import { ReasoningIntensityControl } from './ReasoningIntensityControl';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string, options?: { defaultValue?: string }) => (
    key.startsWith('reasoningEffort.') ? options?.defaultValue ?? key : key
  ) }),
}));

const preset = (id: string): ReasoningPresetDescriptor => ({
  id, label: id, order: 0, source: 'models_dev',
  actions: id === 'off' ? [{ type: 'toggle', enabled: false }] : [{ type: 'effort', value: id }],
});
const allPresets = ['off', 'low', 'medium', 'high', 'xhigh'].map(preset);

describe('ReasoningIntensityControl', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn<(id: string | null) => Promise<boolean>>();
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-reasoning"]')!;
  const choices = () => {
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-model-selector-reasoning-options"]');
    return panel?.closest('[aria-hidden="true"]') ? null : panel;
  };
  const control = () => container.querySelector<HTMLElement>('[data-testid="chat-model-selector-intensity-control"]')!;
  const option = (value: string) => Array.from(choices()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find(button => button.dataset.openbitfunValue === value)!;
  const render = async (presets = allPresets, selected: string | undefined = 'medium', allowDefaultReset = true, disabled = false, active = true) => {
    await act(async () => root.render(
      <ReasoningIntensityControl
        presets={presets}
        selectedPreset={presets.find(item => item.id === selected)}
        allowDefaultReset={allowDefaultReset}
        disabled={disabled}
        active={active}
        onSelect={onSelect}
      />,
    ));
  };
  const expand = async () => { await act(async () => trigger().click()); };
  const choose = async (value: string) => { await act(async () => option(value).click()); };
  const hover = async (value: string) => {
    await act(async () => option(value).dispatchEvent(new Event('pointerover', { bubbles: true })));
  };
  const key = async (value: string) => {
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true,
    })));
  };

  beforeEach(() => {
    onSelect.mockReset().mockResolvedValue(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('leaves the entire background non-interactive and expands only advertised choices in place', async () => {
    await render([preset('medium'), preset('xhigh')]);
    expect(container.querySelector('input[type="range"]')).toBeNull();
    const sky = container.querySelector<HTMLElement>('[data-openbitfun-part="reasoningSliderSky"]')!;
    await act(async () => {
      sky.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      sky.dispatchEvent(new Event('pointerup', { bubbles: true }));
      sky.click();
    });
    expect(onSelect).not.toHaveBeenCalled();
    await expand();
    expect(Array.from(choices()!.querySelectorAll('button')).map(button => button.dataset.openbitfunValue))
      .toEqual(['auto', 'preset:medium', 'preset:xhigh']);
    expect(document.activeElement).toBe(option('preset:medium'));
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it('saves once, collapses after success and restores the summary focus', async () => {
    await render();
    await expand();
    await choose('preset:high');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('high');
    expect(choices()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('retains closing choices as inert content and reverses an interrupted collapse', async () => {
    await render();
    await expand();
    const panel = choices()!;
    const high = option('preset:high');

    await key('Escape');
    expect(choices()).toBeNull();
    expect(panel.isConnected).toBe(true);
    expect(panel.closest('[inert]')?.getAttribute('aria-hidden')).toBe('true');
    expect(high.disabled).toBe(true);
    expect(document.activeElement).toBe(trigger());
    await act(async () => high.click());
    expect(onSelect).not.toHaveBeenCalled();

    await expand();
    expect(choices()).toBe(panel);
    expect(high.disabled).toBe(false);
    expect(document.activeElement).toBe(option('preset:medium'));

    await key('Escape');
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 250)); });
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('previews the hovered level without selecting it and restores the saved sky on leave', async () => {
    await render();
    await expand();
    await hover('preset:xhigh');
    expect(control().dataset.intensity).toBe('4');
    expect(option('preset:medium').getAttribute('aria-pressed')).toBe('true');
    expect(option('preset:xhigh').getAttribute('aria-pressed')).toBe('false');
    await hover('preset:off');
    expect(control().dataset.reasoningState).toBe('off');
    expect(control().querySelector('.openbitfun-reasoning-control__nebula')).not.toBeNull();
    expect(control().querySelector('.openbitfun-reasoning-control__stars')).toBeNull();
    await hover('auto');
    expect(control().dataset.reasoningState).toBe('auto');
    expect(control().querySelector('.openbitfun-reasoning-control__stars')).not.toBeNull();
    await act(async () => option('auto').dispatchEvent(new MouseEvent('pointerout', {
      bubbles: true, relatedTarget: container,
    })));
    expect(control().dataset.reasoningState).toBe('manual');
    expect(control().dataset.intensity).toBe('2');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('retains nebula without stars for a saved Off choice, including provider toggle aliases', async () => {
    const off = { ...preset('off'), id: 'effort-off' };
    await render([off, preset('on')], 'effort-off');
    expect(control().dataset.reasoningState).toBe('off');
    expect(control().querySelector('.openbitfun-reasoning-control__field')).not.toBeNull();
    expect(control().querySelector('.openbitfun-reasoning-control__nebula')).not.toBeNull();
    expect(control().querySelector('.openbitfun-reasoning-control__stars')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('omits unsupported levels and reserves the peak for the highest available choice', async () => {
    await render([preset('medium'), preset('high')]);
    await expand();
    expect(option('unavailable:xhigh')).toBeUndefined();
    expect(option('preset:xhigh')).toBeUndefined();
    expect(option('preset:off')).toBeUndefined();
    expect(control().dataset.intensity).toBe('1');
    await key('End');
    expect(document.activeElement).toBe(option('preset:high'));
    expect(control().dataset.intensity).toBe('4');
    expect(onSelect).not.toHaveBeenCalled();
    expect(choices()).not.toBeNull();
  });

  it('uses the provider Extra High id when supported and keeps Maximum distinct', async () => {
    const xhigh = { ...preset('xhigh'), id: 'effort-xhigh' };
    await render([preset('medium'), preset('max'), xhigh]);
    await expand();
    expect(option('unavailable:xhigh')).toBeUndefined();
    expect(option('preset:effort-xhigh').disabled).toBe(false);
    await hover('preset:max');
    expect(control().dataset.intensity).toBe('4');
    await choose('preset:effort-xhigh');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('effort-xhigh');
    await render([preset('medium'), preset('max')]);
    await expand();
    expect(option('preset:max').disabled).toBe(false);
    expect(option('unavailable:xhigh')).toBeUndefined();
  });

  it('retains the choices while saving and after failure so the same choice can be retried', async () => {
    let finish!: (saved: boolean) => void;
    onSelect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render();
    await expand();
    await choose('preset:high');
    expect(Array.from(choices()!.querySelectorAll('button')).every(button => button.disabled)).toBe(true);
    await choose('preset:high');
    expect(onSelect).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(choices()).not.toBeNull();
    expect(document.activeElement).toBe(option('preset:high'));
    await choose('preset:high');
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(choices()).toBeNull();
  });

  it('moves focus horizontally without saving and cancels locally with Escape', async () => {
    await render([preset('medium'), preset('xhigh')]);
    await expand();
    await key('ArrowRight');
    expect(document.activeElement).toBe(option('preset:xhigh'));
    expect(control().dataset.intensity).toBe('4');
    await key('Home');
    expect(document.activeElement).toBe(option('auto'));
    expect(control().dataset.reasoningState).toBe('auto');
    expect(onSelect).not.toHaveBeenCalled();
    await key('Escape');
    expect(choices()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(control().dataset.intensity).toBe('1');
  });

  it('folds enable into Auto for toggle-only models and preserves the enable request', async () => {
    const off = { ...preset('off'), id: 'effort-off' };
    const on: ReasoningPresetDescriptor = { ...preset('on'), actions: [{ type: 'toggle', enabled: true }] };
    await render([off, on], 'on');
    await expand();
    expect(option('preset:on')).toBeUndefined();
    expect(option('auto').textContent).toBe('reasoningSelector.auto');
    await choose('preset:effort-off');
    expect(onSelect).toHaveBeenLastCalledWith('effort-off');
    await render([off, on], 'effort-off');
    await expand();
    await choose('auto');
    expect(onSelect).toHaveBeenLastCalledWith('on');
  });

  it('offers authored presets and ACP Auto as advertised without introducing a reset choice', async () => {
    const custom: ReasoningPresetDescriptor = { ...preset('custom'), label: 'Deep analysis', source: 'model_config' };
    await render([preset('auto'), custom], 'custom', false);
    await expand();
    expect(option('auto').textContent).toBe('reasoningSelector.auto');
    expect(option('preset:auto')).toBeUndefined();
    expect(option('preset:custom').textContent).toBe('Deep analysis');
    await choose('auto');
    expect(onSelect).toHaveBeenLastCalledWith('auto');
  });

  it('respects disabled controls and clears expansion when the containing card closes', async () => {
    await render(allPresets, 'medium', true, true);
    await expand();
    expect(choices()).toBeNull();
    await render();
    await expand();
    await render(allPresets, 'medium', true, false, false);
    expect(choices()).toBeNull();
    await render();
    expect(choices()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps five real effort choices and reserves the fourth material for Maximum', async () => {
    await render(['low', 'medium', 'high', 'xhigh', 'max'].map(preset), 'medium');
    await expand();
    expect(Array.from(choices()!.querySelectorAll('button')).map(button => button.dataset.openbitfunValue))
      .toEqual(['auto', 'preset:low', 'preset:medium', 'preset:high', 'preset:xhigh', 'preset:max']);
    expect(choices()!.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(option('preset:medium').getAttribute('aria-pressed')).toBe('true');
    expect(option('auto').getAttribute('aria-pressed')).toBe('false');
    await hover('preset:high');
    expect(control().dataset.intensity).toBe('3');
    await hover('preset:xhigh');
    expect(control().dataset.intensity).toBe('3');
    await hover('preset:max');
    expect(control().dataset.intensity).toBe('4');
    await choose('preset:xhigh');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('xhigh');
  });
});
