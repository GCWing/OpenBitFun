import { RemoteSession } from '../../model/RemoteModels';
import { AppRoute } from '../navigation/AppRouteContract';
import { RemotePageState } from '../state/RemotePageState';
import { CommandPaletteRequest } from '../actions/ConversationIntent';
import { RemoteConversationDependencies, requireRemoteRuntime } from './ConversationRuntime';
import { RemoteCreateFlowController } from './RemoteCreateFlowController';
import { RemoteTranscriptController } from './RemoteTranscriptController';

/** All visible conversation operations execute on the selected remote host. */
export class VisibleConversationController {
  private readonly remote: RemotePageState;
  private readonly remoteRuntime: RemoteConversationDependencies | undefined;
  private readonly transcript: RemoteTranscriptController;
  private readonly createFlow: RemoteCreateFlowController;
  private readonly setChatInputRef: (route: AppRoute, value: string) => void;
  private readonly setVisibleStatusTextRef: (text: string) => void;
  private readonly notify: (text: string) => void;

  constructor(
    remote: RemotePageState,
    remoteRuntime: RemoteConversationDependencies | undefined,
    transcript: RemoteTranscriptController,
    createFlow: RemoteCreateFlowController,
    setChatInputRef: (route: AppRoute, value: string) => void,
    setVisibleStatusTextRef: (text: string) => void,
    notify: (text: string) => void
  ) {
    this.remote = remote;
    this.remoteRuntime = remoteRuntime;
    this.transcript = transcript;
    this.createFlow = createFlow;
    this.setChatInputRef = setChatInputRef;
    this.setVisibleStatusTextRef = setVisibleStatusTextRef;
    this.notify = notify;
  }

  openHomeSession(session: RemoteSession, inPlace: boolean = false): void {
    requireRemoteRuntime(this.remoteRuntime).filePreview.close();
    void this.createFlow.openRemoteSession(session, inPlace).catch((err: Object) => {
      this.notify(err instanceof Error ? err.message : String(err));
    });
  }

  async deleteHomeSession(session: RemoteSession): Promise<void> {
    await this.createFlow.deleteRemoteSession(session);
  }

  async sendVisibleMessage(): Promise<void> { await this.transcript.sendRemoteMessage(); }
  async stopVisibleTask(): Promise<void> { await this.transcript.stopRemoteTask(); }
  async renameVisibleSession(title: string): Promise<void> { await this.transcript.renameRemoteSession(title); }
  async retryVisibleMessage(text: string): Promise<void> { this.transcript.retryRemoteMessage(text); }
  downloadVisibleFile(path: string): void { void this.transcript.downloadRemoteFile(path); }
  async selectVisibleModel(modelId: string): Promise<void> { await this.transcript.selectRemoteModel(modelId); }

  async dispatchCommandPalette(request: CommandPaletteRequest): Promise<void> {
    await this.transcript.dispatchCommandPalette(request);
  }

  closeActiveChat(): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    runtime.filePreview.close();
    void runtime.hooks.stopVoiceInput();
    runtime.polling.stop();
    this.remote.setConversationDismissed(true);
    runtime.appShell.replaceRouteWithoutAnimation(AppRoute.RemoteHome);
  }

  onVisibleChatInputChange(route: AppRoute, value: string): void {
    this.setChatInputRef(route, value);
  }

  latestUserMessageText(): string {
    const candidates = this.remote.persistedMessages.concat(this.remote.optimisticMessages);
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (candidates[index].role === 'user' && candidates[index].text.trim().length > 0) {
        return candidates[index].text;
      }
    }
    return '';
  }

  showHomeToast(message: string): void {
    if (!requireRemoteRuntime(this.remoteRuntime).hooks.showToast(message)) {
      this.setVisibleStatusTextRef(message);
    }
  }
}
