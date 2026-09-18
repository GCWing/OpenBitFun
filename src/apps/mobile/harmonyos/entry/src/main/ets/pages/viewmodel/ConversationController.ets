import {
  RemoteQuestionAnswerPayload,
  RemoteSession,
  SelectedImageAttachment,
  SessionSummary
} from '../../model/RemoteModels';
import { ChatTimelineItem } from '../../model/ChatTimelineModels';
import { VoiceInputRouteSnapshot } from '../../services/VoiceInputLifecycleController';
import { AppRootRouteState } from '../navigation/AppRootRouteState';
import { AppRoute, AppRouteContract } from '../navigation/AppRouteContract';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { RemotePageState } from '../state/RemotePageState';
import { RemoteChatPollingSnapshot } from '../../services/RemoteChatPollingLifecycleController';
import {
  ConversationControllerHooks,
  RemoteConversationDependencies,
  RemoteConversationHooks
} from './ConversationRuntime';
import { RemoteCreateFlowController } from './RemoteCreateFlowController';
import { RemoteTranscriptController } from './RemoteTranscriptController';
import { VisibleConversationController } from './VisibleConversationController';

export {
  ConversationControllerHooks,
  RemoteConversationDependencies,
  RemoteConversationHooks
} from './ConversationRuntime';

/** Owns route-dependent composer state and delegates feature work. */
export class ConversationController {
  private readonly general: GeneralChatPageState;
  private readonly remote: RemotePageState;
  private readonly hooks: ConversationControllerHooks;
  private readonly remoteRuntime?: RemoteConversationDependencies;
  private readonly transcript: RemoteTranscriptController;
  private readonly createFlow: RemoteCreateFlowController;
  private readonly visible: VisibleConversationController;

  constructor(
    general: GeneralChatPageState,
    remote: RemotePageState,
    hooks: ConversationControllerHooks,
    remoteRuntime?: RemoteConversationDependencies
  ) {
    this.general = general;
    this.remote = remote;
    this.hooks = hooks;
    this.remoteRuntime = remoteRuntime;
    this.transcript = new RemoteTranscriptController(remote, remoteRuntime, (message: string) => {
      this.showHomeToast(message);
    });
    this.createFlow = new RemoteCreateFlowController(remote, remoteRuntime);
    this.visible = new VisibleConversationController(
      remote,
      remoteRuntime,
      this.transcript,
      this.createFlow,
      (route: AppRoute, value: string) => this.setChatInput(route, value),
      (statusText: string) => this.setVisibleStatusText(statusText),
      (message: string) => this.showHomeToast(message)
    );
  }

  visibleChatInput(): string {
    return AppRootRouteState.chatInput(this.hooks.currentRoute(), this.general, this.remote);
  }

  visibleSelectedImages(): SelectedImageAttachment[] {
    return AppRootRouteState.selectedImages(this.hooks.currentRoute(), this.general, this.remote);
  }

  visibleVoiceListening(): boolean {
    return AppRootRouteState.voiceListening(this.hooks.currentRoute(), this.general, this.remote);
  }

  setChatInput(route: AppRoute, value: string): void {
    AppRootRouteState.setChatInput(route, value, this.general, this.remote);
  }

  addSelectedImages(route: AppRoute, images: SelectedImageAttachment[]): void {
    AppRootRouteState.addSelectedImages(route, images, this.general, this.remote);
  }

  removeSelectedImage(route: AppRoute, imageId: string): void {
    AppRootRouteState.removeSelectedImage(route, imageId, this.general, this.remote);
  }

  setVoiceListening(route: AppRoute, isVoiceListening: boolean): void {
    AppRootRouteState.setVoiceListening(route, isVoiceListening, this.general, this.remote);
  }

  clearAllVoiceListening(): void {
    this.general.setVoiceListening(false);
    this.remote.setVoiceListening(false);
  }

  visibleBusy(): boolean {
    return this.isGeneralComposerRoute(this.hooks.currentRoute()) ?
      this.general.isBusy : this.remote.isBusy;
  }

  visibleStatusText(): string {
    return this.isGeneralComposerRoute(this.hooks.currentRoute()) ?
      this.general.statusText : this.remote.statusText;
  }

  setVisibleStatusText(statusText: string): void {
    if (this.isGeneralComposerRoute(this.hooks.currentRoute())) {
      this.general.setStatus(statusText);
      return;
    }
    this.remote.setStatusText(statusText);
  }

  voiceInputSnapshot(route: AppRoute): VoiceInputRouteSnapshot {
    return AppRootRouteState.snapshot(route, this.visibleBusy(), this.general, this.remote);
  }

  isGeneralComposerRoute(route: AppRoute): boolean {
    return AppRouteContract.isGeneralComposerRoute(route);
  }

