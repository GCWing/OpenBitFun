type ReadMeasurement = () => (() => void) | undefined;

interface MeasurementJob {
  read: ReadMeasurement;
  cancelled: boolean;
}
interface MeasurementQueue {
  pending: Map<ReadMeasurement, MeasurementJob>;
  active: Map<ReadMeasurement, MeasurementJob>;
  frame: number | null;
}

const queues = new WeakMap<Window, MeasurementQueue>();

/** Batch geometry reads before React state publication. Overflow UI may update
 * on the next frame; this is a scheduling contract, not a scroll speed guarantee.
 */
export function scheduleOverflowMeasurement(view: Window, read: ReadMeasurement): void {
  let queue = queues.get(view);
  if (!queue) {
    queue = { pending: new Map(), active: new Map(), frame: null };
    queues.set(view, queue);
  }
  // A new request supersedes any result already read in the current batch.
  const active = queue.active.get(read);
  if (active) active.cancelled = true;
  queue.pending.set(read, { read, cancelled: false });
  if (queue.frame !== null) return;
  const current = queue;
  current.frame = view.requestAnimationFrame(() => {
    current.frame = null;
    // Detach this batch so reentrant requests survive for the next frame.
    const batch = current.pending;
    current.pending = new Map();
    current.active = batch;
    const publications: Array<{ job: MeasurementJob; publish: () => void }> = [];
    const report = (error: unknown) => {
      // Preserve uncaught-error reporting without aborting other labels.
      view.setTimeout(() => { throw error; }, 0);
    };
    try {
      for (const job of batch.values()) {
        if (job.cancelled) continue;
        try {
          const publish = job.read();
          if (publish) publications.push({ job, publish });
        } catch (error) { report(error); }
      }
      for (const { job, publish } of publications) {
        if (job.cancelled) continue;
        try { publish(); } catch (error) { report(error); }
      }
    } finally {
      current.active = new Map();
    }
  });
}

export function cancelOverflowMeasurement(view: Window, read: ReadMeasurement): void {
  const queue = queues.get(view);
  if (!queue) return;
  const active = queue.active.get(read);
  if (active) active.cancelled = true;
  queue.pending.delete(read);
  if (queue.pending.size === 0 && queue.frame !== null) {
    view.cancelAnimationFrame(queue.frame);
    queue.frame = null;
  }
}
