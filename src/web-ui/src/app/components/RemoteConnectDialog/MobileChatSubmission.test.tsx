// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPage from '../../../../../mobile-web/src/pages/ChatPage';
import { useMobileStore } from '../../../../../mobile-web/src/services/store';
import type ChatTranscript from '../../../../../mobile-web/src/components/ChatTranscript';
import type ChatMessageActions from '../../../../../mobile-web/src/components/ChatMessageActions';
import type { RemoteSessionManager } from '../../../../../mobile-web/src/services/RemoteSessionManager';

vi.mock('../../../../../mobile-web/src/i18n', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key }),
}));
vi.mock('../../../../../mobile-web/src/components/ChatHeader', () => ({ default: () => null }));
vi.mock('../../../../../mobile-web/src/components/ChatTranscript', () => ({
  default: ({ messages, onMessageContextMenu }: React.ComponentProps<typeof ChatTranscript>) => <button data-testid="message-menu" onClick={event => onMessageContextMenu(messages[0], event)}>message</button>,
}));
vi.mock('../../../../../mobile-web/src/components/ChatMessageActions', () => ({
  default: ({ message, rollbackSupported, onEdit }: React.ComponentProps<typeof ChatMessageActions>) => message && rollbackSupported ? <button data-testid="edit-message" onClick={onEdit}>edit</button> : null,
}));
vi.mock('../../../../../mobile-web/src/services/imageCompressor', () => ({
  compressImageFile: async (file: File) => ({ name: file.name, dataUrl: 'data:image/png;base64,dGVzdA==' }),
}));
vi.mock('../../../../../mobile-web/src/services/RemoteSessionManager', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../mobile-web/src/services/RemoteSessionManager')>();
  return { ...actual, SessionPoller: class { start() {} stop() {} nudge() {} } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

describe('mobile chat submission acknowledgement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let epoch: number;
  let listeners: Set<() => void>;
  let pending: ReturnType<typeof deferred<string>>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let manager: RemoteSessionManager;

  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
      clear: () => stored.clear(),
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useMobileStore.getState().resetConnectionState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    epoch = 0;
    listeners = new Set();
    pending = deferred<string>();
    sendMessage = vi.fn().mockImplementation(() => pending.promise);
    manager = {
      get controlTargetEpoch() { return epoch; },
      get controlTargetDeviceId() { return epoch === 0 ? 'device-a' : 'device-b'; },
      onControlTargetChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      invokeHost: vi.fn().mockResolvedValue({ sessionId: 'fixture', permissions: { revision: 0, requests: [] }, userQuestions: { revision: 0, questions: [] } }),
      subscribeSessionStream: vi.fn().mockResolvedValue({ close() {}, wake() {}, async loadOlder() {} }),
      getSessionMessages: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
      getModelCatalog: vi.fn().mockResolvedValue({ version: 1, models: [], default_models: {}, session_model_id: 'auto' }),
      supportsHostCapability: vi.fn((capability: string) => capability === 'session_rollback_v1'),
      rollbackSessionToTurn: vi.fn(),
      sendMessage,
    } as unknown as RemoteSessionManager;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => { root.render(<ChatPage sessionMgr={manager} sessionId="fixture" onBack={() => {}} autoFocus />); });
    await flush();
  }

  function editor() { return container.querySelector<HTMLTextAreaElement>('textarea')!; }
  function send() { return container.querySelector<HTMLButtonElement>('button[aria-label="common.submit"]')!; }
  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor(), value);
      editor().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('retains text and attachments when the host rejects the request', async () => {
    await mount();
    await type('keep this draft');
    const upload = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(upload, 'files', { value: [new File(['test'], 'fixture.png', { type: 'image/png' })] });
    await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    await act(async () => { send().click(); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][3][0].metadata.name).toBe('fixture.png');
    await act(async () => { pending.reject(new Error('workspace owner unavailable')); });
    expect(editor().value).toBe('keep this draft');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('dGVzdA==');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('workspace owner unavailable');
    expect(send().disabled).toBe(false);
  });

  it('accepts one request while pending and clears an acknowledged unchanged draft', async () => {
    await mount();
    await type('submit once');
    await act(async () => { send().click(); send().click(); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe('submit once');
    expect(send().disabled).toBe(true);
    await act(async () => { pending.resolve('turn-a'); });
    expect(container.textContent).not.toContain('submit once');
  });

  it('preserves text edited while an earlier request awaits acknowledgement', async () => {
    await mount();
    await type('first message');
    await act(async () => { send().click(); });
    await type('new draft while pending');
    await act(async () => { pending.resolve('turn-a'); });
    expect(editor().value).toBe('new draft while pending');
    expect(send().disabled).toBe(false);
  });

  it('does not show an old target failure after switching devices', async () => {
    await mount();
    await type('device a message');
    await act(async () => { send().click(); });
    await act(async () => { epoch = 1; listeners.forEach(fn => fn()); });
    await flush();
    await type('device b draft');
    await act(async () => { pending.reject(new Error('old device failure')); });
    expect(editor().value).toBe('device b draft');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(send().disabled).toBe(false);
  });

  async function openEdit(images?: { name: string; data_url: string }[]) {
    await act(async () => {
      useMobileStore.getState().setMessages('fixture', [{ id: 'user-a', role: 'user', content: 'original prompt', timestamp: '1', turn_id: 'turn-a', turn_index: 7, images }]);
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="message-menu"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="edit-message"]')!.click(); });
    const draft = document.querySelector<HTMLTextAreaElement>('.chat-msg__rollback-input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'edited prompt');
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function confirmEdit() {
    await act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'chat.editAction')!.click();
    });
  }

  it('retains the edit sheet draft when rollback fails before sending', async () => {
    const rollback = deferred<never>();
    vi.mocked(manager.rollbackSessionToTurn).mockReturnValue(rollback.promise);
    await mount();
    await openEdit();
    await confirmEdit();
    expect(manager.rollbackSessionToTurn).toHaveBeenCalledWith('fixture', 'turn-a', 7);
    await act(async () => { rollback.reject(new Error('stale history')); });
    expect(document.querySelector<HTMLTextAreaElement>('.chat-msg__rollback-input')?.value).toBe('edited prompt');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('restores attachments with the edited text if sending after rollback fails', async () => {
    vi.mocked(manager.rollbackSessionToTurn).mockResolvedValue({ retired_turn_ids: ['turn-a'], restored_files: [], changed: true });
    await mount();
    await openEdit([{ name: 'original.png', data_url: 'data:image/png;base64,b3JpZ2luYWw=' }]);
    await confirmEdit();
    await act(async () => { pending.reject(new Error('connection lost')); });
    expect(editor().value).toBe('edited prompt');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('b3JpZ2luYWw=');
    expect(document.querySelector('.chat-msg__rollback-input')).toBeNull();
  });

  it('does not clear a new target edit sheet when an old rollback fails', async () => {
    const rollback = deferred<never>();
    vi.mocked(manager.rollbackSessionToTurn).mockReturnValue(rollback.promise);
    await mount();
    await openEdit();
    await confirmEdit();
    await act(async () => { epoch = 1; listeners.forEach(fn => fn()); });
    await flush();
    await openEdit();
    await act(async () => { rollback.reject(new Error('old rollback failure')); });
    expect(document.querySelector<HTMLTextAreaElement>('.chat-msg__rollback-input')?.value).toBe('edited prompt');
    expect(useMobileStore.getState().error).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

});
