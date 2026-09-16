import {
  ChatMessage,
  RemoteImageContext,
  SelectedImageAttachment,
  SteerTurnResult,
  SessionSummary
} from '../model/RemoteModels';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { ConnectionErrorPolicy } from './ConnectionErrorPolicy';
import { RemoteChatCache } from './RemoteChatCache';
import { RemoteLogger } from './RemoteLogger';

export interface RemoteChatCommandClient {
  sendMessage(sessionId: string, text: string, agentType?: string, turnId?: string): Promise<string>;
  sendMessageWithImages(
    sessionId: string,
    text: string,
    agentType: string,
    imageContexts: RemoteImageContext[],
    turnId?: string
  ): Promise<string>;
  steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    displayContent: string,
    imageContexts: RemoteImageContext[]
  ): Promise<SteerTurnResult>;
  buildPlan(sessionId: string, planFilePath: string, planName: string, agentType: string): Promise<string>;
  cancelTask(sessionId: string, turnId?: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
}

export interface RemoteChatCommandCallbacks {
  onMessagesLoaded: (messages: ChatMessage[], hasMoreMessages: boolean) => void;
  onMessageCountKnown: (pollVersion: number, knownMessageCount: number) => void;
  // Raised once the transcript is on screen, which for a cached session is
  // before any request has been sent. Without it the loading skeleton would
  // outlive the messages it is standing in for.
  onTimelineReady: () => void;
  onComposerSubmitted?: (sessionId: string, text: string, images: SelectedImageAttachment[]) => void;
  onSendSucceeded: (turnId: string, pendingActiveId: string, localMessageId: string) => void;
  onSteerSucceeded?: (
    steeringId: string,
    turnId: string,
    displayText: string,
    images: SelectedImageAttachment[]
  ) => void;
  onSendFailed: (
    rawText: string,
    images: SelectedImageAttachment[],
    localMessageId: string,
    pendingActiveId: string
  ) => void;
  onActiveSession: (session: SessionSummary) => void;
  onSessionTitleChanged: (sessionId: string, title: string) => void;
  onStatusText: (statusText: string) => void;
  // The status line is only rendered while the link is down, so anything the
  // user asked for and did not get has to be said out loud instead.
  onToast: (message: string) => void;
  onBusy: (isBusy: boolean) => void;
  onPollRequested: () => void;
  onHistoryRequested?: (sessionId: string, older: boolean) => void;
}

export class RemoteChatCommandController {
  private readonly client: RemoteChatCommandClient;
  private readonly callbacks: RemoteChatCommandCallbacks;
  private readonly cache: RemoteChatCache;
  constructor(
    client: RemoteChatCommandClient,
    callbacks: RemoteChatCommandCallbacks,
    cache: RemoteChatCache
  ) {
    this.client = client;
    this.callbacks = callbacks;
    this.cache = cache;
  }

  private static shortId(value: string): string {
    if (value.length <= 10) return value;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  /** All history reads share the durable record collection and its cursor. */
  async loadMessages(sessionId: string, canApply: (sessionId: string) => boolean): Promise<void> {
    if (!sessionId || !canApply(sessionId)) return;
    this.requestHistory(sessionId, false);
  }

  async reloadMessages(sessionId: string, canApply: (sessionId: string) => boolean): Promise<void> {
    if (!sessionId || !canApply(sessionId)) return;
    this.requestHistory(sessionId, false);
  }

  async forgetMessages(sessionId: string): Promise<void> { await this.cache.forget(sessionId); }

  async loadOlderMessages(sessionId: string, _currentPollVersion: number,
    hasMoreMessages: boolean, _isBusy: boolean): Promise<void> {
    // Active generation does not prevent reading earlier durable records.
    if (!sessionId || !hasMoreMessages) return;
    this.requestHistory(sessionId, true);
  }

  private requestHistory(sessionId: string, older: boolean): void {
    if (!this.callbacks.onHistoryRequested) throw new Error('Durable session history provider is unavailable');
    this.callbacks.onHistoryRequested(sessionId, older);
  }

  async sendPreparedMessage(
    sessionId: string,
    text: string,
    agentType: string,
    rawText: string,
    images: SelectedImageAttachment[],
    imageContexts: RemoteImageContext[],
    localMessageId: string,
    pendingActiveId: string,
    isBusy: boolean,
    remoteAvailable: boolean,
    clientTurnId: string = ''
  ): Promise<void> {
    if ((text.length === 0 && images.length === 0) || sessionId.length === 0 || isBusy || !remoteAvailable) {
      return;
    }
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onStatusText(images.length > 0 ? RemoteI18n.t('status.sendImage') : RemoteI18n.t('status.sendCommand'));
      const requestedTurnId = clientTurnId.trim().length > 0 ? clientTurnId : localMessageId;
      const turnId = images.length > 0 ?
        await this.client.sendMessageWithImages(sessionId, text, agentType, imageContexts, requestedTurnId) :
        await this.client.sendMessage(sessionId, text, agentType, requestedTurnId);
      this.callbacks.onComposerSubmitted?.(sessionId, rawText, images);
      this.callbacks.onSendSucceeded(turnId, pendingActiveId, localMessageId);
      this.callbacks.onStatusText(RemoteI18n.t('status.sentWaiting'));
    } catch (err) {
      this.callbacks.onSendFailed(rawText, images, localMessageId, pendingActiveId);
      this.callbacks.onStatusText(ConnectionErrorPolicy.errorText(err));
    } finally {
      this.callbacks.onBusy(false);
    }
  }

