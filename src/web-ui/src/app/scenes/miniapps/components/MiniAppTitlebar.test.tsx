// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountTitlebar } from '../../../../../../shared/miniapp-chrome/titlebar';
import icons from '../../../../../../shared/miniapp-chrome/icons.generated.json';

const labels = { titlebar: 'Window controls', openTab: 'Return to app', minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' };
const mounted: { destroy(): void }[] = [];
afterEach(() => { mounted.forEach(bar => bar.destroy()); mounted.length = 0; document.body.replaceChildren(); });

function render(preview = false, platform: 'macos' | 'windows' | 'linux' = 'windows') {
  const element = document.createElement('header');
  document.body.append(element);
  const onAction = vi.fn(), onWindowAction = vi.fn(), onDrag = vi.fn();
  const bar = mountTitlebar(element, {
    chrome: { titlebar: { title: '<script>untrusted</script>', density: 'compact', controlsPosition: 'start', actions: [
      { id: 'export', label: 'Export', labels: { 'zh-CN': '导出' }, icon: 'download' },
    ] } },
    title: 'App', icon: 'Box', icons, locale: 'zh-CN', labels, platform, preview, onAction, onWindowAction, onDrag,
  });
  mounted.push(bar);
  return { element, bar, onAction, onWindowAction, onDrag };
}

describe('MiniApp shared titlebar', () => {
  it('renders app text safely and keeps app actions separate from window authority', () => {
    const { element, onAction, onWindowAction } = render();
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('<script>untrusted</script>');
    (element.querySelector('[aria-label="导出"]') as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith('export');
    expect(onWindowAction).not.toHaveBeenCalled();
    (element.querySelector('[data-window-action="tab"]') as HTMLButtonElement).click();
    expect(onWindowAction).toHaveBeenCalledExactlyOnceWith('tab');
    expect(element.querySelector('[data-window-action="tab"]')?.textContent).toBe('');
  });

  it('keeps controls usable while a transfer is pending and reflects native maximize state', () => {
    const { element, bar, onWindowAction } = render();
    bar.setTransferring(true);
    expect((element.querySelector('[data-window-action="tab"]') as HTMLButtonElement).disabled).toBe(true);
    (element.querySelector('[data-window-action="close"]') as HTMLButtonElement).click();
    expect(onWindowAction).toHaveBeenCalledExactlyOnceWith('close');
    bar.setMaximized(true);
    expect(element.querySelector('[data-window-action="maximize"]')?.getAttribute('aria-label')).toBe('Restore');
    bar.setTransferring(false);
    expect((element.querySelector('[data-window-action="tab"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves macOS traffic lights to AppKit and handles platform titlebar gestures', () => {
    const { element, bar, onWindowAction } = render(false, 'macos');
    expect(element.querySelector('.window-controls')).toBeNull();
    expect(element.querySelectorAll('[data-window-action]')).toHaveLength(1);
    expect(element.querySelector('[data-window-action="tab"]')).not.toBeNull();
    expect(() => bar.setMaximized(true)).not.toThrow();
    bar.setFullscreen(true);
    expect(element.dataset.fullscreen).toBe('true');
    element.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    expect(onWindowAction).toHaveBeenCalledExactlyOnceWith('titlebarDoubleClick');
  });

  it('uses main-window Windows captions at the right regardless of legacy control placement', () => {
    const { element, onWindowAction } = render();
    expect(element.dataset.controlsPosition).toBeUndefined();
    expect(element.lastElementChild?.classList.contains('window-controls--windows')).toBe(true);
    const captions = [...element.querySelectorAll('.window-controls__btn')];
    expect(captions.map(button => (button as HTMLElement).dataset.windowAction)).toEqual(['minimize', 'maximize', 'close']);
    expect(captions.some(button => button.classList.contains('miniapp-titlebar__button'))).toBe(false);
    element.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    expect(onWindowAction).toHaveBeenCalledExactlyOnceWith('maximize');
  });

  it('drags only noninteractive titlebar space and makes draft window controls inert', () => {
    const active = render();
    active.element.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    active.element.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(active.onDrag).toHaveBeenCalledTimes(1);
    const preview = render(true);
    preview.element.dispatchEvent(new MouseEvent('dblclick', { button: 0 }));
    preview.element.querySelectorAll('button').forEach(button => button.click());
    expect(preview.onWindowAction).not.toHaveBeenCalled();
    expect(preview.onAction).not.toHaveBeenCalled();
  });
});
