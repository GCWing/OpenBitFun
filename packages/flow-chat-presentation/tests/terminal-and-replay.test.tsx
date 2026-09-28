import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalOutputRenderer, type TerminalOutputHost, type TerminalOutputRendererHandle } from '../src/terminal/TerminalOutputRenderer';
import { FlowChatScenarios } from '../../../design-system/apps/design-lab/src/preview/FlowChatScenarios';
import { FlowChatMockPage } from '../../../design-system/apps/design-lab/src/pages/FlowChatMockPage';
import { mockToolCoverage } from '../../../design-system/apps/design-lab/src/preview/FlowChatMockTools';
import { toolPresentationRegistry } from '../src/registry';
import { I18nContext } from '../../../design-system/apps/design-lab/src/i18n/I18nProvider';
import { messages } from '../../../design-system/apps/design-lab/src/i18n/messages';
import { translateFromCatalog } from '../../../design-system/apps/design-lab/src/i18n/core.mjs';

// Canvas/xterm is an external rendering boundary; keep the production React renderer,
// normalization, fallback, host lifecycle and the whole Lab replay tree intact.
const terminals = vi.hoisted(() => [] as Array<any>);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    text = '';
    rows = 4;
    dimensions = { css: { cell: { height: 17 } } };
    onFrame = () => {};
    dispose = vi.fn();
    write = vi.fn((text: string, callback?: () => void) => { this.text += text; callback?.(); });
    reset = vi.fn(() => { this.text = ''; });
    clear = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    refresh = () => this.onFrame();
    onRender(callback: () => void) { this.onFrame = callback; return { dispose: vi.fn() }; }
    get buffer() {
      const lines = this.text.split('\n');
      return { active: { viewportY: 0, baseY: 0, length: lines.length, getLine: (row: number) => ({ translateToString: () => lines[row] ?? '' }) } };
    }
    constructor(options: Record<string, unknown>) { this.options = options; terminals.push(this); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  terminals.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(['standalone', 'embedded'] as const)('the %s terminal view preserves output, surface colors and host bindings', (surface) => {
  container.style.color = 'rgb(120, 120, 120)';
  let updateTheme = () => {};
  const unsubscribe = vi.fn();
  const unregister = vi.fn();
  const host: TerminalOutputHost = {
    getColors: vi.fn(() => ({})),
    subscribe: (listener) => { updateTheme = listener; return unsubscribe; },
    registerActions: vi.fn(() => unregister),
  };
  const ref = createRef<TerminalOutputRendererHandle>();
  const render = (content: string) => act(() => root.render(<TerminalOutputRenderer ref={ref} host={host} content={content} maxRows={4} surface={surface} />));
  render('one\n');
  const terminal = terminals[0];
  expect(terminal.text).toBe('one');
  expect(terminal.options.allowTransparency).toBe(surface === 'embedded');
  expect(terminal.options.theme).toEqual(surface === 'embedded'
    ? { background: 'transparent', foreground: 'rgb(120, 120, 120)' } : {});
  render('one\ntwo\n');
  expect(terminals).toHaveLength(1);
  expect(terminal.write.mock.lastCall[0]).toBe('\ntwo');
  expect(ref.current?.getVisibleText()).toBe('one\ntwo');
  render('replaced\n');
  expect(terminal.text).toBe('replaced');
  container.querySelector<HTMLElement>('.terminal-output-renderer__xterm-host')!.style.color = 'rgb(90, 90, 90)';
  act(() => updateTheme());
  expect(host.getColors).toHaveBeenCalledTimes(3);
  expect(terminal.options.theme).toEqual(surface === 'embedded'
    ? { background: 'transparent', foreground: 'rgb(90, 90, 90)' } : {});
  act(() => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledOnce();
  expect(terminal.dispose).toHaveBeenCalledOnce();
});

it.each(['host', 'surface'] as const)('changing the terminal %s restores existing output and releases old bindings', (changed) => {
  const unsubscribe = vi.fn();
  const host: TerminalOutputHost = { getColors: () => ({}), subscribe: () => unsubscribe };
  const ref = createRef<TerminalOutputRendererHandle>();
  act(() => root.render(<TerminalOutputRenderer ref={ref} host={host} content="existing output" />));
  act(() => root.render(<TerminalOutputRenderer ref={ref}
    host={changed === 'host' ? { ...host } : host}
    surface={changed === 'surface' ? 'embedded' : 'standalone'}
    content="existing output" />));
  expect(terminals).toHaveLength(2);
  expect(terminals[0].dispose).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(ref.current?.getVisibleText()).toBe('existing output');
});

it('Lab next-step playback retains the real card and manual state; Replay resets the scene', async () => {
  act(() => root.render(<I18nContext.Provider value={{ locale: 'en-US', setLocale: () => {}, t: (key, params) => translateFromCatalog(messages, 'en-US', key, params) }}>
    <FlowChatScenarios />
  </I18nContext.Provider>));
  const next = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Next step')!;
  const replay = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Replay')!;
  const thinking = container.querySelector('[data-testid="chat-thinking-panel"]');
  expect(thinking?.getAttribute('data-expanded')).toBe('true');
  expect(container.querySelector('[data-testid="chat-explore-group"]')).toBeNull();
  act(() => next.click());
  expect(thinking?.getAttribute('data-expanded')).toBe('false');
  expect(container.querySelector('[data-testid="chat-thinking-panel"]')).toBe(thinking);
  expect(container.querySelector('[data-testid="chat-explore-group"]')).not.toBeNull();
  act(() => next.click());
  const card = container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]');
  expect(card).not.toBeNull();
  const expanded = () => card?.querySelector('[data-openbitfun-part="surface"][data-openbitfun-state~="expanded"]');
  expect(expanded()).toBeNull();
  act(() => next.click());
  expect(expanded()).toBeNull();
  await act(async () => { next.click(); });
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]')).toBe(card);
  expect(expanded()).not.toBeNull();
  expect(container.querySelector('.terminal-output-renderer__xterm-host')).not.toBeNull();
  act(() => next.click());
  // Override the pending grace-period collapse, exactly as a reader can in production.
  act(() => (expanded() as HTMLElement).click());
  act(() => card!.querySelector<HTMLElement>('[data-openbitfun-part="surface"]')!.click());
  act(() => next.click());
  expect(expanded()).not.toBeNull();
  expect(next.disabled).toBe(true);
  act(() => replay.click());
  expect(container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]')).not.toBe(card);
  expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-state~="expanded"]')).toBeNull();
});

