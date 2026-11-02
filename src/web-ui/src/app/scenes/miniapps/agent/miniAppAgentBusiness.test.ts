/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMiniAppAgentRequest } from './miniAppAgentRouter';
import { getMiniAppAgentSurface, registerMiniAppAgentSurface, releaseMiniAppAgentSurfaces } from './miniAppAgentSurfaceRegistry';
import { assertMiniAppAgentBridgePayload } from './miniAppAgentProtocol';
import { bootBusinessApp, readSource, regexSource } from './__tests__/businessFixture';

const appId = 'builtin-regex-playground';
async function runningApp(opaque = false, source?: string, html?: string, legacy = false, saved?: unknown) {
  vi.useFakeTimers();
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const rt = await bootBusinessApp(frame, source, html, legacy, saved);
  // A real runner registers before startup. Replay the actual announcement
  // here after registering the readable/opaque surface fixture.
  const surfaceFrame = opaque ? new Proxy(frame, {
    get(target, property) {
      if (property === 'contentDocument') throw new Error('Opaque document');
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : frame;
  registerMiniAppAgentSurface({ appId, iframe: surfaceFrame, instanceId: 'live-instance', strictRuntime: opaque, ready: true });
  // Use the real announcement emitted during startup, not a fabricated capability.
  const announcement = rt.parentPosts.mock.calls.map(([data]) => data)
    .filter(data => data.type === 'openbitfun:miniapp-agent-ready').at(-1);
  window.dispatchEvent(new MessageEvent('message', { source: rt.win, data: announcement }));
  const presentApp = vi.fn(async () => ({ instanceId: 'live-instance' }));
  const deps = { presentApp };
  let next = 0;
  const execute = (method: string, params: Record<string, unknown> = {}) => handleMiniAppAgentRequest({
    requestId: `host-${++next}`, action: 'execute',
    command: { appId, instanceId: 'live-instance', method, params: { requestId: `bridge-${next}`, ...params } },
  }, deps);
  const observe = () => execute('bridge_observe');
  const act = (action: Record<string, unknown>) => execute('bridge_act', { action });
  const opened = await handleMiniAppAgentRequest({ requestId: 'open', action: 'open', appId }, deps);
  return { ...rt, act, observe, opened, presentApp, execute };
}

afterEach(() => {
  releaseMiniAppAgentSurfaces();
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('source-informed business operations on a live MiniApp', () => {
  it('plays the unchanged legacy Gomoku through bound SVG input without desktop control or a semantic bridge', async () => {
    const root = 'crates/contracts/product-domains/src/miniapp/builtin/assets/gomoku';
    const rt = await runningApp(false, readSource(`${root}/ui.js`), readSource(`${root}/index.html`), true);
    expect(rt.opened.capabilities).toContain('element-position-click-v1');
    expect((await rt.observe()).state).toBeNull();
    const write = vi.spyOn(rt.doc, 'write');
    const board = rt.doc.querySelector('#board')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 80, top: 30, width: 560, height: 560 } as DOMRect);
    const found = await rt.execute('find', { locator: { selector: '#board' } });
    const nodeKey = (found.matches as { nodeKey: string }[])[0].nodeKey;

    await rt.execute('click', { nodeKey, position: { x: 0.5, y: 0.5 } });
    expect(board.querySelectorAll('.stone-black')).toHaveLength(1);
    const black = board.querySelector('.stone-black')!;
    const viewBox = board.getAttribute('viewBox')!.split(/\s+/).map(Number);
    expect(Number(black.getAttribute('cx'))).toBe(viewBox[2] / 2);
    expect(Number(black.getAttribute('cy'))).toBe(viewBox[3] / 2);
    await vi.advanceTimersByTimeAsync(250);
    expect(board.querySelectorAll('.stone-white')).toHaveLength(1);

    // An off-center position must select a different intersection, rather than
    // silently degrading to the element's center.
    await rt.execute('click', { nodeKey, position: { x: 0.1, y: 0.1 } });
    expect(board.querySelectorAll('.stone-black')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(board.querySelectorAll('.stone-white')).toHaveLength(2);

    await expect(rt.execute('click', { nodeKey, position: { x: -1, y: 0.5 } })).rejects.toThrow('INVALID_PARAMS');
    expect(board.querySelectorAll('.stone-black')).toHaveLength(2);
    expect(rt.frame.contentDocument).toBe(rt.doc);
    expect(rt.doc.querySelector('#board')).toBe(board);
    expect(write).not.toHaveBeenCalled();
    expect(rt.presentApp).toHaveBeenCalledOnce();
  });

  it.each([false, true])('preserves unsaved text and document identity (opaque=%s)', async opaque => {
    const rt = await runningApp(opaque);
    expect(rt.opened.capabilities).toEqual(opaque ? [] : ['dom', 'accessibility', 'input', 'element-position-click-v1']);
    const entry = getMiniAppAgentSurface(appId);
    const write = vi.spyOn(rt.doc, 'write');
    const draft = 'Unsubmitted: alice@example.com and bob@example.com';
    const text = rt.input('test-text', draft);
    rt.input('replace-input', '[email]');
    expect(rt.storage.set).not.toHaveBeenCalled();
    expect(await rt.observe()).toMatchObject({ state: { text: { value: draft } } });

    const applied = await rt.act({ type: 'apply-pattern', id: 'email' });
    expect(applied).toMatchObject({ result: { applied: true, state: {
      text: { value: draft }, replacement: { value: '[email]' }, matchCount: 2,
      replacementPreview: { value: 'Unsubmitted: [email] and [email]' },
    } } });
    await rt.act({ type: 'select-match', index: 1 });
    expect(rt.doc.querySelector('.match.is-active')?.getAttribute('data-idx')).toBe('1');
    const edited = await rt.act({ type: 'set-input', input: { replacement: '<redacted>' } });
    expect(edited).toMatchObject({ result: { state: { activeMatchIndex: 1, text: { value: draft } } } });
    expect(rt.doc.getElementById('replace-output')?.textContent).toBe('Unsubmitted: <redacted> and <redacted>');
    expect(rt.doc.querySelector('.match.is-active')?.getAttribute('data-idx')).toBe('1');
    expect(text.selectionStart).toBe(draft.indexOf('bob@example.com'));
    expect(text.value).toBe(draft);
    expect(rt.frame.contentWindow).toBe(rt.win);
    expect(rt.frame.contentDocument).toBe(rt.doc);
    expect(rt.doc.getElementById('test-text')).toBe(text);
    expect(getMiniAppAgentSurface(appId)).toBe(entry);
    expect(rt.presentApp).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(rt.storage.get).toHaveBeenCalledOnce();
    expect(rt.storage.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(rt.storage.set).toHaveBeenLastCalledWith('regex-state', expect.objectContaining({ text: draft, replacement: '<redacted>' }));
  });

  it('rejects unknown actions and invalid patches without partially changing the draft', async () => {
    const rt = await runningApp();
    rt.input('test-text', 'pending draft');
    const before = (await rt.observe()).state;
    for (const action of [
      { type: 'invented' }, { type: 'apply-pattern', id: 'missing' },
      { type: 'set-input', input: { text: 'must not apply', flags: 'gg' } },
      { type: 'set-input', input: { text: 'must not apply', replacement: 42 } },
      { type: 'select-match', index: -1 },
    ]) {
      await expect(rt.act(action)).rejects.toThrow('BRIDGE_REJECTED');
      expect((await rt.observe()).state).toEqual(before);
    }
  });

  it('uses the same library operation for UI and Agent, and reports editable regex errors', async () => {
    const rt = await runningApp();
    rt.input('test-text', 'alice@example.com');
    const viaAgent = await rt.act({ type: 'apply-pattern', id: 'email' });
    await rt.act({ type: 'set-input', input: { pattern: '[' } });
    expect(await rt.observe()).toMatchObject({ state: { error: { truncated: false }, matchCount: 0 } });
    (rt.doc.querySelector('.lib-item') as HTMLElement).click();
    expect((await rt.observe()).state).toEqual((viaAgent.result as { state: unknown }).state);
  });

  it('bounds escaped and multibyte observations and labels partial data', async () => {
    const rt = await runningApp();
    rt.input('test-text', '\u0000界'.repeat(2000));
    rt.input('pattern', '[\\s\\S]{130}');
    rt.input('replace-input', '\u0000界'.repeat(2000));
    const observed = await rt.observe();
    expect(observed).toMatchObject({ state: {
      text: { length: 4000, truncated: true }, replacement: { truncated: true }, matchesTruncated: true,
    } });
    expect(() => assertMiniAppAgentBridgePayload(observed)).not.toThrow();
  });

  it('keeps the UI working on older hosts without expose', async () => {
    const rt = await runningApp(false, undefined, undefined, true);
    rt.input('test-text', 'alice@example.com');
    (rt.doc.querySelector('.lib-item') as HTMLElement).click();
    expect(rt.doc.querySelectorAll('.match')).toHaveLength(1);
    expect(await rt.observe()).toMatchObject({ state: null });
    await expect(rt.act({ type: 'apply-pattern', id: 'email' })).rejects.toThrow('BRIDGE_UNAVAILABLE');
  });

  it('ships the same business example in the authoring skill', () => {
    expect(readSource('crates/assembly/core/builtin_skills/miniapp-dev/references/examples/builtin-regex-playground/ui.js')).toBe(regexSource);
  });

  it('reads and writes the legacy storage shape, including intentionally empty drafts', async () => {
    const saved = { pattern: '', text: '', replacement: '', flags: [] };
    const rt = await runningApp(false, undefined, undefined, false, saved);
    expect(await rt.observe()).toMatchObject({ state: {
      pattern: { value: '' }, text: { value: '' }, replacement: { value: '' }, flags: '',
    } });
    await rt.act({ type: 'set-input', input: { replacement: '$1' } });
    await vi.advanceTimersByTimeAsync(350);
    expect(rt.storage.set).toHaveBeenLastCalledWith('regex-state', { ...saved, replacement: '$1' });
  });

  it('creates a skeleton whose UI and semantic action share live state', async () => {
    const init = readSource('crates/assembly/core/src/agentic/tools/implementations/miniapp_init_tool.rs');
    const source = init.split('const SKELETON_UI_JS: &str = r#"')[1].split('"#;')[0];
    const rt = await runningApp(false, source, '<main id="app"></main>');
    const input = rt.doc.querySelector('textarea')!;
    input.value = 'user draft';
    input.dispatchEvent(new rt.win.Event('input'));
    expect(await rt.observe()).toMatchObject({ state: { text: 'user draft' } });
    await rt.act({ type: 'set-text', text: 'updated draft' });
    expect(input.value).toBe('updated draft');
    await expect(rt.act({ type: 'set-text', text: 3 })).rejects.toThrow('BRIDGE_REJECTED');
    expect(input.value).toBe('updated draft');
    expect(rt.doc.querySelector('textarea')).toBe(input);
  });
});
