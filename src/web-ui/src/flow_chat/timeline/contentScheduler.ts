type Priority = 'interaction' | 'visible' | 'background';
interface Work { run: () => void; cancelled: boolean; priority: Priority }
const priorities: Priority[] = ['interaction', 'visible', 'background'];

/** One cooperative queue for all desktop panes. A task must itself be bounded. */
export class FlowChatContentScheduler {
  private queue: Work[] = [];
  private scheduled = false;
  private channel: MessageChannel | undefined;

  schedule(run: () => void, priority: Priority = 'visible'): () => void {
    const work = { run, priority, cancelled: false };
    this.queue.push(work);
    this.request();
    return () => { work.cancelled = true; };
  }
  private request() {
    if (this.scheduled) return;
    this.scheduled = true;
    if (typeof MessageChannel === 'undefined') { setTimeout(() => this.flush(), 0); return; }
    if (!this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.flush();
    }
    this.channel.port2.postMessage(null);
  }
  private flush() {
    this.scheduled = false;
    const start = performance.now();
    // Alternate priorities each task turn, so streaming cannot starve queued
    // user requests or background disposal in another pane.
    for (const priority of priorities) {
      const index = this.queue.findIndex(work => !work.cancelled && work.priority === priority);
      if (index < 0) continue;
      const [work] = this.queue.splice(index, 1);
      work.run();
      if (performance.now() - start >= 4) break;
    }
    this.queue = this.queue.filter(work => !work.cancelled);
    if (this.queue.length) this.request();
  }
}
export const flowChatContentScheduler = new FlowChatContentScheduler();
