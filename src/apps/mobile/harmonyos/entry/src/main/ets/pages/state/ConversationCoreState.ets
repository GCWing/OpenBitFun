import { ComposerSubmission } from '../../model/ComposerSubmission';
import {
  ChatMessage,
  RemoteModelCatalog,
  RemoteModelConfig,
  RemoteSession,
  SelectedImageAttachment,
  SessionSummary
} from '../../model/RemoteModels';
import {
  ChatTimelineItem,
  ObservableChatTimelineItem,
  ChatTimelineRevisionTracker,
  ChatTimelineRowStore
} from '../../model/ChatTimelineModels';
import { RemoteUiState } from '../../services/RemoteUiState';
import { SubagentBranchExpansionState } from './SubagentBranchExpansionState';

/** Shared observable state for General Chat and Remote Chat conversations. */
@ObservedV2
export class ConversationCoreState {
  @Trace sessions: RemoteSession[] = [];
  @Trace activeSession: SessionSummary;
  @Trace persistedMessages: ChatMessage[] = [];
  @Trace optimisticMessages: ChatMessage[] = [];
  @Trace activeTurnMessage: ChatMessage = RemoteUiState.emptyActiveTurn();
  @Trace hasMoreMessages: boolean = false;
  @Trace historyLoading: boolean = false;
  @Trace historyFailed: boolean = false;
  @Trace timelineItems: ObservableChatTimelineItem[] = [];
  @Trace timelineRevision: number = 0;
  @Trace isBusy: boolean = false;
  @Trace modelCatalog: RemoteModelCatalog = RemoteUiState.emptyModelCatalog();
  @Trace selectedModelId: string = '';
  @Trace statusText: string = '';
  @Trace chatInput: string = '';
  @Trace selectedImages: SelectedImageAttachment[] = [];
  @Trace isVoiceListening: boolean = false;
  /**
   * Which delegation cards are open. Disclosures outlive the rows that draw
   * them, so they are owned by the conversation rather than by a card, and they
   * are shared by every surface that projects this conversation.
   */
  readonly subagentBranches: SubagentBranchExpansionState = new SubagentBranchExpansionState();
  private composerRevision: number = 0;
  private readonly defaultAgentType: string;
  private readonly timelineRevisionTracker: ChatTimelineRevisionTracker = new ChatTimelineRevisionTracker();
  private readonly timelineRowStore: ChatTimelineRowStore = new ChatTimelineRowStore();

  constructor(defaultAgentType: string) {
    this.defaultAgentType = defaultAgentType;
    this.activeSession = ConversationCoreState.emptySession(defaultAgentType);
  }

  setSessions(sessions: RemoteSession[]): void {
    this.sessions = sessions.slice();
  }

  setActiveSession(session: SessionSummary): void {
    if (this.activeSession.sessionId !== session.sessionId) this.composerRevision++;
    this.activeSession = {
      sessionId: session.sessionId,
      title: session.title,
      workspacePath: session.workspacePath,
      remoteConnectionId: session.remoteConnectionId,
      agentType: this.defaultAgentType === 'chat' ? 'chat' : session.agentType,
      initialTurnId: session.initialTurnId
    };
  }

  clearActiveSession(): void {
    this.composerRevision++;
    this.activeSession = ConversationCoreState.emptySession(this.defaultAgentType);
    this.clearTimeline();
  }

  setTimelineProjection(
    persistedMessages: ChatMessage[],
    optimisticMessages: ChatMessage[],
    activeTurnMessage: ChatMessage,
    hasMoreMessages: boolean,
    timelineItems: ChatTimelineItem[]
  ): void {
    this.timelineRevision = this.timelineRevisionTracker.update(timelineItems);
    this.persistedMessages = persistedMessages.slice();
    this.optimisticMessages = optimisticMessages.slice();
    this.activeTurnMessage = activeTurnMessage.id.length > 0 ?
      ConversationCoreState.copyMessage(activeTurnMessage) :
      RemoteUiState.emptyActiveTurn();
    this.hasMoreMessages = hasMoreMessages;
    this.timelineItems = this.timelineRowStore.reconcile(timelineItems);
  }

  setHasMoreMessages(hasMoreMessages: boolean): void {
    this.hasMoreMessages = hasMoreMessages;
  }

  clearTimeline(): void {
    this.persistedMessages = [];
    this.optimisticMessages = [];
    this.activeTurnMessage = RemoteUiState.emptyActiveTurn();
    this.hasMoreMessages = false;
    this.historyLoading = false;
    this.historyFailed = false;
    this.timelineItems = [];
    this.timelineRowStore.clear();
    this.timelineRevision = this.timelineRevisionTracker.reset();
  }

  setBusy(isBusy: boolean): void {
    this.isBusy = isBusy;
  }

