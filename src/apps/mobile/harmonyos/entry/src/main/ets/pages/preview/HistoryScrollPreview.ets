import { ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatTimeline } from '../components/ChatTimeline';
import { INK, PAGE_BG } from '../components/Theme';

/** Hold a history response while exercising the production list's jump button. */
@ComponentV2
export struct HistoryScrollPreview {
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local loading: boolean = false;
  @Local failed: boolean = false;
  @Local compact: boolean = false;
  private page: number = 0;

  aboutToAppear(): void {
    this.rows = this.pageRows(0);
  }

  private pageRows(page: number): ObservableChatTimelineItem[] {
    const rows: ObservableChatTimelineItem[] = [];
    for (let index = 0; index < 20; index++) {
      const id = `page-${page}-row-${index}`;
      rows.push(new ObservableChatTimelineItem({
        id, type: 'user_message', isStreaming: false, isFinalizing: false,
        message: { id, role: 'user', text: `History probe ${id}`, status: 'completed', timestamp: `${index}` }
      }));
    }
    return rows;
  }

  private finish(failed: boolean): void {
    if (!this.loading) return;
    if (!failed) {
      this.page--;
      this.rows = this.pageRows(this.page).concat(this.rows);
      this.revision++;
    }
    this.failed = failed;
    this.loading = false;
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('Complete').id('history-complete').onClick(() => { this.finish(false); })
        Button('Fail').id('history-fail').onClick(() => { this.finish(true); })
        Button('Resize').id('history-resize').onClick(() => { this.compact = !this.compact; })
      }
      Text(`loading=${this.loading} failed=${this.failed} compact=${this.compact}`)
        .id('history-state').fontColor(INK)
      ChatTimeline({
        timelineItems: this.rows, timelineRevision: this.revision,
        hasMoreMessages: true, historyLoading: this.loading, historyFailed: this.failed,
        maxContentWidth: this.compact ? 360 : 0,
        onLoadOlder: () => { this.failed = false; this.loading = true; }
      })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