async function renderConversation(locale: 'en-US' | 'zh-CN' | 'zh-TW' = 'en-US') {
  await act(async () => {
    root.render(<I18nContext.Provider value={{ locale, setLocale: () => {}, t: (key, params) => translateFromCatalog(messages, locale, key, params) }}>
      <FlowChatMockPage />
    </I18nContext.Provider>);
  });
  await act(async () => { await vi.dynamicImportSettled(); });
}

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent === label || element.getAttribute('aria-label') === label);
  expect(found, `Missing button: ${label}`).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => { button(label).click(); });
}

function setDraft(value: string) {
  const textarea = container.querySelector('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each(['en-US', 'zh-CN', 'zh-TW'] as const)('complete conversation composes real views with localized scenario tabs (%s)', async (locale) => {
  await renderConversation(locale);
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
  await act(async () => container.querySelector<HTMLButtonElement>('#flow-chat-mock-tab-completed')!.click());
  expect(container.querySelectorAll('.flow-chat-mock__user')).toHaveLength(2);
  expect(container.querySelectorAll('[data-testid="chat-thinking-panel"]')).toHaveLength(2);
  expect(container.querySelector('[data-reasoning-kind="summary"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="chat-explore-group"]')).not.toBeNull();
  expect(container.querySelector('[data-openbitfun-tool-card="todo"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-openbitfun-component="file-operation-tool-card"][data-openbitfun-part="root"]')).toHaveLength(2);
  expect(container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]')).not.toBeNull();
  expect(container.querySelector('[data-openbitfun-component="chat-composer"]')).not.toBeNull();
  expect(container.querySelector('[data-runtime-status-visible="false"]')).not.toBeNull();
  expect(container.querySelector('.flow-chat-mock .flow-chat-mock__toolbar')).toBeNull();
  expect(container.textContent).not.toMatch(/flowChat\.mock\.|nav\.flowChatMock/);
});

