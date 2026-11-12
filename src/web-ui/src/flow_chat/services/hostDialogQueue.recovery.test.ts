import { describe, expect, it } from 'vitest';
import {
  HostDialogQueue,
  type QueueOutboxRecord,
  type QueueRequest,
  type QueueSnapshot,
} from '../../../../shared/dialog-queue/HostDialogQueue';

const message = { content: 'continue', agentType: 'Standard', attachments: [], metadata: {} };

function fixture(options?: ConstructorParameters<typeof HostDialogQueue>[4]) {
  const records = new Map<string, QueueOutboxRecord>();
  const receipts = new Map<string, QueueSnapshot['items'][number]>();
  const calls: QueueRequest[] = [];
  let epoch = 'owner-1';
  let loseSubmit: 'after-accept' | 'before-accept' | null = null;
  const snapshot = (receipt: QueueSnapshot['receipt']): QueueSnapshot => ({
    sessionId: 'session-a', queueEpoch: epoch, revision: receipts.size, activeTurnId: 'running',
    items: [...receipts.values()].filter(item => item.status === 'queued'),
    capacity: 20, used: receipts.size, receipt,
  });
  const invoke = async (request: QueueRequest): Promise<QueueSnapshot> => {
    calls.push(structuredClone(request));
    if (request.action === 'submit') {
      if (loseSubmit === 'before-accept') { loseSubmit = null; throw new Error('Connection lost'); }
      receipts.set(request.message.turnId, {
        turnId: request.message.turnId, displayContent: request.message.content, previewTruncated: false,
        attachmentCount: 0, agentType: 'Standard', createdAtMs: 1, status: 'queued', reason: null,
        targetTurnId: null, steeringId: null,
      });
      if (loseSubmit === 'after-accept') { loseSubmit = null; throw new Error('outcome_unknown: reply lost'); }
      return snapshot(receipts.get(request.message.turnId)!);
    }
    if (request.action === 'get') return snapshot(receipts.get(request.turnId) ?? null);
    return snapshot(null);
  };
  const storage = {
    list: async (scope: string) => [...records.values()].filter(record => record.scope === scope),
    put: async (record: QueueOutboxRecord) => { records.set(record.key, structuredClone(record)); },
    remove: async (key: string) => { records.delete(key); },
  };
  return {
    records, receipts, calls,
    create: () => new HostDialogQueue('scope', 'session-a', invoke, storage, options),
    lose: (when: 'after-accept' | 'before-accept') => { loseSubmit = when; },
    restart: () => { epoch = 'owner-2'; receipts.clear(); },
  };
}

describe('HostDialogQueue recovery', () => {
  it('confirms an unacknowledged submit on refresh when the owner has its receipt', async () => {
    const f = fixture({ resolveUnconfirmed: true });
    const queue = f.create();
    f.lose('after-accept');
    await expect(queue.submit(message)).rejects.toThrow('outcome_unknown');
    expect(queue.getSnapshot().pending).toHaveLength(1);

    await queue.refresh();
    expect(queue.getSnapshot().pending).toEqual([]);
    expect([...f.records.values()][0].accepted).toBe(true);
    expect(f.calls.filter(call => call.action === 'submit')).toHaveLength(1);
  });

  it('records a definite not-sent outcome separately and clears it on retry', async () => {
    const f = fixture({ resolveUnconfirmed: true });
    const queue = f.create();
    f.lose('before-accept');
    await expect(queue.submit(message)).rejects.toThrow('Connection lost');

    await queue.refresh();
    const [pending] = queue.getSnapshot().pending;
    expect(pending.notSubmitted).toBe(true);

    await queue.retry(pending);
    expect(queue.getSnapshot().pending).toEqual([]);
    const [stored] = f.records.values();
    expect(stored.accepted).toBe(true);
    expect(stored.notSubmitted).toBeUndefined();
    // The retry reused the original Turn id.
    const submits = f.calls.filter((call): call is Extract<QueueRequest, { action: 'submit' }> => call.action === 'submit');
    expect(submits).toHaveLength(2);
    expect(submits[1].message.turnId).toBe(submits[0].message.turnId);
  });

  it('keeps existing callers on explicit recovery without receipt reads', async () => {
    const f = fixture();
    const queue = f.create();
    f.lose('after-accept');
    await expect(queue.submit(message)).rejects.toThrow();
    await queue.refresh();
    expect(queue.getSnapshot().pending).toHaveLength(1);
    expect(f.calls.some(call => call.action === 'get')).toBe(false);
  });

  it('drops records of messages that already ran after an owner restart', async () => {
    const ran = new Set<string>();
    const f = fixture({ hasTurn: turnId => ran.has(turnId) });
    const queue = f.create();
    await queue.submit(message, undefined, 'ran-turn');
    await queue.submit({ ...message, content: 'later' }, undefined, 'queued-turn');
    ran.add('ran-turn');
    f.restart();
    await queue.refresh();
    // Only the message without a transcript Turn needs a delivery decision.
    expect(queue.getSnapshot().pending.map(record => record.request.action === 'submit'
      && record.request.message.turnId)).toEqual(['queued-turn']);
    expect([...f.records.keys()].some(key => key.includes('ran-turn'))).toBe(false);
  });

  it('reads records written by older builds without the not-sent field', async () => {
    const f = fixture({ resolveUnconfirmed: true });
    const queue = f.create();
    const legacy: QueueOutboxRecord = JSON.parse(JSON.stringify({
      key: JSON.stringify(['scope', 'legacy-turn']), scope: 'scope', draft: { text: 'legacy' },
      request: { sessionId: 'session-a', queueEpoch: 'owner-1', action: 'submit', message: { ...message, turnId: 'legacy-turn' } },
    }));
    f.records.set(legacy.key, legacy);
    await queue.refresh();
    expect(queue.getSnapshot().pending[0].notSubmitted).toBe(true);
    expect(queue.getSnapshot().pending[0].draft).toEqual({ text: 'legacy' });
  });
});
