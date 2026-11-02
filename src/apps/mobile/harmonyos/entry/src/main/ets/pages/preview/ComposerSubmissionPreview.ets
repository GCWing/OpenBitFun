import { RemoteChatCommandClient, RemoteChatCommandController } from '../../services/RemoteChatCommandController';
import { RemoteChatCache, RemoteChatCacheStore, RemoteChatCacheSlice } from '../../services/RemoteChatCache';
import { SessionRolledBackResult, SteerTurnResult } from '../../model/RemoteModels';
import { ComposerBar, ComposerPresentation } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';

class PendingSubmissionClient implements RemoteChatCommandClient {
  complete: (value: string) => void = () => {};
  async sendMessage(): Promise<string> { return new Promise<string>((resolve) => { this.complete = resolve; }); }
  async sendMessageWithImages(): Promise<string> { return this.sendMessage(); }
  async steerTurn(): Promise<SteerTurnResult> { throw new Error('Unused preview operation'); }
  async buildPlan(): Promise<string> { throw new Error('Unused preview operation'); }
  async cancelTask(): Promise<void> {}
  async renameSession(): Promise<void> {}
  // The preview exercises submission timing only, and a rollback it never raises
  // must not be answerable by a fake success: it throws like the other unused
  // operations, so a future preview that reaches it fails loudly.
  async rollbackSessionToTurn(): Promise<SessionRolledBackResult> {
    throw new Error('Unused preview operation');
  }
}

class InMemoryPreviewCache implements RemoteChatCacheStore {
  async init(_context: Context): Promise<void> {}
  async loadSlice(): Promise<RemoteChatCacheSlice> { return { messages: [], lastMessageId: '' }; }
  async appendMessages(): Promise<void> {}
  async replaceMessages(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async pruneSessions(): Promise<void> {}
  async clearAll(): Promise<void> {}
}

/** Real composer and command owner with a manually acknowledged, network-free send. */
@ComponentV2
export struct ComposerSubmissionPreview {
  @Local draft: string = 'Submission timing probe';
  @Local bubble: string = '';
  @Local busy: boolean = false;
  @Local acknowledged: boolean = false;
  @Local wide: boolean = false;
  private client: PendingSubmissionClient = new PendingSubmissionClient();
  private command: RemoteChatCommandController = new RemoteChatCommandController(this.client, {
    onMessagesLoaded: () => {}, onMessageCountKnown: () => {}, onTimelineReady: () => {},
    onComposerPrepared: () => ({ commit: () => { this.draft = ''; }, rollback: () => {} }),
    onSendSucceeded: () => { this.acknowledged = true; }, onSendFailed: () => {},
    onActiveSession: () => {}, onSessionTitleChanged: () => {}, onStatusText: () => {},
    onToast: () => {}, onBusy: (value: boolean) => { this.busy = value; }, onPollRequested: () => {}
  }, new RemoteChatCache(new InMemoryPreviewCache(), () => 'preview'));

  build() {
    Column({ space: 12 }) {
      Button('Acknowledge').id('submission-ack').onClick(() => { this.client.complete('preview-turn'); })
      Button('Next draft').id('submission-next').onClick(() => { this.draft = 'Next draft'; })
      Text(this.acknowledged ? 'Acknowledged' : 'Pending acknowledgment').id('submission-state').fontColor(INK)
      Text(this.bubble).id('submission-bubble').fontColor(INK)
      Blank()
      ComposerBar({ presentation: this.wide ? ComposerPresentation.Floating : ComposerPresentation.Compact,
        chatInput: this.draft, isBusy: this.busy,
        onChatInputChange: (value: string) => { this.draft = value; },
        onSend: () => {
          const text = this.draft;
          this.bubble = text;
          void this.command.sendPreparedMessage('preview-session', text, 'code', text, [], [], 'preview-message', '', false, true);
        }
      })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
      .onAreaChange((_old: Area, area: Area) => { this.wide = Number(area.width) >= 600; })
  }
}