it('the all-tools conversation covers every production standard binding without claiming product-owned workflows', async () => {
  await renderConversation();
  await act(async () => container.querySelector<HTMLButtonElement>('#flow-chat-mock-tab-all-tools')!.click());
  const names = [...container.querySelectorAll<HTMLElement>('[data-mock-tool]')].map((node) => node.dataset.mockTool).sort();
  const production = Object.entries(toolPresentationRegistry).filter(([, entry]) => entry.owner === 'standard').map(([name]) => name).sort();
  expect(names).toEqual(production);
  expect(new Set(names).size).toBe(mockToolCoverage.length);
  expect(names).not.toContain('Task');
  expect(container.querySelector('.flow-chat-mock .flow-chat-mock__coverage-controls')).toBeNull();
});

it('fullscreen preserves the conversation, draft and scroll; menus own Escape before the page', async () => {
  await renderConversation();
  const page = container.querySelector('#flow-chat-mock')!;
  const transcript = container.querySelector<HTMLElement>('.flow-chat-mock__transcript')!;
  const thinking = container.querySelector('[data-testid="chat-thinking-panel"]')!;
  const textarea = container.querySelector('textarea')!;
  act(() => thinking.querySelector<HTMLElement>('[data-testid="chat-thinking-toggle"]')!.click());
  setDraft('Keep this draft while viewing fullscreen.');
  transcript.scrollTop = 120;
  await click('View fullscreen');
  expect(page.hasAttribute('data-fullscreen')).toBe(true);
  expect(thinking.getAttribute('data-expanded')).toBe('true');
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft while viewing fullscreen.');
  expect(container.querySelector('.flow-chat-mock__transcript')).toBe(transcript);
  expect(transcript.scrollTop).toBe(120);

  await click('Preview model');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(button('Preview model').getAttribute('aria-expanded')).toBe('false');
  expect(page.hasAttribute('data-fullscreen')).toBe(true);
  await click('Exit fullscreen');
  expect(page.hasAttribute('data-fullscreen')).toBe(false);
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(document.activeElement).toBe(button('View fullscreen'));

  await click('View fullscreen');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(page.hasAttribute('data-fullscreen')).toBe(false);
});

it('native fullscreen includes portal surfaces and follows browser exit and route cleanup', async () => {
  let fullscreenElement: Element | null = null;
  const request = vi.fn(async () => { fullscreenElement = document.documentElement; });
  const exit = vi.fn(async () => { fullscreenElement = null; });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: request });
  try {
    await renderConversation();
    await click('View fullscreen');
    expect(request).toHaveBeenCalledOnce();
    expect(fullscreenElement).toBe(document.documentElement);
    act(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(container.querySelector('#flow-chat-mock')!.hasAttribute('data-fullscreen')).toBe(false);
    await click('View fullscreen');
    await act(async () => root.render(null));
    expect(exit).toHaveBeenCalledOnce();
  } finally {
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  }
});

it('an embedded host denying native fullscreen retains the usable in-page view', async () => {
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true, value: vi.fn().mockRejectedValue(new Error('Fullscreen unavailable in this host')),
  });
  try {
    await renderConversation();
    await click('View fullscreen');
    expect(container.querySelector('#flow-chat-mock')!.hasAttribute('data-fullscreen')).toBe(true);
    await click('Exit fullscreen');
    expect(container.querySelector('#flow-chat-mock')!.hasAttribute('data-fullscreen')).toBe(false);
  } finally {
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  }
});

