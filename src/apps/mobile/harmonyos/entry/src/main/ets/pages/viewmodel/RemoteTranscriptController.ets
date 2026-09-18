import {
  REMOTE_CAPABILITY_DIALOG_STEER_V1,
  REMOTE_CAPABILITY_PLAN_BUILD_V1,
  RemoteImageContext,
  RemoteQuestionAnswerPayload
} from '../../model/RemoteModels';
import { ChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatTimelineState, ChatTimelineStore } from '../../services/ChatTimelineStore';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { Encoding } from '../../services/Encoding';
import { RemoteChatPollingCursor, RemoteChatPollingSnapshot } from '../../services/RemoteChatPollingLifecycleController';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteUiState } from '../../services/RemoteUiState';
import { RemotePageState } from '../state/RemotePageState';
import {
  RemoteConversationDependencies,
  requireRemoteRuntime,
  shortSessionId
} from './ConversationRuntime';

/** Longest a streaming turn's transcript write is held back, in milliseconds. */
const REMOTE_TRANSCRIPT_CACHE_INTERVAL_MS: number = 400;

export class RemoteTranscriptController {
  private readonly remote: RemotePageState;
  private readonly remoteRuntime?: RemoteConversationDependencies;
  private readonly notify: (message: string) => void;
  private knownPollVersionValue: number = 0;
  private knownModelCatalogVersion: number = 0;
  private knownRemoteMessageCount: number = 0;
  private isSyncingAfterTurn: boolean = false;
  private isRebuildingRemoteTranscript: boolean = false;
  private pendingTranscriptCache: number = -1;

  constructor(
    remote: RemotePageState,
    remoteRuntime: RemoteConversationDependencies | undefined,
    notify: (message: string) => void
  ) {
    this.remote = remote;
    this.remoteRuntime = remoteRuntime;
    this.notify = notify;
  }

  knownPollVersion(): number {
    return this.knownPollVersionValue;
  }

  resetKnownRemoteState(): void {
    this.knownPollVersionValue = 0;
    this.knownModelCatalogVersion = 0;
    this.knownRemoteMessageCount = 0;
  }

  updateKnownMessageCount(pollVersion: number, knownMessageCount: number): void {
    this.knownRemoteMessageCount = knownMessageCount;
    this.updateChatPollingCursor(pollVersion, knownMessageCount);
  }

  updateKnownModelCatalogVersion(version: number): void {
    this.knownModelCatalogVersion = version;
    requireRemoteRuntime(this.remoteRuntime).polling.updateKnownModelCatalogVersion(version);
  }

