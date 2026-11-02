// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCompanionActivityPayload, AgentCompanionTaskStatus } from '@/flow_chat/utils/agentCompanionActivity';
import { AgentCompanionDesktopPet } from './AgentCompanionDesktopPet';

const emitMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const listenMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const cursorPositionMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ x: 0, y: 0 })));
const startDraggingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const controlledDragMock = vi.hoisted(() => vi.fn());
const pointerDrag = vi.hoisted(() => ({ prepare: vi.fn(), move: vi.fn(), finish: vi.fn(), cancel: vi.fn() }));
vi.mock('@/infrastructure/config/services/AgentCompanionDragService', () => ({ startAgentCompanionDrag: controlledDragMock }));
vi.mock('@/infrastructure/config/services/AgentCompanionPointerDragService', () => ({ prepareAgentCompanionPointerDrag: pointerDrag.prepare }));

vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: listenMock,
}));

// Mock the component's API boundary before ApiClient initializes a transport.
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { invoke: invokeMock },
}));

vi.mock('@tauri-apps/api/window', () => ({
  cursorPosition: cursorPositionMock,
  getCurrentWindow: () => ({
    hide: vi.fn(() => Promise.resolve()),
    setFocus: vi.fn(() => Promise.resolve()),
    startDragging: startDraggingMock,
    outerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    scaleFactor: vi.fn(() => Promise.resolve(1)),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
    onScaleChanged: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  aiExperienceConfigService: {
    getSettings: () => ({ agent_companion_pet: null }),
    getSettingsAsync: () => Promise.resolve({
      enable_agent_companion: true,
      agent_companion_pet: null,
    }),
  },
}));

vi.mock('@/flow_chat/components/AgentCompanionPet', () => ({
  AgentCompanionPet: ({ lookDirection, action, mood, dragDirection }: { lookDirection?: number | null; action?: string | null; mood?: string; dragDirection?: string }) => (
    <div data-testid="pixel-pet" data-look-direction={lookDirection ?? 'none'} data-action={action ?? 'none'} data-mood={mood} data-direction={dragDirection} />
  ),
}));

const PET_COMMAND_EVENT = 'agent-companion://pet-command';
const ACTIVITY_EVENT = 'agent-companion://activity-updated';
const MAIN_WINDOW_STATE_EVENT = 'agent-companion://main-window-state';

let i18n: I18nInstance;

function task(overrides: Partial<AgentCompanionTaskStatus> = {}): AgentCompanionTaskStatus {
  return {
    sessionId: 'session-1',
    title: 'Refactor login',
    mood: 'working',
    state: 'running',
    labelKey: 'agentCompanion.activity.working',
    defaultLabel: 'Working',
    startedAt: 1,
    updatedAt: 2,
    canReply: true,
    ...overrides,
  };
}

/**
 * React caches the last value it saw on the element instance, so assigning
 * `input.value` directly is invisible to `onChange`. Going through the prototype
 * setter bypasses that cache and makes the input event look like real typing.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    nativeValueSetter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

beforeAll(async () => {
  i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: {
      'en-US': {
        'flow-chat': {
          agentCompanion: {
            activity: { working: 'Working', completed: 'Completed' },
            menu: {
              switchPet: 'Switch pet',
              closePet: 'Close pet',
              closeBubble: 'Close this bubble',
            },
            composer: {
              openTitle: 'Send a message to this session',
              ariaLabel: 'Send a message to this session',
              placeholder: 'Type a message, Enter to send',
              cancel: 'Cancel',
              send: 'Send',
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

describe('AgentCompanionDesktopPet', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pushActivity: (payload: AgentCompanionActivityPayload) => void;
  let pushMainWindowFocus: (focused: boolean) => void;

  const query = <T extends Element>(selector: string): T | null =>
    container.querySelector<T>(selector);

  const dispatch = (element: Element, type: string, at?: { clientX: number; clientY: number }) => {
    act(() => {
      element.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        screenX: at?.clientX,
        screenY: at?.clientY,
        ...at,
      }));
    });
  };

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    emitMock.mockClear();
    invokeMock.mockClear();
    cursorPositionMock.mockReset();
    cursorPositionMock.mockResolvedValue({ x: 0, y: 0 });
    startDraggingMock.mockReset();
    startDraggingMock.mockResolvedValue(undefined);
    controlledDragMock.mockReset();
    pointerDrag.prepare.mockReset().mockReturnValue(pointerDrag);
    pointerDrag.move.mockReset(); pointerDrag.finish.mockReset(); pointerDrag.cancel.mockReset();
    listenMock.mockReset();

    const activityListeners: Array<(event: { payload: AgentCompanionActivityPayload }) => void> = [];
    const focusListeners: Array<(event: { payload: { focused: boolean } }) => void> = [];
    listenMock.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      if (eventName === ACTIVITY_EVENT) {
        activityListeners.push(handler as (event: { payload: AgentCompanionActivityPayload }) => void);
      } else if (eventName === MAIN_WINDOW_STATE_EVENT) {
        focusListeners.push(handler as (event: { payload: { focused: boolean } }) => void);
      }
      return Promise.resolve(() => {});
    });
    pushActivity = payload => {
      act(() => {
        activityListeners.forEach(handler => handler({ payload }));
      });
    };
    pushMainWindowFocus = focused => {
      act(() => {
        focusListeners.forEach(handler => handler({ payload: { focused } }));
      });
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nextProvider i18n={i18n}>
          <AgentCompanionDesktopPet />
        </I18nextProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['before activity', 'after activity'])(
    'shows a new task without dragging when the main window gains focus %s',
    focusOrder => {
      if (focusOrder === 'before activity') pushMainWindowFocus(true);
      pushActivity({ mood: 'working', tasks: [task()], emittedAt: 1, sequence: 1 });
      if (focusOrder === 'after activity') pushMainWindowFocus(true);

      const bubble = query('.openbitfun-agent-companion-window__bubble');
      expect(bubble).not.toBeNull();
      expect(bubble?.textContent).toContain('Refactor login');
      expect(invokeMock).toHaveBeenLastCalledWith('resize_agent_companion_desktop_pet', {
        width: 288,
        height: 102,
      });
      expect(startDraggingMock).not.toHaveBeenCalled();
      expect(controlledDragMock).not.toHaveBeenCalled();

      pushMainWindowFocus(false);
      pushMainWindowFocus(true);
      pushActivity({
        mood: 'working', tasks: [task({ latestOutput: 'Still working' })], emittedAt: 2, sequence: 2,
      });
      expect(query('.openbitfun-agent-companion-window__bubble-output')?.textContent).toContain('Still workin');
    },
  );

  it('preserves manual dismissal while the main window is focused and restores an attention bubble', () => {
    pushMainWindowFocus(true);
    pushActivity({ mood: 'working', tasks: [task()], emittedAt: 1, sequence: 1 });
    const bubble = query('.openbitfun-agent-companion-window__bubble-shell');
    expect(bubble).not.toBeNull();
    dispatch(bubble!, 'contextmenu');
    const closeButton = query('[data-openbitfun-menu-item]');
    expect(closeButton?.textContent).toBe('Close this bubble');
    dispatch(closeButton!, 'click');
    expect(query('.openbitfun-agent-companion-window__bubble')).toBeNull();

    pushMainWindowFocus(false);
    pushMainWindowFocus(true);
    pushActivity({ mood: 'working', tasks: [task()], emittedAt: 2, sequence: 2 });
    expect(query('.openbitfun-agent-companion-window__bubble')).toBeNull();

    pushActivity({
      mood: 'waiting', tasks: [task({ state: 'attention', mood: 'waiting' })], emittedAt: 3, sequence: 3,
    });
    expect(query('.openbitfun-agent-companion-window__bubble--attention')).not.toBeNull();
  });

  it('provides the off-window pointer direction to v2 only while idle', async () => {
    vi.useFakeTimers();
    cursorPositionMock.mockResolvedValue({ x: 0, y: 100 });
    const settingsListener = listenMock.mock.calls.find(([name]) => name === 'agent-companion://settings-updated')?.[1];
    expect(settingsListener).toBeDefined();
    await act(async () => settingsListener({ payload: {
      enable_agent_companion: true,
      agent_companion_pet: {
        id: 'sample', displayName: 'Sample', source: 'user', packagePath: '/pets/sample',
        spritesheetPath: '/pets/sample/spritesheet.webp', spritesheetMimeType: 'image/webp', spriteVersionNumber: 2,
      },
    } }));
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-look-direction')).toBe('8');
    await act(async () => vi.advanceTimersByTimeAsync(1080));
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-look-direction')).toBe('none');
    cursorPositionMock.mockResolvedValue({ x: 100, y: 0 });
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-look-direction')).toBe('4');
    pushActivity({ mood: 'working', tasks: [task()], emittedAt: 1, sequence: 1 });
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-look-direction')).toBe('none');
  });

  it('celebrates only fresh completions and distinguishes errors from interruption', () => {
    vi.useFakeTimers();
    const action = () => query('[data-testid="pixel-pet"]')?.getAttribute('data-action');
    const publish = (state: AgentCompanionTaskStatus['state'], sequence: number) => pushActivity({
      mood: state === 'running' ? 'working' : 'rest',
      tasks: [task({ state, updatedAt: sequence })], emittedAt: sequence, sequence,
    });
    publish('completed', 1);
    expect(action()).toBe('none');
    publish('running', 2);
    expect(action()).toBe('jumping');
    publish('completed', 3);
    expect(action()).toBe('waving');
    act(() => vi.advanceTimersByTime(1200));
    expect(action()).toBe('none');
    publish('completed', 4);
    expect(action()).toBe('none');
    publish('error', 5);
    expect(action()).toBe('failed');
    publish('interrupted', 6);
    expect(action()).toBe('none');
    vi.useRealTimers();
  });

  it('does not restart a request reaction on repeated activity snapshots', () => {
    vi.useFakeTimers();
    pushActivity({ mood: 'rest', tasks: [], emittedAt: 1, sequence: 1 });
    pushActivity({ mood: 'working', tasks: [task()], emittedAt: 2, sequence: 2 });
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('jumping');
    act(() => vi.advanceTimersByTime(1200));
    pushActivity({ mood: 'waiting', tasks: [task({ state: 'waiting' })], emittedAt: 3, sequence: 3 });
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('none');
  });

  it.each([-20, 20])('selects the initial drag direction and waves after release (%s)', async dx => {
    let finish!: () => void;
    startDraggingMock.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const hitbox = query('.openbitfun-agent-companion-window__pet-hitbox')!;
    dispatch(hitbox, 'pointerdown', { clientX: 100, clientY: 100 });
    dispatch(hitbox, 'pointermove', { clientX: 100 + dx, clientY: 100 });
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).toBe('dragging');
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-direction')).toBe(dx < 0 ? 'left' : 'right');
    dispatch(hitbox, 'pointerup', { clientX: 100 + dx, clientY: 100 });
    expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('waving');
    await act(async () => finish());
  });

  it('keeps Windows dragging active until pointer release and cancels without waving', async () => {
    const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows');
    const stop = vi.fn();
    controlledDragMock.mockReturnValue(stop);
    try {
      vi.resetModules();
      const { AgentCompanionDesktopPet: PlatformPet } = await import('./AgentCompanionDesktopPet');
      await act(async () => root.render(<I18nextProvider i18n={i18n}><PlatformPet /></I18nextProvider>));
      const hitbox = query('.openbitfun-agent-companion-window__pet-hitbox')!;
      dispatch(hitbox, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(hitbox, 'pointermove', { clientX: 120, clientY: 100 });
      expect(controlledDragMock).toHaveBeenCalledTimes(1);
      expect(startDraggingMock).not.toHaveBeenCalled();
      await act(async () => Promise.resolve());
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).toBe('dragging');
      act(() => controlledDragMock.mock.calls[0][0]('left'));
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-direction')).toBe('left');
      act(() => controlledDragMock.mock.calls[0][0]('right'));
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-direction')).toBe('right');
      dispatch(hitbox, 'pointerup', { clientX: 120, clientY: 100 });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('waving');
      dispatch(hitbox, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(hitbox, 'pointermove', { clientX: 120, clientY: 100 });
      dispatch(hitbox, 'pointercancel');
      expect(stop).toHaveBeenCalledTimes(2);
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('none');
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).not.toBe('dragging');

      dispatch(hitbox, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(hitbox, 'pointermove', { clientX: 80, clientY: 100 });
      dispatch(hitbox, 'lostpointercapture');
      expect(stop).toHaveBeenCalledTimes(3);
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).not.toBe('dragging');
    } finally {
      userAgent.mockRestore();
    }
  });

  it('uses captured screen coordinates on macOS and prevents native text selection at pointer-down', async () => {
    const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh; Intel Mac OS X 10_15_7');
    try {
      vi.resetModules();
      const { AgentCompanionDesktopPet: MacPet } = await import('./AgentCompanionDesktopPet');
      await act(async () => root.render(<I18nextProvider i18n={i18n}><MacPet /></I18nextProvider>));
      const hitbox = query('.openbitfun-agent-companion-window__pet-hitbox')!;
      const down = new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 100, clientY: 100, screenX: 100, screenY: 100,
      });
      act(() => hitbox.dispatchEvent(down));
      expect(down.defaultPrevented).toBe(true);
      expect(pointerDrag.prepare).toHaveBeenCalledWith({ x: 100, y: 100 }, expect.any(Function), expect.any(Function));
      dispatch(hitbox, 'pointermove', { clientX: 120, clientY: 100 });
      await act(async () => Promise.resolve());
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).toBe('dragging');
      expect(pointerDrag.move).toHaveBeenLastCalledWith({ x: 120, y: 100 });
      expect(startDraggingMock).not.toHaveBeenCalled();
      expect(controlledDragMock).not.toHaveBeenCalled();
      act(() => pointerDrag.prepare.mock.calls[0][1]('left'));
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-direction')).toBe('left');
      dispatch(hitbox, 'pointermove', { clientX: 80, clientY: 100 });
      expect(pointerDrag.move).toHaveBeenLastCalledWith({ x: 80, y: 100 });
      dispatch(hitbox, 'pointerup', { clientX: 70, clientY: 100 });
      expect(pointerDrag.move).toHaveBeenLastCalledWith({ x: 70, y: 100 });
      expect(pointerDrag.finish).toHaveBeenCalledTimes(1);
      expect(pointerDrag.cancel).not.toHaveBeenCalled();
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-action')).toBe('waving');
      dispatch(hitbox, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(hitbox, 'pointermove', { clientX: 120, clientY: 100 });
      dispatch(hitbox, 'lostpointercapture');
      expect(pointerDrag.cancel).toHaveBeenCalledTimes(1);
      expect(query('[data-testid="pixel-pet"]')?.getAttribute('data-mood')).not.toBe('dragging');
    } finally { userAgent.mockRestore(); }
  });

  it('closes the desktop pet from the pet context menu', () => {
    const hitbox = query('.openbitfun-agent-companion-window__pet-hitbox');
    expect(hitbox).not.toBeNull();

    dispatch(hitbox!, 'contextmenu', { clientX: 300, clientY: 200 });

    const menuItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-menu-item]'),
    ).find(item => item.textContent === 'Close pet');
    expect(menuItem?.textContent).toBe('Close pet');

    act(() => {
      menuItem!.click();
    });

    expect(emitMock).toHaveBeenCalledWith(PET_COMMAND_EVENT, { type: 'close-desktop-pet' });
    expect(query('[data-openbitfun-menu-item]')).toBeNull();
  });

  it('opens the pet settings from the pet context menu', () => {
    dispatch(query('.openbitfun-agent-companion-window__pet-hitbox')!, 'contextmenu', {
      clientX: 300,
      clientY: 200,
    });

    const menuItems = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-menu-item]'),
    );
    expect(menuItems.map(item => item.textContent)).toEqual(['Switch pet', 'Close pet']);

    act(() => {
      menuItems[0]!.click();
    });

    expect(emitMock).toHaveBeenCalledWith(PET_COMMAND_EVENT, { type: 'open-pet-settings' });
    expect(query('[data-openbitfun-menu-item]')).toBeNull();
  });

  it('anchors the context menu to the cursor position', () => {
    dispatch(query('.openbitfun-agent-companion-window__pet-hitbox')!, 'contextmenu', {
      clientX: 300,
      clientY: 200,
    });

    const menu = query<HTMLDivElement>('.openbitfun-agent-companion-window__overlay--anchored');
    expect(menu).not.toBeNull();
    // The anchor is measured from the bottom-right corner, which the host keeps
    // fixed while the window grows for the menu.
    expect(menu!.style.right).toBe(`${window.innerWidth - 300}px`);
    expect(menu!.style.bottom).toBe(`${window.innerHeight - 200}px`);
    expect(menu!.style.visibility).toBe('visible');
  });

  it('re-requests the dock size when the host leaves the viewport too narrow', async () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenLastCalledWith('resize_agent_companion_desktop_pet', {
      width: 288,
      height: 102,
    });
    invokeMock.mockClear();

    // A full-size viewport needs nothing more.
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(invokeMock).not.toHaveBeenCalledWith('resize_agent_companion_desktop_pet', expect.anything());

    // The bottom-right anchored dock would be clipped on the left at this width.
    vi.stubGlobal('innerWidth', 96);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(invokeMock).toHaveBeenLastCalledWith('resize_agent_companion_desktop_pet', {
      width: 288,
      height: 102,
    });
  });

  it('does not resize the window for a context menu', async () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });
    // Let the bubble's own resize request settle before watching for new ones.
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      'resize_agent_companion_desktop_pet',
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    );
    invokeMock.mockClear();

    dispatch(query('.openbitfun-agent-companion-window__bubble-shell')!, 'contextmenu');
    dispatch(query('.openbitfun-agent-companion-window__pet-hitbox')!, 'contextmenu');
    await act(async () => {
      await Promise.resolve();
    });

    // Resizing moves every bottom-right anchored element for a frame, which
    // reads as the pet and bubbles flashing.
    expect(invokeMock).not.toHaveBeenCalledWith(
      'resize_agent_companion_desktop_pet',
      expect.anything(),
    );
  });

  it('sends a message from the bubble composer', async () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });

    const composeButton = query<HTMLButtonElement>('.openbitfun-agent-companion-window__bubble-compose');
    expect(composeButton).not.toBeNull();

    act(() => {
      composeButton!.click();
    });

    // The input bar belongs to the bubble itself; no extra bubble or panel.
    expect(container.querySelectorAll('.openbitfun-agent-companion-window__bubble')).toHaveLength(1);
    const input = query<HTMLInputElement>('.openbitfun-agent-companion-window__bubble .openbitfun-agent-companion-window__bubble-composer-input');
    expect(input).not.toBeNull();
    expect(query('.openbitfun-agent-companion-window__bubble--composing')).not.toBeNull();
    expect(query('.openbitfun-agent-companion-window__bubble-compose')).toBeNull();

    typeInto(input!, '  ship it  ');
    act(() => {
      query<HTMLButtonElement>('.openbitfun-agent-companion-window__bubble-composer-send')!.click();
    });

    expect(emitMock).toHaveBeenCalledWith(PET_COMMAND_EVENT, {
      type: 'send-message',
      sessionId: 'session-1',
      message: 'ship it',
    });

    // The bar closes once the command has been handed to the main window.
    await act(async () => {
      await Promise.resolve();
    });
    expect(query('.openbitfun-agent-companion-window__bubble-composer-input')).toBeNull();
    expect(query('.openbitfun-agent-companion-window__bubble-compose')).not.toBeNull();
  });

  it('reveals the bubble entry from cursor polling before the pet window is clicked', async () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });

    const bubbleShell = query<HTMLElement>('.openbitfun-agent-companion-window__bubble-shell');
    expect(bubbleShell).not.toBeNull();
    vi.spyOn(bubbleShell!, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 110,
      bottom: 80,
      width: 100,
      height: 70,
      toJSON: () => ({}),
    });
    cursorPositionMock.mockResolvedValue({ x: 40, y: 40 });

    // No mouseover is dispatched: the transparent, inactive desktop window
    // must discover this hover through the same global cursor poll as the pet.
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 150));
    });

    expect(bubbleShell!.classList).toContain('openbitfun-agent-companion-window__bubble-shell--hovered');

    cursorPositionMock.mockResolvedValue({ x: 200, y: 200 });
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 150));
    });

    expect(bubbleShell!.classList).not.toContain('openbitfun-agent-companion-window__bubble-shell--hovered');
  });

  it('sends the composer message on Enter', () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });

    act(() => {
      query<HTMLButtonElement>('.openbitfun-agent-companion-window__bubble-compose')!.click();
    });
    const input = query<HTMLInputElement>('.openbitfun-agent-companion-window__bubble-composer-input')!;
    typeInto(input, 'run the tests');

    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(emitMock).toHaveBeenCalledWith(PET_COMMAND_EVENT, {
      type: 'send-message',
      sessionId: 'session-1',
      message: 'run the tests',
    });
  });

  it('cancels the bubble composer without sending its draft', () => {
    pushActivity({ mood: 'working', tasks: [task()], sequence: 1, emittedAt: 1 });

    act(() => {
      query<HTMLButtonElement>('.openbitfun-agent-companion-window__bubble-compose')!.click();
    });
    const input = query<HTMLInputElement>('.openbitfun-agent-companion-window__bubble-composer-input')!;
    typeInto(input, 'keep this draft local');

    act(() => {
      query<HTMLButtonElement>('.openbitfun-agent-companion-window__bubble-composer-cancel')!.click();
    });

    expect(query('.openbitfun-agent-companion-window__bubble-composer-input')).toBeNull();
    expect(query('.openbitfun-agent-companion-window__bubble-compose')).not.toBeNull();
    expect(emitMock).not.toHaveBeenCalledWith(
      PET_COMMAND_EVENT,
      expect.objectContaining({ type: 'send-message' }),
    );
  });

  it('hides the composer entry for sessions that cannot be replied to directly', () => {
    pushActivity({
      mood: 'working',
      tasks: [task({ canReply: false })],
      sequence: 1,
      emittedAt: 1,
    });

    expect(query('.openbitfun-agent-companion-window__bubble')).not.toBeNull();
    expect(query('.openbitfun-agent-companion-window__bubble-compose')).toBeNull();
  });

  it('closes a finished bubble and acknowledges it in the main window', () => {
    pushActivity({
      mood: 'rest',
      tasks: [task({ state: 'completed', labelKey: 'agentCompanion.activity.completed', defaultLabel: 'Completed' })],
      sequence: 1,
      emittedAt: 1,
    });

    dispatch(query('.openbitfun-agent-companion-window__bubble-shell')!, 'contextmenu');

    const menuItem = query<HTMLButtonElement>('[data-openbitfun-menu-item]');
    expect(menuItem?.textContent).toBe('Close this bubble');
    // The bubble menu shows the action only, not the session title.
    expect(query('.openbitfun-agent-companion-window__overlay--anchored .openbitfun-agent-companion-window__overlay-title')).toBeNull();

    act(() => {
      menuItem!.click();
    });

    expect(query('.openbitfun-agent-companion-window__bubble')).toBeNull();
    expect(emitMock).toHaveBeenCalledWith(PET_COMMAND_EVENT, {
      type: 'dismiss-task',
      sessionId: 'session-1',
    });
  });

  it('keeps a silenced running bubble hidden but restores it once the task needs attention', () => {
    const runningTask = task();
    pushActivity({ mood: 'working', tasks: [runningTask], sequence: 1, emittedAt: 1 });

    dispatch(query('.openbitfun-agent-companion-window__bubble-shell')!, 'contextmenu');
    act(() => {
      query<HTMLButtonElement>('[data-openbitfun-menu-item]')!.click();
    });

    expect(query('.openbitfun-agent-companion-window__bubble')).toBeNull();
    // A running bubble is not an unread notice, so nothing is acknowledged.
    expect(emitMock).not.toHaveBeenCalledWith(PET_COMMAND_EVENT, expect.objectContaining({
      type: 'dismiss-task',
    }));

    // Still running: stays silenced.
    pushActivity({
      mood: 'working',
      tasks: [task({ updatedAt: 3 })],
      sequence: 2,
      emittedAt: 2,
    });
    expect(query('.openbitfun-agent-companion-window__bubble')).toBeNull();

    pushActivity({
      mood: 'rest',
      tasks: [task({ state: 'completed', labelKey: 'agentCompanion.activity.completed', defaultLabel: 'Completed' })],
      sequence: 3,
      emittedAt: 3,
    });
    expect(query('.openbitfun-agent-companion-window__bubble')).not.toBeNull();
  });
});
