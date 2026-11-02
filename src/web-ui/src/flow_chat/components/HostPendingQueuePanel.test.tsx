/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HostDialogQueue, type QueueOutboxRecord, type QueueSnapshot } from '../../../../shared/dialog-queue/HostDialogQueue';
import { HostPendingQueuePanel } from './HostPendingQueuePanel';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../services/flow-chat-manager/PendingQueueModule', () => ({ pendingQueueManager: { enqueue: vi.fn() } }));

it.each([false, true])('keeps a normal send hidden and shows recovery only on failure (failure=%s)', async failure => {
  const records = new Map<string, QueueOutboxRecord>();
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const acknowledgement = new Promise<void>(resolve => { finish = resolve; });
  const snapshot: QueueSnapshot = { sessionId: 'session', queueEpoch: 'epoch', revision: 0,
    activeTurnId: null, items: [], capacity: 20, used: 0, receipt: null };
  const queue = new HostDialogQueue('scope', 'session', async request => {
    if (request.action !== 'submit') return snapshot;
    entered();
    await acknowledgement;
    if (failure) throw new Error('Connection lost');
    return { ...snapshot, revision: 1, receipt: { turnId: request.message.turnId,
      displayContent: request.message.content, status: 'started', previewTruncated: false,
      attachmentCount: 0, agentType: 'Standard', createdAtMs: 1, reason: null,
      targetTurnId: null, steeringId: null } };
  }, {
    list: async () => [...records.values()],
    put: async record => { records.set(record.key, record); },
    remove: async key => { records.delete(key); },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostPendingQueuePanel queue={queue} onRestore={() => true} />));
    let sending!: Promise<unknown>;
    await act(async () => {
      sending = queue.submit({ content: 'hello', agentType: 'Standard', attachments: [], metadata: {} }).catch(() => undefined);
      await started;
      await queue.refresh();
    });
    expect(records.size).toBe(1);
    expect(container.textContent).toBe('');
    await act(async () => { finish(); await sending; });
    if (failure) {
      expect(container.textContent).toContain('hostQueue.unknown');
      expect(container.textContent).toContain('hello');
    } else {
      expect(container.textContent).toBe('');
    }
  } finally {
    finish();
    await act(async () => root.unmount());
    container.remove();
  }
});

it('keeps four queued messages compact, exposes actions, and toggles help independently', async () => {
  const requests: string[] = [];
  let items = Array.from({ length: 4 }, (_, index) => ({ turnId: String(index), displayContent: String(index + 1),
    status: 'queued' as const, previewTruncated: false, attachmentCount: 0, agentType: 'Standard',
    createdAtMs: 1, reason: null, targetTurnId: null, steeringId: null }));
  const queue = new HostDialogQueue('scope', 'session', async request => {
    requests.push(request.action);
    if (request.action === 'cancel' || request.action === 'promote') items = items.filter(item => item.turnId !== request.turnId);
    return { sessionId: 'session', queueEpoch: 'epoch', revision: requests.length, activeTurnId: 'active',
      items, capacity: 20, used: items.length, receipt: null };
  }, { list: async () => [], put: async () => {}, remove: async () => {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostPendingQueuePanel queue={queue} onRestore={() => true} />));
    expect(container.querySelectorAll('li')).toHaveLength(4);
    expect(container.textContent).not.toContain('hostQueue.memoryNotice');
    expect(container.textContent).not.toContain('hostQueue.queued');
    expect(container.querySelectorAll('[aria-label="hostQueue.sendNow"]')).toHaveLength(4);
    const toggle = container.querySelector<HTMLButtonElement>('.host-pending-queue__toggle')!;
    await act(async () => toggle.click());
    expect(container.querySelector('ul')?.hidden).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="hostQueue.about"]')!.click());
    expect(container.textContent).toContain('hostQueue.memoryNotice');
    await act(async () => toggle.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="hostQueue.sendNow"]')!.click());
    expect(requests).toContain('promote');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="hostQueue.cancel"]')!.click());
    expect(container.querySelectorAll('li')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('copies the complete unresolved draft after an owner restart without resending or deleting it', async () => {
  const saved: QueueOutboxRecord = { key: 'draft', scope: 'scope', accepted: true,
    request: { sessionId: 'session', queueEpoch: 'old-owner', action: 'submit',
      message: { turnId: 'turn', content: 'full prompt', displayContent: 'display prompt',
        agentType: 'Standard', attachments: [], metadata: { context: 'original' } } },
    draft: { composerDraft: { text: 'full prompt' }, imageContexts: [{ id: 'attachment' }] } };
  const records = new Map([[saved.key, saved]]);
  const invoke = vi.fn(async () => ({ sessionId: 'session', queueEpoch: 'new-owner', revision: 0,
    activeTurnId: null, items: [], capacity: 20, used: 0, receipt: null }));
  const queue = new HostDialogQueue('scope', 'session', invoke, {
    list: async () => [...records.values()], put: async record => { records.set(record.key, record); },
    remove: async key => { records.delete(key); },
  });
  const onRestore = vi.fn(() => true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostPendingQueuePanel queue={queue} onRestore={onRestore} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="hostQueue.copyDraft"]')!.click());
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({
      content: 'full prompt', displayMessage: 'display prompt', composerDraft: { text: 'full prompt' },
      imageContexts: [{ id: 'attachment' }], userMessageMetadata: { context: 'original' },
    }));
    expect(invoke.mock.calls).toHaveLength(1);
    expect(records.has(saved.key)).toBe(true);
    expect(queue.getSnapshot().pending).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