  setModelCatalog(modelCatalog: RemoteModelCatalog, selectedModelId: string): void {
    this.modelCatalog = ConversationCoreState.copyModelCatalog(modelCatalog);
    this.selectedModelId = selectedModelId;
  }

  setStatusText(statusText: string): void {
    this.statusText = statusText;
  }

  setChatInput(chatInput: string): void {
    if (this.chatInput === chatInput) return;
    this.composerRevision++;
    this.chatInput = chatInput;
  }

  setSelectedImages(selectedImages: SelectedImageAttachment[]): void {
    this.composerRevision++;
    this.selectedImages = selectedImages.slice();
  }

  addSelectedImages(selectedImages: SelectedImageAttachment[]): void {
    this.composerRevision++;
    this.selectedImages = this.selectedImages.concat(selectedImages);
  }

  removeSelectedImage(imageId: string): void {
    this.composerRevision++;
    this.selectedImages = this.selectedImages.filter((image: SelectedImageAttachment) => image.id !== imageId);
  }

  clearComposer(): void {
    this.composerRevision++;
    this.chatInput = '';
    this.selectedImages = [];
  }

  /** Capture ownership before any await; later callbacks cannot consume a newer draft. */
  prepareComposerSubmission(sessionId: string, text: string, images: SelectedImageAttachment[]): ComposerSubmission {
    const originalText = this.chatInput;
    const originalImages = this.selectedImages.slice();
    const capturedRevision = this.composerRevision;
    let committedRevision = -1;
    let committed = false;
    let finished = false;
    return {
      commit: (): void => {
        if (finished || committed || this.composerRevision !== capturedRevision ||
          this.activeSession.sessionId !== sessionId) return;
        if (this.chatInput.trim() === text.trim()) this.setChatInput('');
        this.setSelectedImages(this.selectedImages.filter((image: SelectedImageAttachment): boolean =>
          !images.some((sent: SelectedImageAttachment): boolean => sent.id === image.id)));
        committedRevision = this.composerRevision;
        committed = true;
      },
      rollback: (): void => {
        if (finished) return;
        finished = true;
        if (!committed || this.composerRevision !== committedRevision || this.activeSession.sessionId !== sessionId) return;
        this.setChatInput(originalText);
        this.setSelectedImages(originalImages);
      }
    };
  }

  /**
   * Drops the complete observable projection of one conversation context.
   *
   * Account logout, disconnect and workspace replacement must not rebuild this
   * list field-by-field: leaving even one field behind makes the next surface
   * look as if it still belongs to the previous identity.
   */
  reset(): void {
    this.sessions = [];
    this.clearActiveSession();
    this.isBusy = false;
    this.modelCatalog = RemoteUiState.emptyModelCatalog();
    this.selectedModelId = '';
    this.statusText = '';
    this.clearComposer();
    this.isVoiceListening = false;
  }

  setVoiceListening(isVoiceListening: boolean): void {
    this.isVoiceListening = isVoiceListening;
  }

  hasRunningActiveTurn(): boolean {
    return this.activeTurnMessage.id.length > 0 &&
      (this.activeTurnMessage.status || '').toLowerCase() === 'active';
  }

  latestUserMessageText(): string {
    const candidates = this.persistedMessages.concat(this.optimisticMessages);
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (candidates[index].role === 'user' && candidates[index].text.trim().length > 0) {
        return candidates[index].text;
      }
    }
    return '';
  }

  private static emptySession(agentType: string): SessionSummary {
    return {
      sessionId: '',
      title: '',
      workspacePath: '',
      agentType
    };
  }

  private static copyMessage(message: ChatMessage): ChatMessage {
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      renderVersion: message.renderVersion,
      turnId: message.turnId,
      detail: message.detail,
      timestamp: message.timestamp,
      thinking: message.thinking,
      tools: message.tools ? message.tools.slice() : undefined,
      items: message.items ? message.items.slice() : undefined,
      images: message.images ? message.images.slice() : undefined
    };
  }

  private static copyModelCatalog(modelCatalog: RemoteModelCatalog): RemoteModelCatalog {
    return {
      version: modelCatalog.version,
      models: modelCatalog.models.map((model): RemoteModelConfig => {
        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          base_url: model.base_url,
          model_name: model.model_name,
          context_window: model.context_window,
          enabled: model.enabled,
          capabilities: model.capabilities.slice(),
          reasoning: model.reasoning
        };
      }),
      default_models: {
        primary: modelCatalog.default_models.primary,
        fast: modelCatalog.default_models.fast,
        search: modelCatalog.default_models.search,
        image_understanding: modelCatalog.default_models.image_understanding
      },
      session_model_id: modelCatalog.session_model_id
    };
  }
}
