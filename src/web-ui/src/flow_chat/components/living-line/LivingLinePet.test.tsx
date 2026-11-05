// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivingLinePet, LIVING_LINE_FRAME_SIZE } from './LivingLinePet';
import { LivingLineEngine } from './engine';
import { DEFAULT_SETTINGS, LIVING_LINE_SETTINGS_KEY } from './settings';
import { saveLivingLineSettings } from './livingLineSettingsStore';

describe('LivingLine product settings integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextFrame: FrameRequestCallback;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  const cancelFrame = vi.fn();
  const onFrame = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    localStorage.clear();
    requestFrame.mockClear(); cancelFrame.mockClear(); onFrame.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hot-updates colors and widths without remounting the renderer or resetting its state', () => {
    const setState = vi.spyOn(LivingLineEngine.prototype, 'setState');
    act(() => root.render(<LivingLinePet state="working" mood="working" onFrameSizeChange={onFrame} />));
    const svg = container.querySelector('svg');
    const main = container.querySelector('.main-path')!;
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(LIVING_LINE_FRAME_SIZE);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);

    act(() => saveLivingLineSettings({ lineColor: '#123456', lineWidth: 4.5 }));
    expect(container.querySelector('svg')).toBe(svg);
    expect(container.querySelector('.main-path')).toBe(main);
    expect(main.getAttribute('stroke')).toBe('#123456');
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    act(() => { nextFrame(100); nextFrame(116); });
    expect((main as SVGElement).style.strokeWidth).toBe('4.5px');
  });

  it('restores defaults after cross-window removal or clear and cleans up on unmount', () => {
    saveLivingLineSettings({ lineColor: '#123456' });
    act(() => root.render(<LivingLinePet state="idle" mood="rest" onFrameSizeChange={onFrame} />));
    const svg = container.querySelector('svg');
    localStorage.removeItem(LIVING_LINE_SETTINGS_KEY);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LIVING_LINE_SETTINGS_KEY, newValue: null })));
    expect(container.querySelector('.main-path')?.getAttribute('stroke')).toBe(DEFAULT_SETTINGS.lineColor);
    act(() => saveLivingLineSettings({ lineColor: '#654321' }));
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(container.querySelector('svg')).toBe(svg);
    expect(container.querySelector('.main-path')?.getAttribute('stroke')).toBe(DEFAULT_SETTINGS.lineColor);
    act(() => root.render(null));
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(onFrame).toHaveBeenLastCalledWith(null);
  });
});