  async loadRemoteMessages(): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.chat.loadMessages(
      this.remote.activeSession.sessionId || '',
      runtime.hooks.isConversationContext
    );
  }

  async selectRemoteModel(modelId: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.models.selectModel(
      modelId,
      this.remote.activeSession.sessionId || '',
      this.remote.isBusy,
      runtime.connection.ensureAvailable()
    );
  }

  async loadOlderRemoteMessages(): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.chat.loadOlderMessages(
      this.remote.activeSession.sessionId || '',
      this.knownPollVersionValue,
      this.remote.hasMoreMessages,
      this.remote.isBusy
    );
  }

  async sendRemoteMessage(): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    if (this.remote.isVoiceListening) {
      await runtime.hooks.stopVoiceInput();
    }
    const rawText = this.remote.chatInput.trim();
    const images = this.remote.selectedImages.slice();
    const text = rawText.length > 0 ? rawText :
      (images.length > 0 ? RemoteI18n.t('chat.analyzeImageDefault') : '');
    const sessionId = this.remote.activeSession.sessionId || '';
    if ((!text && images.length === 0) || !sessionId || this.remote.isBusy ||
      !runtime.connection.ensureAvailable()) {
      return;
    }
    const queuedBehindRunningTurn = this.hasRunningRemoteTurn();
    const activeTurnId = this.remoteActiveTurnId();
    const canSteerRunningTurn = queuedBehindRunningTurn && activeTurnId.length > 0 &&
      this.remote.supportsHostCapability(REMOTE_CAPABILITY_DIALOG_STEER_V1);
    const imageContexts: RemoteImageContext[] = images.length > 0 ?
      runtime.imagePicker.toRemoteContexts(images) : [];
    if (canSteerRunningTurn) {
      RemoteLogger.info(
        `chat steer requested session=${shortSessionId(sessionId)} turn=${shortSessionId(activeTurnId)}`
      );
      this.startRemotePolling();
      runtime.polling.nudge();
      await runtime.chat.steerPreparedMessage(
        sessionId,
        activeTurnId,
        text,
        rawText,
        images,
        imageContexts,
        this.remote.isBusy,
        true
      );
      return;
    }
    // Older desktop hosts do not advertise steering. Keep their established
    // queue behavior so mixed-version Remote Connect sessions remain usable.
    const clientTurnId = Encoding.randomId('harmony-turn');
    const localMessage = RemoteUiState.localUserMessage(text, images, clientTurnId);
    runtime.timeline.appendOptimisticMessage(localMessage);
    const pendingActiveId = runtime.timeline.setPendingActiveTurn(localMessage.id);
    this.syncRemoteTimeline();
    RemoteLogger.info(`chat send queued session=${shortSessionId(sessionId)} pending=${pendingActiveId} behindRunningTurn=${queuedBehindRunningTurn ? '1' : '0'}`);
    if (queuedBehindRunningTurn) {
      this.notify(RemoteI18n.t('chat.queuedAfterRunningTurn'));
    }
    this.startRemotePolling();
    runtime.polling.nudge();
    await runtime.chat.sendPreparedMessage(
      sessionId,
      text,
      this.remote.activeSession.agentType,
      rawText,
      images,
      imageContexts,
      localMessage.id,
      pendingActiveId,
      this.remote.isBusy,
      true,
      localMessage.turnId || ''
    );
  }

  async buildRemotePlan(planFilePath: string, planName: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const sessionId = this.remote.activeSession.sessionId || '';
    if (!this.remote.supportsHostCapability(REMOTE_CAPABILITY_PLAN_BUILD_V1)) {
      this.notify(RemoteI18n.t('chat.planBuildUnavailable'));
      return;
    }
    if (this.hasRunningRemoteTurn()) {
      this.notify(RemoteI18n.t('chat.planBuildWaitForTurn'));
      return;
    }
    if (planFilePath.trim().length === 0 || sessionId.length === 0 || this.remote.isBusy ||
      !runtime.connection.ensureAvailable()) {
      return;
    }
    const displayName = planName.trim().length > 0 ? planName.trim() : 'Plan';
    const localMessage = RemoteUiState.localUserMessage(`Build Plan: ${displayName}`);
    runtime.timeline.appendOptimisticMessage(localMessage);
    const pendingActiveId = runtime.timeline.setPendingActiveTurn(localMessage.id);
    this.syncRemoteTimeline();
    this.startRemotePolling();
    runtime.polling.nudge();
    await runtime.chat.buildPlan(
      sessionId,
      planFilePath.trim(),
      displayName,
      this.remote.activeSession.agentType,
      localMessage.id,
      pendingActiveId,
      this.remote.isBusy,
      true
    );
  }

  async stopRemoteTask(): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const sessionId = this.remote.activeSession.sessionId || '';
    if (!sessionId) {
      return;
    }
    await runtime.chat.stopTask(
      sessionId,
      this.remote.activeTurnMessage.id,
      this.remoteActiveTurnId(),
      runtime.connection.ensureAvailable()
    );
  }

  async renameRemoteSession(title: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const nextTitle = title.trim();
    if (!this.remote.activeSession.sessionId || nextTitle.length === 0 ||
      nextTitle === this.remote.activeSession.title || this.remote.isBusy) {
      return;
    }
    await runtime.chat.renameActiveSession(
      this.remote.activeSession,
      nextTitle,
      this.remote.isBusy,
      runtime.connection.ensureAvailable()
    );
  }

  async copyRemoteMessage(text: string): Promise<void> {
    if (text.trim().length === 0) {
      return;
    }
    try {
      await requireRemoteRuntime(this.remoteRuntime).clipboard.writeText(text);
      this.remote.setStatusText(RemoteI18n.t('status.messageCopied'));
    } catch (err) {
      this.remote.setStatusText(ConnectionErrorPolicy.errorText(err));
    }
  }

  async downloadRemoteFile(path: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.files.download(
      path,
      this.remote.activeSession.sessionId || '',
      this.remote.isBusy,
      runtime.connection.ensureAvailable()
    );
  }

  retryRemoteMessage(text: string): void {
    if (this.remote.isBusy || !requireRemoteRuntime(this.remoteRuntime).connection.ensureAvailable()) {
      return;
    }
    this.remote.setChatInput(text);
    this.sendRemoteMessage();
  }

  async approveRemoteTool(toolId: string, updatedInput?: Object): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.tools.approve(
      toolId, this.remote.activeSession.sessionId || '', runtime.connection.ensureAvailable(), updatedInput
    );
  }

  async rejectRemoteTool(toolId: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.tools.reject(
      toolId, this.remote.activeSession.sessionId || '', runtime.connection.ensureAvailable()
    );
  }

  async cancelRemoteTool(toolId: string): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.tools.cancel(
      toolId, this.remote.activeSession.sessionId || '', runtime.connection.ensureAvailable()
    );
  }

  async answerRemoteQuestion(toolId: string, answers: RemoteQuestionAnswerPayload): Promise<void> {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    await runtime.tools.answer(
      toolId, this.remote.activeSession.sessionId || '', runtime.connection.ensureAvailable(), answers
    );
  }

  resetRemoteTimeline(sessionId: string): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    if (this.pendingTranscriptCache !== -1) {
      clearTimeout(this.pendingTranscriptCache);
      this.pendingTranscriptCache = -1;
    }
    runtime.timeline.reset(sessionId);
    this.knownPollVersionValue = 0;
    this.syncRemoteTimeline();
  }

  syncRemoteTimeline(): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const state: ChatTimelineState = runtime.timeline.snapshotState();
    this.remote.setTimelineProjection(
      state.persistedMessages,
      state.optimisticMessages,
      state.activeTurn || RemoteUiState.emptyActiveTurn(),
      this.remote.hasMoreMessages,
      runtime.timeline.viewState(this.remote.hasMoreMessages)
    );
    this.remote.setModelCatalog(state.modelCatalog, state.selectedModelId);
  }

  startRemotePolling(): void {
    requireRemoteRuntime(this.remoteRuntime).polling.startActiveSession({
      sessionId: this.remote.activeSession.sessionId || '',
      cursor: this.currentChatPollingCursor(),
      activeTurn: this.remote.activeTurnMessage
    });
  }

  applyRemoteSnapshot(snapshot: RemoteChatPollingSnapshot): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    if (!runtime.hooks.isConversationContext(snapshot.sessionId)) {
      return;
    }
    if (snapshot.historyRewritten) {
      this.rebuildRemoteTranscript(snapshot.sessionId);
      return;
    }
    runtime.timeline.applySnapshot(snapshot);
    this.syncRemoteTimeline();
    if (snapshot.messageSnapshot !== undefined) {
      // A streaming turn restates the whole transcript on every chunk. Writing
      // all of it back each time re-encrypts the session dozens of times a
      // second for a cache nothing reads until the next open, so during a turn
      // only the last write of a burst is kept.
      if (this.hasRunningRemoteTurn()) this.scheduleTranscriptCache(snapshot.sessionId);
      else this.cacheTranscriptNow(snapshot.sessionId, true);
    } else if (snapshot.newMessages.length > 0) {
      this.cacheRemoteTranscript(snapshot.sessionId, false);
    }
    this.knownPollVersionValue = snapshot.cursor.pollVersion;
    this.knownModelCatalogVersion = snapshot.cursor.knownModelCatalogVersion;
    this.knownRemoteMessageCount = snapshot.cursor.knownMessageCount;
    if (snapshot.title.length > 0) {
      this.remote.setActiveSession({
        sessionId: this.remote.activeSession.sessionId,
        title: snapshot.title,
        workspacePath: this.remote.activeSession.workspacePath,
        remoteConnectionId: this.remote.activeSession.remoteConnectionId,
        agentType: this.remote.activeSession.agentType
      });
    }
    if (snapshot.modelCatalog) {
      runtime.models.applyCatalog(snapshot.modelCatalog);
    }
    this.remote.setStatusText(this.hasRunningRemoteTurn()
      ? RemoteI18n.t('status.desktopProcessing')
      : RemoteI18n.t('status.messagesSynced'));
    if (snapshot.shouldSyncAfterTurnEnded) {
      this.syncAfterRemoteTurnEnded();
    }
  }

  /**
   * Writes the transcript now on screen back to disk.
   *
   * Fire-and-forget on purpose: the snapshot is already rendered, and a cache
   * that cannot be written only costs the next open a fetch it used to pay for
   * anyway.
   */
  private scheduleTranscriptCache(sessionId: string): void {
    if (this.pendingTranscriptCache !== -1) return;
    this.pendingTranscriptCache = setTimeout(() => {
      this.pendingTranscriptCache = -1;
      this.cacheRemoteTranscript(sessionId, true);
    }, REMOTE_TRANSCRIPT_CACHE_INTERVAL_MS);
  }

  private cacheTranscriptNow(sessionId: string, authoritativeSnapshot: boolean): void {
    if (this.pendingTranscriptCache !== -1) {
      clearTimeout(this.pendingTranscriptCache);
      this.pendingTranscriptCache = -1;
    }
    this.cacheRemoteTranscript(sessionId, authoritativeSnapshot);
  }

  private cacheRemoteTranscript(sessionId: string, authoritativeSnapshot: boolean): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    const state: ChatTimelineState = runtime.timeline.snapshotState();
    if (authoritativeSnapshot) {
      runtime.chatCache.replaceSnapshot(sessionId, state.persistedMessages);
    } else {
      runtime.chatCache.syncIncremental(sessionId, state.persistedMessages);
    }
  }

  /**
   * Refetches a transcript the desktop no longer agrees with.
   *
   * Tails are handed out by index, so once the desktop reports fewer messages
   * than this session had counted there is no offset left that means the same
   * thing on both ends. Everything stored for the session goes, including the
   * poll cursor, which `reloadMessages` resets by way of `onMessageCountKnown`.
   */
  private rebuildRemoteTranscript(sessionId: string): void {
    const runtime = requireRemoteRuntime(this.remoteRuntime);
    if (this.isRebuildingRemoteTranscript) {
      return;
    }
    this.isRebuildingRemoteTranscript = true;
    RemoteLogger.info(`remote transcript rewritten upstream session=${shortSessionId(sessionId)}`);
    runtime.chatCache.forget(sessionId)
      .then((): Promise<void> => runtime.chat.reloadMessages(sessionId, runtime.hooks.isConversationContext))
      .then((): void => {
        this.isRebuildingRemoteTranscript = false;
      })
      .catch((): void => {
        this.isRebuildingRemoteTranscript = false;
      });
  }

  hasRunningRemoteTurn(): boolean {
    return this.remote.activeTurnMessage.id.length > 0 &&
      (this.remote.activeTurnMessage.status || '').toLowerCase() === 'active';
  }

  remoteActiveTurnId(): string {
    return ChatTimelineStore.cancelableTurnId(this.remote.activeTurnMessage);
  }

  projectedRemoteTimelineItems(): ChatTimelineItem[] {
    return requireRemoteRuntime(this.remoteRuntime).timeline.viewState(this.remote.hasMoreMessages);
  }

  private currentChatPollingCursor(): RemoteChatPollingCursor {
    return {
      pollVersion: this.knownPollVersionValue,
      knownMessageCount: this.knownRemoteMessageCount,
      knownModelCatalogVersion: this.knownModelCatalogVersion
    };
  }

  private updateChatPollingCursor(pollVersion: number, knownMessageCount: number): void {
    this.knownPollVersionValue = pollVersion;
    this.knownRemoteMessageCount = knownMessageCount;
    requireRemoteRuntime(this.remoteRuntime).polling.updateCursor({
      pollVersion,
      knownMessageCount,
      knownModelCatalogVersion: this.knownModelCatalogVersion
    });
  }

  private async syncAfterRemoteTurnEnded(): Promise<void> {
    if (this.isSyncingAfterTurn) {
      return;
    }
    this.isSyncingAfterTurn = true;
    try {
      // Deliberately not the cached path: this exists to pick up whatever the
      // desktop settled on after the turn finished, which is exactly what the
      // cache does not know yet.
      const runtime = requireRemoteRuntime(this.remoteRuntime);
      await runtime.chat.reloadMessages(
        this.remote.activeSession.sessionId || '',
        runtime.hooks.isConversationContext
      );
    } finally {
      this.isSyncingAfterTurn = false;
    }
  }

}
