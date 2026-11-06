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

const queueItem = (turnId: string, status: 'queued' | 'blocked', displayContent = `message ${turnId}`) => ({
  turnId, displayContent, status, previewTruncated: false, attachmentCount: 0, agentType: 'Standard', createdAtMs: 1,
  reason: status === 'blocked' ? 'owner restarted' : null, targetTurnId: null, steeringId: null });

it('collapses the controlled list and keeps blocked and unconfirmed rows in a recovery list', async () => {
  const unconfirmed: QueueOutboxRecord = { key: 'draft', scope: 'scope', accepted: true,
    request: { sessionId: 'session', queueEpoch: 'old-owner', action: 'submit',
      message: { turnId: 'lost', content: 'lost prompt', displayContent: 'lost prompt',
        agentType: 'Standard', attachments: [], metadata: {} } } };
  const records = new Map([[unconfirmed.key, unconfirmed]]);
  const queue = new HostDialogQueue('scope', 'session', async () => ({ sessionId: 'session', queueEpoch: 'epoch',
    revision: 1, activeTurnId: 'active', items: [queueItem('a', 'queued'), queueItem('b', 'blocked')], capacity: 20, used: 2,
    receipt: null }), { list: async () => [...records.values()], put: async record => { records.set(record.key, record); },
    remove: async key => { records.delete(key); } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostPendingQueuePanel queue={queue} onRestore={() => true} />));
    await act(async () => { await queue.refresh(); });
    const toggle = container.querySelector<HTMLButtonElement>('.host-pending-queue__toggle')!;
    const controlled = () => document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const count = () => container.querySelector('[data-openbitfun-part="totalCount"]')?.textContent;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(controlled().hidden).toBe(false);
    expect([...controlled().querySelectorAll('li')].map(row => row.textContent)).toEqual([
      expect.stringContaining('message a'), expect.stringContaining('message b'), expect.stringContaining('lost prompt'),
    ]);
    expect(count()).toBe('3');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(controlled().hidden).toBe(true);
    expect(controlled().querySelectorAll('li')).toHaveLength(0);
    expect(count()).toBe('3');
    const recovery = [...container.querySelectorAll('ul')].filter(list => list !== controlled());
    expect(recovery).toHaveLength(1);
    expect(recovery[0].hidden).toBe(false);
    const rows = recovery[0].querySelectorAll('li');
    expect([...rows].map(row => row.textContent)).toEqual([
      expect.stringContaining('hostQueue.blocked'), expect.stringContaining('hostQueue.unknown'),
    ]);
    expect(rows[0].querySelector('[aria-label="hostQueue.cancel"]')).not.toBeNull();
    expect(rows[1].querySelector('[aria-label="hostQueue.checkRetry"]')).not.toBeNull();
    expect(container.textContent).not.toContain('message a');

    await act(async () => toggle.click());
    expect(controlled().hidden).toBe(false);
    expect(controlled().querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('lets keyboard users read a truncated preview without starting an edit', async () => {
  const longText = 'Summarize the migration plan and list every follow-up owner';
  const requests: string[] = [];
  const queue = new HostDialogQueue('scope', 'session', async request => {
    requests.push(request.action);
    return { sessionId: 'session', queueEpoch: 'epoch', revision: 1, activeTurnId: 'active',
      items: [queueItem('a', 'queued', longText)], capacity: 20, used: 1, receipt: null };
  }, { list: async () => [], put: async () => {}, remove: async () => {} });
  const onRestore = vi.fn(() => true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-overflow') ? 100 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-overflow') || this.hasAttribute('data-overflow-content')
      ? (this.textContent?.length ?? 0) * 8 : 0;
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostPendingQueuePanel queue={queue} onRestore={onRestore} />));
    await act(async () => { await queue.refresh(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const preview = container.querySelector<HTMLElement>('[data-openbitfun-product-part="preview"]')!;
    expect(preview.tabIndex).toBe(0);
    expect(preview.getAttribute('role')).toBeNull();
    expect(preview.getAttribute('data-overflow')).toBe('true');
    const requestCount = requests.length;

    await act(async () => preview.focus());
    expect(document.activeElement).toBe(preview);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    const tooltips = document.querySelectorAll('[role="tooltip"]');
    expect(tooltips).toHaveLength(1);
    expect(tooltips[0].textContent).toBe(longText);

    await act(async () => {
      preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      preview.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      preview.click();
    });
    expect(onRestore).not.toHaveBeenCalled();
    expect(requests).toHaveLength(requestCount);
    expect(container.querySelectorAll('li')).toHaveLength(1);

    // Leaving the preview dismisses its tooltip; an action's own (hover)
    // tooltip then shows alone instead of stacking with the preview's.
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="hostQueue.edit"]')!;
    await act(async () => edit.focus());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    await act(async () => { edit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect([...document.querySelectorAll('[role="tooltip"]')].map(tooltip => tooltip.textContent)).toEqual(['hostQueue.edit']);
  } finally {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  }
});
