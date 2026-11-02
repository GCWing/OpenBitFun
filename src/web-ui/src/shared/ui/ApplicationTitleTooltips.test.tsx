// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider, IconButton, OverflowText, Portal, Tooltip } from '@openbitfun/ui';
import { AgentControlToolCard } from '@openbitfun/ui/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('application-only title tooltips', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = (children: React.ReactNode, enabled = true) => act(() => root.render(
    <React.StrictMode><DesignSystemProvider nativeTooltipPolicy={enabled ? 'application' : 'native'}>
      {children}
    </DesignSystemProvider></React.StrictMode>,
  ));
  const enter = (element: Element, relatedTarget: EventTarget | null = null) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }));
  });
  const leave = (element: Element) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  const reveal = () => {
    act(() => vi.advanceTimersByTime(500));
    act(() => vi.advanceTimersByTime(30));
  };
  const popup = () => document.querySelector('[role="tooltip"]');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(element => element.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses the authored tooltip and preserves the capsule click without any native title', () => {
    const onOpen = vi.fn();
    render(<AgentControlToolCard agentName="Reviewer" summary="Check the parser" status="running"
      statusLabel="Running" openAgentLabel="Open in side pane" onOpenAgent={onOpen} />);
    const button = host.querySelector('button')!;
    enter(button);
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup()?.textContent).toBe('Check the parser · Running · Open in side pane');
    expect(host.querySelector('[title]')).toBeNull();
    expect(button.getAttribute('aria-label')).toContain('Open in side pane');
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();
  });

  it('routes a legacy title through the shared popup and restores attributes on leave', () => {
    render(<button title="Refresh remote files"><span>Refresh</span></button>);
    const button = host.querySelector('button')!;
    const label = button.querySelector('span')!;
    enter(label);
    expect(button.title).toBe('');
    expect(button.getAttribute('aria-description')).toBe('Refresh remote files');
    reveal();
    expect(popup()?.textContent).toBe('Refresh remote files');
    leave(label);
    expect(button.title).toBe('Refresh remote files');
    expect(button.hasAttribute('aria-description')).toBe(false);
    expect(popup()).toBeNull();
  });

  it('keeps title-only icon names during focus and dismisses with Escape', () => {
    render(<button title="Open workspace"><svg aria-hidden="true" /></button>);
    const button = host.querySelector('button')!;
    act(() => button.focus());
    expect(button.title).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Open workspace');
    reveal();
    expect(popup()?.textContent).toBe('Open workspace');
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    reveal();
    expect(popup()).toBeNull();
    act(() => button.blur());
    expect(button.title).toBe('Open workspace');
    expect(button.hasAttribute('aria-label')).toBe(false);
  });

  it('yields to existing tooltips on shared controls and suppresses inherited native titles', () => {
    render(<div title="Ancestor hint"><Tooltip content="Application hint">
      <IconButton title="Legacy hint" aria-label="Stable name" icon={<span>+</span>} />
    </Tooltip></div>);
    const button = host.querySelector('button')!;
    enter(button);
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup()?.textContent).toBe('Application hint');
    expect(button.title).toBe('');
    expect(host.firstElementChild?.getAttribute('title')).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Stable name');
  });

  it('follows keyboard focus when the pointer remains over another control', () => {
    render(<><button title="First hint">First</button><button title="Second hint">Second</button></>);
    const [first, second] = host.querySelectorAll('button');
    enter(first);
    reveal();
    expect(popup()?.textContent).toBe('First hint');
    act(() => second.focus());
    reveal();
    expect(popup()?.textContent).toBe('Second hint');
    leave(first);
    expect(popup()?.textContent).toBe('Second hint');
    act(() => second.blur());
    expect(popup()).toBeNull();
  });

  it('yields to an external-ref tooltip and honors its disabled state', () => {
    function Content({ disabled }: { disabled: boolean }) {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return <><button ref={triggerRef} title="Legacy">Action</button>
        <Tooltip content="Authored" trigger="hover-focus" triggerRef={triggerRef} disabled={disabled} /></>;
    }
    render(<Content disabled={false} />);
    const button = host.querySelector('button')!;
    enter(button);
    act(() => button.dispatchEvent(new MouseEvent('mouseenter')));
    reveal();
    expect(popup()?.textContent).toBe('Authored');
    render(<Content disabled />);
    reveal();
    expect(popup()).toBeNull();
    expect(button.title).toBe('');
  });

  it('preserves the accessible name of a title-only trigger inside an authored tooltip', () => {
    render(<Tooltip content="Open application settings">
      <button title="Settings"><svg aria-hidden="true" /></button>
    </Tooltip>);
    const button = host.querySelector('button')!;
    enter(button);
    reveal();
    expect(button.title).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Settings');
    expect(popup()?.textContent).toBe('Open application settings');
    leave(button);
    expect(button.title).toBe('Settings');
    expect(button.hasAttribute('aria-label')).toBe(false);
  });

  it('tracks consumer title updates and removal while the pointer remains still', async () => {
    render(<button title="Starting">Status</button>);
    const button = host.querySelector('button')!;
    enter(button);
    reveal();
    await act(async () => { render(<button title="Completed">Status</button>); });
    expect(host.querySelector('button')).toBe(button);
    expect(button.title).toBe('');
    expect(popup()?.textContent).toBe('Completed');
    await act(async () => { button.title = 'Updated while hovered'; });
    expect(button.title).toBe('');
    expect(popup()?.textContent).toBe('Updated while hovered');
    await act(async () => { render(<button>Status</button>); });
    expect(button.hasAttribute('title')).toBe(false);
    expect(popup()).toBeNull();
    leave(button);
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('honors empty child titles and restores only the current title on policy cleanup', async () => {
    render(<div title="Parent"><button title="">No hint</button><button title="Original">Hint</button></div>);
    const [empty, titled] = host.querySelectorAll('button');
    enter(empty);
    reveal();
    expect(popup()).toBeNull();
    leave(empty);
    enter(titled);
    await act(async () => { titled.title = 'Current'; });
    reveal();
    expect(popup()?.textContent).toBe('Current');
    render(<div title="Parent"><button title="">No hint</button><button title="Original">Hint</button></div>, false);
    expect(titled.title).toBe('Current');
  });

  it('covers portals under nested providers without duplicate popups', () => {
    render(<DesignSystemProvider nativeTooltipPolicy="application"><Portal>
      <button title="Portalled action" data-test="portalled">Action</button>
    </Portal></DesignSystemProvider>);
    const button = document.querySelector<HTMLButtonElement>('[data-test="portalled"]')!;
    enter(button);
    reveal();
    expect(button.title).toBe('');
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup()?.textContent).toBe('Portalled action');
  });

  it('keeps document, iframe, and SVG names intact', () => {
    document.title = 'OpenBitFun';
    render(<><iframe title="Widget preview" /><svg aria-labelledby="diagram-title">
      <title id="diagram-title">Diagram</title>
    </svg></>);
    const frame = host.querySelector('iframe')!;
    enter(frame);
    reveal();
    expect(frame.title).toBe('Widget preview');
    expect(document.title).toBe('OpenBitFun');
    expect(host.querySelector('svg title')?.textContent).toBe('Diagram');
    expect(popup()).toBeNull();
  });

  it('shows explicit OverflowText hints even when text fits, without a native title', () => {
    render(<OverflowText title="Complete path">file.ts</OverflowText>);
    const label = host.querySelector('[data-overflow]')!;
    enter(label);
    act(() => label.dispatchEvent(new MouseEvent('mouseenter')));
    reveal();
    expect(host.querySelector('[title]')).toBeNull();
    expect(popup()?.textContent).toBe('Complete path');
    render(<OverflowText title="Renamed path">file.ts</OverflowText>);
    expect(popup()?.textContent).toBe('Renamed path');
  });
});