  knownPollVersion(): number { return this.transcript.knownPollVersion(); }
  resetKnownRemoteState(): void { this.transcript.resetKnownRemoteState(); }
  updateKnownMessageCount(pollVersion: number, knownMessageCount: number): void {
    this.transcript.updateKnownMessageCount(pollVersion, knownMessageCount);
  }
  updateKnownModelCatalogVersion(version: number): void {
    this.transcript.updateKnownModelCatalogVersion(version);
  }
  async loadRemoteMessages(): Promise<void> { await this.transcript.loadRemoteMessages(); }
  async selectRemoteModel(modelId: string): Promise<void> { await this.transcript.selectRemoteModel(modelId); }
  async loadOlderRemoteMessages(): Promise<void> { await this.transcript.loadOlderRemoteMessages(); }
  async sendRemoteMessage(): Promise<void> { await this.transcript.sendRemoteMessage(); }
  async buildRemotePlan(path: string, name: string): Promise<void> {
    await this.transcript.buildRemotePlan(path, name);
  }
  async stopRemoteTask(): Promise<void> { await this.transcript.stopRemoteTask(); }
  async renameRemoteSession(title: string): Promise<void> { await this.transcript.renameRemoteSession(title); }
  async copyRemoteMessage(text: string): Promise<void> { await this.transcript.copyRemoteMessage(text); }
  async downloadRemoteFile(path: string): Promise<void> { await this.transcript.downloadRemoteFile(path); }
  retryRemoteMessage(text: string): void { this.transcript.retryRemoteMessage(text); }
  async approveRemoteTool(toolId: string, updatedInput?: Object): Promise<void> {
    await this.transcript.approveRemoteTool(toolId, updatedInput);
  }
  async rejectRemoteTool(toolId: string): Promise<void> { await this.transcript.rejectRemoteTool(toolId); }
  async cancelRemoteTool(toolId: string): Promise<void> { await this.transcript.cancelRemoteTool(toolId); }
  async answerRemoteQuestion(toolId: string, answers: RemoteQuestionAnswerPayload): Promise<void> {
    await this.transcript.answerRemoteQuestion(toolId, answers);
  }
  resetRemoteTimeline(sessionId: string): void { this.transcript.resetRemoteTimeline(sessionId); }
  syncRemoteTimeline(): void { this.transcript.syncRemoteTimeline(); }
  startRemotePolling(): void { this.transcript.startRemotePolling(); }
  applyRemoteSnapshot(snapshot: RemoteChatPollingSnapshot): void {
    this.transcript.applyRemoteSnapshot(snapshot);
  }
  hasRunningRemoteTurn(): boolean { return this.transcript.hasRunningRemoteTurn(); }
  remoteActiveTurnId(): string { return this.transcript.remoteActiveTurnId(); }
  projectedRemoteTimelineItems(): ChatTimelineItem[] { return this.transcript.projectedRemoteTimelineItems(); }

  async createRemoteSession(agentType: string, inPlace: boolean = false): Promise<void> {
    await this.createFlow.createRemoteSession(agentType, inPlace);
  }
  async createRemoteSessionInWorkspace(
    path: string,
    agentType: string = 'code',
    inPlace: boolean = false,
    deviceId: string = '',
    remoteConnectionId?: string,
    remoteSshHost?: string,
    workspaceId?: string
  ): Promise<void> {
    await this.createFlow.createRemoteSessionInWorkspace(path, agentType, inPlace, deviceId, remoteConnectionId, remoteSshHost, workspaceId);
  }

  async ensureRemoteControlTarget(deviceId?: string): Promise<void> {
    await this.createFlow.ensureRemoteControlTarget(deviceId);
  }
  async openRemoteSession(item: RemoteSession, inPlace: boolean = false): Promise<void> {
    await this.createFlow.openRemoteSession(item, inPlace);
  }
  applyRemoteActiveSession(session: SessionSummary): void {
    this.createFlow.applyRemoteActiveSession(session);
  }
  async deleteRemoteSession(item: RemoteSession): Promise<void> {
    await this.createFlow.deleteRemoteSession(item);
  }
  routeCreatedRemoteSession(sessionId: string): void {
    this.createFlow.routeCreatedRemoteSession(sessionId);
  }

  openHomeSession(session: RemoteSession, inPlace: boolean = false): void {
    this.visible.openHomeSession(session, inPlace);
  }
  async deleteHomeSession(session: RemoteSession): Promise<void> { await this.visible.deleteHomeSession(session); }
  async sendVisibleMessage(): Promise<void> { await this.visible.sendVisibleMessage(); }
  async stopVisibleTask(): Promise<void> { await this.visible.stopVisibleTask(); }
  closeActiveChat(): void { this.visible.closeActiveChat(); }
  async renameVisibleSession(title: string): Promise<void> { await this.visible.renameVisibleSession(title); }
  async retryVisibleMessage(text: string): Promise<void> { await this.visible.retryVisibleMessage(text); }
  downloadVisibleFile(path: string): void { this.visible.downloadVisibleFile(path); }
  async selectVisibleModel(modelId: string): Promise<void> { await this.visible.selectVisibleModel(modelId); }
  onVisibleChatInputChange(route: AppRoute, value: string): void {
    this.visible.onVisibleChatInputChange(route, value);
  }
  latestUserMessageText(): string { return this.visible.latestUserMessageText(); }
  showHomeToast(message: string): void { this.visible.showHomeToast(message); }
}