  async steerPreparedMessage(
    sessionId: string,
    turnId: string,
    text: string,
    displayText: string,
    images: SelectedImageAttachment[],
    imageContexts: RemoteImageContext[],
    isBusy: boolean,
    remoteAvailable: boolean
  ): Promise<void> {
    if ((text.length === 0 && images.length === 0) || sessionId.length === 0 || turnId.length === 0 ||
      isBusy || !remoteAvailable) {
      return;
    }
    try {
      this.callbacks.onBusy(true);
      const result = await this.client.steerTurn(
        sessionId,
        turnId,
        text,
        displayText,
        imageContexts
      );
      this.callbacks.onComposerSubmitted?.(sessionId, displayText, images);
      if (this.callbacks.onSteerSucceeded) {
        this.callbacks.onSteerSucceeded(result.steeringId, result.turnId, displayText, images);
      }
      this.callbacks.onStatusText(RemoteI18n.t('status.sentWaiting'));
      this.callbacks.onPollRequested();
    } catch (err) {
      this.callbacks.onSendFailed(displayText, images, '', '');
      const errorText = ConnectionErrorPolicy.errorText(err);
      this.callbacks.onStatusText(errorText);
      this.callbacks.onToast(errorText);
    } finally {
      this.callbacks.onBusy(false);
    }
  }

  async buildPlan(
    sessionId: string,
    planFilePath: string,
    planName: string,
    agentType: string,
    localMessageId: string,
    pendingActiveId: string,
    isBusy: boolean,
    remoteAvailable: boolean
  ): Promise<void> {
    if (sessionId.length === 0 || planFilePath.length === 0 || isBusy || !remoteAvailable) {
      return;
    }
    try {
      this.callbacks.onBusy(true);
      const turnId = await this.client.buildPlan(sessionId, planFilePath, planName, agentType);
      this.callbacks.onSendSucceeded(turnId, pendingActiveId, localMessageId);
      this.callbacks.onStatusText(RemoteI18n.t('status.sentWaiting'));
      this.callbacks.onPollRequested();
    } catch (err) {
      this.callbacks.onSendFailed('', [], localMessageId, pendingActiveId);
      const errorText = ConnectionErrorPolicy.errorText(err);
      this.callbacks.onStatusText(errorText);
      this.callbacks.onToast(errorText);
    } finally {
      this.callbacks.onBusy(false);
    }
  }

  async stopTask(
    sessionId: string,
    activeTurnMessageId: string,
    activeTurnId: string,
    remoteAvailable: boolean
  ): Promise<void> {
    RemoteLogger.info(`stop task requested session=${RemoteChatCommandController.shortId(sessionId)} turn=${RemoteChatCommandController.shortId(activeTurnId)} active=${activeTurnMessageId.length > 0 ? '1' : '0'}`);
    if (sessionId.length === 0 || !remoteAvailable) {
      return;
    }
    if (activeTurnMessageId.length === 0) {
      const nothingRunning = RemoteI18n.t('status.noRunningTask');
      this.callbacks.onStatusText(nothingRunning);
      this.callbacks.onToast(nothingRunning);
      return;
    }
    try {
      this.callbacks.onStatusText(RemoteI18n.t('status.stoppingTask'));
      await this.client.cancelTask(sessionId, activeTurnId);
      RemoteLogger.info(`stop task accepted session=${RemoteChatCommandController.shortId(sessionId)} turn=${RemoteChatCommandController.shortId(activeTurnId)}`);
      this.callbacks.onStatusText(RemoteI18n.t('status.stopRequested'));
      this.callbacks.onPollRequested();
    } catch (err) {
      // A rejected cancel leaves the task running, so failing quietly here is
      // indistinguishable from the stop having worked.
      const errorText = ConnectionErrorPolicy.errorText(err);
      RemoteLogger.info(`stop task failed session=${RemoteChatCommandController.shortId(sessionId)} turn=${RemoteChatCommandController.shortId(activeTurnId)}`);
      this.callbacks.onStatusText(errorText);
      this.callbacks.onToast(errorText);
    }
  }

  async renameActiveSession(
    session: SessionSummary,
    title: string,
    isBusy: boolean,
    remoteAvailable: boolean
  ): Promise<void> {
    const sessionId = session.sessionId || '';
    const nextTitle = title.trim();
    if (sessionId.length === 0 || nextTitle.length === 0 || nextTitle === session.title || isBusy || !remoteAvailable) {
      return;
    }
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onStatusText(RemoteI18n.t('status.updatingTitle'));
      await this.client.renameSession(sessionId, nextTitle);
      const updatedSession: SessionSummary = {
        sessionId,
        title: nextTitle,
        workspacePath: session.workspacePath,
      remoteConnectionId: session.remoteConnectionId,
        agentType: session.agentType,
        initialTurnId: session.initialTurnId
      };
      this.callbacks.onActiveSession(updatedSession);
      this.callbacks.onSessionTitleChanged(sessionId, nextTitle);
      this.callbacks.onStatusText(RemoteI18n.t('status.titleUpdated'));
    } catch (err) {
      this.callbacks.onStatusText(ConnectionErrorPolicy.errorText(err));
    } finally {
      this.callbacks.onBusy(false);
    }
  }
}