it('the composition replay preserves disclosure and resets only when explicitly replayed', async () => {
  await renderConversation();
  await click('Replay');
  const thinking = container.querySelector('[data-testid="chat-thinking-panel"]')!;
  const toggle = thinking.querySelector<HTMLElement>('[data-testid="chat-thinking-toggle"]')!;
  act(() => toggle.click());
  await click('Next step');
  expect(container.querySelector('[data-testid="chat-thinking-panel"]')).toBe(thinking);
  expect(thinking.getAttribute('data-expanded')).toBe('false');
  const explore = container.querySelector('[data-testid="chat-explore-group"]')!;
  act(() => explore.querySelector<HTMLElement>('[data-testid="chat-explore-group-toggle"]')!.click());
  await click('Next step');
  expect(container.querySelector('[data-testid="chat-explore-group"]')).toBe(explore);
  expect(explore.getAttribute('data-expanded')).toBe('true');
  await click('Replay');
  expect(container.querySelector('[data-testid="chat-thinking-panel"]')).not.toBe(thinking);
  expect(container.querySelector('[data-testid="chat-explore-group"]')).toBeNull();
});

it.each(['frontend', 'inspect'])('answering the question applies the chosen %s branch', async (choice) => {
  await renderConversation();
  await click('Awaiting an answer');
  expect(button('Next step').disabled).toBe(true);
  expect(button('Continue').disabled).toBe(true);
  expect(container.querySelector('[data-openbitfun-component="file-operation-tool-card"]')).toBeNull();
  act(() => container.querySelector<HTMLInputElement>(`input[value="${choice}"]`)!.click());
  await click('Continue');
  if (choice === 'inspect') {
    expect(container.querySelector('[data-openbitfun-component="file-operation-tool-card"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]')).toBeNull();
    expect(container.textContent).toContain('No files were changed.');
    expect(button('Next step').disabled).toBe(true);
  } else {
    expect(container.querySelector('[data-openbitfun-component="file-operation-tool-card"]')).not.toBeNull();
    expect(container.textContent).toContain('keep the API unchanged');
    expect(button('Next step').disabled).toBe(false);
  }
});

it('busy input queues locally; stopping retains output and enables explicit queue delivery', async () => {
  await renderConversation();
  await click('In progress');
  const card = container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]');
  setDraft('Keep the existing API.');
  await click('Add to queue');
  expect(container.querySelector('[data-openbitfun-component="chat-composer-queue"]')?.textContent).toContain('Keep the existing API.');
  expect(button('Send queued message').disabled).toBe(true);
  await click('Stop playback');
  expect(container.querySelector('[data-openbitfun-adapter="exec-process-tool-card"]')).toBe(card);
  expect(card?.querySelector('[data-openbitfun-status="cancelled"]')).not.toBeNull();
  expect(container.querySelector('[data-runtime-status-visible="false"]')).not.toBeNull();
  expect(container.textContent).not.toContain('All 12 tests passed');
  await click('Send queued message');
  expect(container.querySelector('[data-openbitfun-component="chat-composer-queue"]')).toBeNull();
  expect(container.querySelectorAll('.flow-chat-mock__user')).toHaveLength(3);
  const turns = container.querySelectorAll('.flow-chat-mock__user');
  expect(turns[turns.length - 1].textContent).toContain('Keep the existing API.');
});

it('removing a queued message and switching scenarios discard local scenario state', async () => {
  await renderConversation();
  await click('In progress');
  setDraft('An unsent follow-up');
  await click('Add to queue');
  await click('Remove queued message');
  expect(container.querySelector('[data-openbitfun-component="chat-composer-queue"]')).toBeNull();
  expect(container.textContent).not.toContain('An unsent follow-up');
  setDraft('Unsent draft');
  await click('Execution failed');
  expect(container.querySelector('textarea')!.value).toBe('');
  expect(container.textContent).toContain('verification could not run');
  expect(container.textContent).not.toContain('All 12 tests passed');
});
