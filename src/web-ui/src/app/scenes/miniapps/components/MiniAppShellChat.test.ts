// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMiniAppChat, type MiniAppChatEvent, type MiniAppChatSnapshot } from '../../../../../../apps/miniapp-shell/src/miniapp-chat';
import translations from '../../../../../../apps/miniapp-shell/src/chat-labels.json';

const labels = translations['en-US'];
const empty = (sessionId = 'session'): MiniAppChatSnapshot => ({ sessionId, turns: [], runtime: { streamId: 'runtime', cursor: 0, events: [] } });
const started = (turnId = 'turn', sessionId = 'session'): MiniAppChatEvent => ({ sessionId, turnId, sourceEvent: 'dialog-turn-started', userInput: 'Question' });
const chunk = (value: string, cursor: number, sessionId = 'session'): MiniAppChatEvent => ({
  sessionId, turnId: 'turn', roundId: 'round', sourceEvent: 'text-chunk', text: value,
  __openbitfunRuntimeStreamId: 'runtime', __openbitfunRuntimeEventCursor: cursor,
});
function fixture(loadSnapshot = vi.fn(async (id: string) => empty(id)), snapshotSupported = true) {
  const root = document.createElement('div'); document.body.append(root);
  const onSend = vi.fn(), onStop = vi.fn(async () => {});
  const chat = mountMiniAppChat(root, { onSend, onStop, loadSnapshot });
  chat.configure({ labels, appName: 'Slides', snapshotSupported });
  const input = root.querySelector('textarea')!;
  const form = root.querySelector('form')!;
  const launcher = root.querySelector<HTMLButtonElement>('.miniapp-chat__launcher')!;
  const panel = root.querySelector<HTMLElement>('[role="dialog"]')!;
  return { chat, root, input, form, launcher, panel, onSend, onStop, loadSnapshot };
}
beforeEach(() => { document.body.replaceChildren(); });

