import type { QueueItem, QueueSnapshot } from '../../../../shared/dialog-queue/HostDialogQueue';
import type { VirtualItem } from '../types/flow-chat-projection';

type UserRow = Extract<VirtualItem, { type: 'user-message' }>;

/** Pure display reconciliation. Queue receipts are not canonical history writes. */
export class HostQueueProjection {
  private epoch?: string;
  private accepted = new Map<string, QueueItem>();
  private adopted = new Set<string>();
  private keys = new Map<string, string>();
  private rows = new Map<string, { item: QueueItem; row: UserRow }>();
  private canonicalRows = new WeakMap<UserRow, UserRow>();

  project(sources: VirtualItem[], snapshot: QueueSnapshot | null) {
    if (this.epoch !== snapshot?.queueEpoch) {
      this.epoch = snapshot?.queueEpoch;
      this.accepted.clear(); this.adopted.clear(); this.keys.clear(); this.rows.clear();
      this.canonicalRows = new WeakMap();
    }
    if (!snapshot) return { items: sources, hidden: [] as string[], missing: [] as string[] };
    for (const item of [...snapshot.items, ...(snapshot.receipt ? [snapshot.receipt] : [])]) {
      if (item.status === 'cancelled' || item.status === 'failed' || item.status === 'interrupted') {
        this.accepted.delete(item.turnId);
        continue;
      }
      if (!item.steeringDisplay || !item.steeringDisplay.targetTurnId
        || typeof item.steeringDisplay.content !== 'string') continue;
      this.accepted.set(item.turnId, item);
    }
    const canonical = new Set(sources.filter(item => item.type === 'user-message' && !item.submissionPhase).map(item => item.turnId));
    for (const id of canonical) if (this.accepted.has(id)) this.adopted.add(id);
    // Legacy inline receipts may still arrive from a compatible host.
    for (const source of sources) if (source.type === 'user-steering-message') {
      for (const item of this.accepted.values()) if (item.steeringId === source.steeringId) this.adopted.add(item.turnId);
    }
    const byTarget = new Map<string, UserRow[]>();
    const hidden: string[] = [];
    const missing: string[] = [];
    const present = new Set(snapshot.items.map(item => item.turnId));
    const sourceTurns = new Set(sources.map(item => item.turnId));
    const lastIndexes = new Map(sources.map((item, index) => [item.turnId, index]));
    let latestCanonicalTurn: string | undefined;
    for (const source of sources) {
      if (!(source.type === 'user-message' && source.submissionPhase)) latestCanonicalTurn = source.turnId;
    }
    for (const item of this.accepted.values()) {
      if (this.adopted.has(item.turnId)) {
        if (present.has(item.turnId)) hidden.push(item.turnId);
        continue;
      }
      const display = item.steeringDisplay!;
      const failed = item.status === 'blocked';
      if (!sourceTurns.has(display.targetTurnId)
        && (failed || !snapshot.activeTurnId || !sourceTurns.has(snapshot.activeTurnId))) continue;
      if (!present.has(item.turnId) && item.status !== 'started' && item.status !== 'completed' && item.status !== 'steered') {
        missing.push(item.turnId);
      }
      const cached = this.rows.get(item.turnId);
      // Snapshot polling should not remount or invalidate identical preview leaves.
      const row = cached && JSON.stringify(cached.item) === JSON.stringify(item) ? cached.row : {
        type: 'user-message' as const,
        turnId: item.turnId,
        presentationKey: `host-queue-user:${snapshot.queueEpoch}:${item.turnId}`,
        data: { id: `host_queue_${item.turnId}`, content: display.content, timestamp: item.createdAtMs,
          metadata: display.composerPresentation ? { composerPresentation: display.composerPresentation } : undefined },
        hostQueueStatus: failed ? 'failed' as const : 'pending' as const,
        hostQueueAttachmentCount: item.attachmentCount,
      };
      this.rows.set(item.turnId, { item, row });
      this.keys.set(item.turnId, row.presentationKey!);
      // Pending user Turns follow all admitted work. If the first of several
      // steering messages has started, the remaining previews follow its round
      // rather than jumping ahead of that first message.
      const anchor = !failed && latestCanonicalTurn ? latestCanonicalTurn : display.targetTurnId;
      const targetRows = byTarget.get(anchor) ?? [];
      targetRows.push(row); byTarget.set(anchor, targetRows);
      if (!failed && present.has(item.turnId)) hidden.push(item.turnId);
    }
    if (!byTarget.size && !this.keys.size) return { items: sources, hidden, missing };
    const items: VirtualItem[] = [];
    sources.forEach((source, index) => {
      const key = source.type === 'user-message' ? this.keys.get(source.turnId) : undefined;
      if (!(source.type === 'user-message' && source.submissionPhase && key)) {
        if (key && source.type === 'user-message') {
          let row = this.canonicalRows.get(source);
          if (!row) { row = { ...source, presentationKey: key }; this.canonicalRows.set(source, row); }
          items.push(row);
        } else items.push(source);
      }
      if (lastIndexes.get(source.turnId) === index) {
        items.push(...(byTarget.get(source.turnId) ?? []));
      }
    });
    return { items, hidden, missing };
  }
}
