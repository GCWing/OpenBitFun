// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settingsStore';
import { useSettingsSectionAnchor } from './useSettingsSectionAnchor';

afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsStore.setState(useSettingsStore.getInitialState());
});

it('aligns a deep link after sibling loads and yields scroll control on user interaction', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnect(); }
  });
  const scroll = vi.fn();
  function Section() {
    const id = useSettingsSectionAnchor('shortcuts');
    return <div id={id} ref={element => { if (element) element.scrollIntoView = scroll; }} />;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  useSettingsStore.getState().openDestination({ pageId: 'application.input', sectionId: 'shortcuts' });
  try {
    act(() => root.render(<div className="openbitfun-config-page-layout"><div className="openbitfun-config-page-content__inner"><Section /></div></div>));
    expect(scroll).toHaveBeenCalledTimes(1);
    resize();
    expect(scroll).toHaveBeenCalledTimes(2);
    container.querySelector('.openbitfun-config-page-layout')!.dispatchEvent(new Event('wheel'));
    resize();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
    act(() => useSettingsStore.getState().openDestination({ pageId: 'application.input', sectionId: 'shortcuts' }));
    expect(scroll).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