describe('MiniApp Shell dedicated chat', () => {
  it('uses Hi and FlowChat anatomy and keeps Enter submission compatible with multiline and IME input', async () => {
    const { chat, root, input, launcher, panel, onSend } = fixture();
    chat.claim();
    expect(root.classList.contains('openbitfun-fmc')).toBe(true);
    expect(launcher.dataset.openbitfunComponent).toBe('launcher-button');
    expect(panel.classList.contains('openbitfun-fmc__panel')).toBe(true);
    chat.setDraft('First line\nSecond line');
    const composer = root.querySelector('[data-openbitfun-component="chat-composer"]')!;
    expect(composer.querySelector('[data-openbitfun-part="surface"]')!.getAttribute('data-openbitfun-layout')).toBe('expanded');
    expect(composer.querySelector('[data-openbitfun-part="content"] textarea')).toBe(input);
    expect(composer.querySelector('button[type="submit"]')!.getAttribute('data-openbitfun-variant')).toBe('primary');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(onSend).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    await chat.focusSession('session');
    chat.acceptedRun({ sessionId: 'session', turnId: 'turn' }, chat.getRequestId());
    chat.event(started()); chat.event(chunk('FlowChat reply', 1));
    expect(root.querySelector('.user-message-item-shell .user-message-item__content')!.textContent).toContain('First line');
    expect(root.querySelector('.model-round-item .flow-text-block .text-content')!.textContent).toBe('FlowChat reply');
    root.querySelector<HTMLButtonElement>('header button')!.click();
    expect(panel.inert).toBe(true);
    expect(panel.classList.contains('openbitfun-fmc__panel--open')).toBe(false);
    expect(root.textContent).toContain('FlowChat reply');
  });

  it('only appears after a claim and safely renders app-owned welcome text', () => {
    const { chat, root, launcher, panel, input } = fixture();
    expect(root.hidden).toBe(true);
    chat.claim({ title: '<img src=x onerror=alert(1)>', welcome: { title: 'Create slides', suggestions: [{ label: 'Outline', prompt: 'Draft an outline' }] } });
    expect(root.hidden).toBe(false);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.inert).toBe(true);
    launcher.click();
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(panel.inert).toBe(false);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.miniapp-chat__title')!.textContent).toContain('<img');
    root.querySelector<HTMLButtonElement>('.miniapp-chat__suggestions button')!.click();
    expect(input.value).toBe('Draft an outline');
    chat.release();
    expect(root.hidden).toBe(true);
  });

  it('routes the first message without requiring a pre-existing session and waits for SDK completion', async () => {
    const { chat, input, form, onSend, root } = fixture();
    chat.claim(); chat.setDraft('First request'); form.requestSubmit();
    expect(onSend).toHaveBeenCalledTimes(1);
    const submission = onSend.mock.calls[0][0];
    expect(submission.text).toBe('First request');
    expect(submission.message).toBe('First request');
    await chat.focusSession('session');
    chat.acceptedRun({ sessionId: 'session', turnId: 'turn' }, chat.getRequestId());
    chat.event(started());
    chat.event({ sessionId: 'session', turnId: 'turn', sourceEvent: 'dialog-turn-completed', success: true });
    expect(root.textContent).toContain(labels.processing);
    expect(chat.complete({ requestId: 'stale' })).toEqual({ completed: false });
    expect(chat.complete({ requestId: submission.requestId })).toEqual({ completed: true });
    input.value = 'Follow-up'; input.dispatchEvent(new Event('input'));
    form.requestSubmit();
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('filters other sessions and preserves work when the panel collapses', async () => {
    const { chat, root, panel, onStop } = fixture();
    chat.claim(); await chat.focusSession('session');
    chat.event(started()); chat.event(chunk('Correct answer', 1)); chat.event(chunk('Private other app', 2, 'other'));
    expect(root.textContent).toContain('Correct answer');
    expect(root.textContent).not.toContain('Private other app');
    root.querySelector<HTMLButtonElement>('header button')!.click();
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(onStop).not.toHaveBeenCalled();
    chat.setApproval(true);
    expect(root.querySelector('button')!.getAttribute('aria-label')).toBe(labels.approval);
    expect(root.querySelector('button')!.dataset.attention).toBe('true');
  });

  it('merges the authoritative snapshot and newer live events exactly once', async () => {
    let resolve!: (snapshot: MiniAppChatSnapshot) => void;
    const { chat, root } = fixture(vi.fn(() => new Promise<MiniAppChatSnapshot>(done => { resolve = done; })));
    chat.claim();
    const focus = chat.focusSession('session');
    chat.event(chunk('Hello', 4)); chat.event(chunk(' world', 6));
    resolve({ sessionId: 'session', turns: [], runtime: { streamId: 'runtime', cursor: 5, activeTurnId: 'turn', events: [started(), chunk('Hello', 5)] } });
    await focus;
    expect(root.textContent).toContain('Hello world');
    expect(root.textContent).not.toContain('HelloHello');
    chat.event(chunk(' world', 6));
    expect(root.textContent).not.toContain('world world');
  });

  it('keeps a new submission separate from the previous turn replay and binds the accepted run', async () => {
    const previous: MiniAppChatSnapshot = { sessionId: 'session', turns: [], runtime: {
      streamId: 'runtime', cursor: 5, events: [started('previous'), { sessionId: 'session', turnId: 'previous', sourceEvent: 'dialog-turn-completed', success: true }],
    } };
    const { chat, root, form } = fixture(vi.fn(async () => previous));
    chat.claim(); chat.setDraft('New request'); form.requestSubmit();
    await chat.focusSession('session');
    const userRows = () => [...root.querySelectorAll('[data-role="user"] p')].map(row => row.textContent);
    expect(userRows()).toEqual(['Question', 'New request']);
    chat.acceptedRun({ sessionId: 'session', turnId: 'current' }, chat.getRequestId());
    chat.event(started('current'));
    expect(userRows()).toEqual(['Question', 'New request']);
    // A later recovery includes this turn; the local pending row is no longer duplicated.
    expect(root.querySelectorAll('[data-role="user"]')).toHaveLength(2);
  });

  it('replaces superseded attempt text and ignores non-chat events', async () => {
    const { chat, root } = fixture();
    chat.claim(); await chat.focusSession('session'); chat.event(started());
    chat.event({ ...chunk('Superseded', 1), attemptId: 'first' });
    chat.event({ ...chunk('Replacement', 2), attemptId: 'retry' });
    chat.event({ sessionId: 'session', turnId: 'other-turn', sourceEvent: 'token-usage-updated' });
    expect(root.textContent).not.toContain('Superseded'); expect(root.textContent).toContain('Replacement');
    expect(root.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
  });

  it('ignores an old snapshot and events after switching the app topic', async () => {
    const replies = new Map<string, (value: MiniAppChatSnapshot) => void>();
    const { chat, root } = fixture(vi.fn(id => new Promise<MiniAppChatSnapshot>(resolve => replies.set(id, resolve))));
    chat.claim(); const first = chat.focusSession('first'); const second = chat.focusSession('second');
    replies.get('second')!({ sessionId: 'second', turns: [{ id: 'new', user: 'New topic', status: 'completed', rounds: [] }] });
    await second;
    replies.get('first')!({ sessionId: 'first', turns: [{ id: 'old', user: 'Old topic', status: 'completed', rounds: [] }] });
    await first;
    chat.event(chunk('Old answer', 1, 'first'));
    expect(root.textContent).toContain('New topic');
    expect(root.textContent).not.toContain('Old topic'); expect(root.textContent).not.toContain('Old answer');
  });

  it('keeps SDK input usable with an older host and clearly reports limited recovery', async () => {
    const { chat, root, input, form, onSend, loadSnapshot } = fixture(undefined, false);
    chat.claim(); await chat.focusSession('session');
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(root.textContent).toContain(labels.liveOnly);
    input.value = 'Legacy request'; input.dispatchEvent(new Event('input')); form.requestSubmit();
    expect(onSend).toHaveBeenCalledTimes(1);
    chat.event(started()); chat.event(chunk('Live reply', 1));
    expect(root.textContent).toContain('Live reply');
  });

  it('retains messages on a failed restore, retries on reconnect, and cancels only the active turn', async () => {
    const load = vi.fn(async (id: string) => empty(id));
    const { chat, root, onStop } = fixture(load);
    chat.claim(); await chat.focusSession('session'); chat.event(started()); chat.event(chunk('Keep this', 1));
    load.mockRejectedValueOnce(new Error('Host unavailable'));
    await chat.resync();
    expect(root.textContent).toContain('Keep this'); expect(root.textContent).toContain('Host unavailable');
    root.querySelectorAll<HTMLButtonElement>('.miniapp-chat__actions button')[0].click();
    await Promise.resolve();
    expect(onStop).toHaveBeenCalledWith({ sessionId: 'session', turnId: 'turn' });
    chat.setConnected(false);
    expect(root.textContent).toContain(labels.offline);
    chat.setConnected(true); await chat.resync();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('clears and releases presentation without cancelling the Agent', async () => {
    const { chat, root, onStop } = fixture();
    chat.claim(); await chat.focusSession('session'); chat.event(started()); chat.event(chunk('Answer', 1));
    chat.clearSession(); expect(root.textContent).not.toContain('Answer');
    chat.release(); chat.event(chunk('Late answer', 2));
    expect(root.hidden).toBe(true); expect(onStop).not.toHaveBeenCalled();
    expect(() => chat.setDraft('Late draft')).toThrow('has not claimed');
  });

  it('does not associate an earlier submission response with a newly claimed composer', async () => {
    const { chat, form, root } = fixture();
    chat.claim(); chat.setDraft('Earlier request'); form.requestSubmit();
    const earlier = chat.getRequestId();
    chat.release(); chat.claim(); chat.setDraft('Current request'); form.requestSubmit();
    await chat.focusSession('session');
    chat.acceptedRun({ sessionId: 'session', turnId: 'earlier' }, earlier);
    chat.event(started('earlier'));
    expect(root.querySelectorAll('[data-role="user"]')).toHaveLength(2);
    chat.acceptedRun({ sessionId: 'session', turnId: 'current' }, chat.getRequestId());
    chat.event(started('current'));
    expect(root.querySelectorAll('[data-role="user"]')).toHaveLength(2);
    expect(root.textContent).not.toContain('Earlier request');
    expect(root.textContent).toContain('Current request');
  });

  it('settles an old request without displaying its failure in a different topic', async () => {
    const { chat, form, root } = fixture();
    chat.claim(); await chat.focusSession('first');
    chat.setDraft('First topic request'); form.requestSubmit();
    const requestId = chat.getRequestId()!;
    chat.clearSession(); await chat.focusSession('second');
    expect(chat.complete({ requestId, error: 'Failure in the first topic' })).toEqual({ completed: true });
    expect(root.textContent).not.toContain('Failure in the first topic');
  });
});
