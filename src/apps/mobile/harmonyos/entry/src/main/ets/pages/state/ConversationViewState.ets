import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import {
  GeneralChatServiceStatus
} from '../../services/general-chat/GeneralChatServiceState';
import { RemoteUiState } from '../../services/RemoteUiState';
import {
  ChatComposerCapabilities,
  GENERAL_CHAT_COMPOSER_CAPABILITIES,
  REMOTE_CHAT_COMPOSER_CAPABILITIES
} from './ChatComposerCapabilities';
import { ChatSurface } from './ChatSurface';
import {
  ConversationUiModelCatalog,
  ConversationUiSelectedImage,
  ConversationUiSession,
  toConversationUiModelCatalog,
  toConversationUiSelectedImage,
  toConversationUiSession
} from './ConversationUiModels';
import { AppRoute } from '../navigation/AppRouteContract';
import { ConversationCoreState } from './ConversationCoreState';
import { GeneralChatPageState } from './GeneralChatPageState';
import { RemotePageState } from './RemotePageState';
import { RollbackEntryFacts } from '../policy/RollbackPresentationPolicy';

/** Immutable presentation state consumed by ConversationView. */
export class ConversationViewState {
  interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  activeSession: ConversationUiSession = ConversationViewState.emptySession();
  surface: ChatSurface = ChatSurface.General;
  desktopName: string = '';
  workspaceBranch: string = '';
  statusText: string = '';
  inlineStatusText: string = '';
  connectionState: string = 'idle';
  composerCapabilities: ChatComposerCapabilities = GENERAL_CHAT_COMPOSER_CAPABILITIES;
  isBusy: boolean = false;
  isLoadingConversation: boolean = false;
  isLoadingTranscript: boolean = false;
  canStop: boolean = false;
  hasMoreMessages: boolean = false;
  historyLoading: boolean = false;
  historyFailed: boolean = false;
  timelineItems: ObservableChatTimelineItem[] = [];
  timelineRevision: number = 0;
  showSuggestionsWhenEmpty: boolean = false;
  modelCatalog: ConversationUiModelCatalog = toConversationUiModelCatalog(RemoteUiState.emptyModelCatalog());
  selectedModelId: string = '';
  isSessionPinned: boolean = false;
  downloadingFilePath: string = '';
  downloadedFilePath: string = '';
  fileDownloadStatus: string = '';
  selectedImages: ConversationUiSelectedImage[] = [];
  isVoiceListening: boolean = false;
  chatInput: string = '';
  /**
   * The facts a tap on the rollback entry is judged with.
   *
   * Projected, not decided: the entry can be tapped long after the row was drawn,
   * so the pane resolves these facts into a decision at tap time. `none()` is the
   * default because a surface with no host behind it — the local General Chat pane
   * — has nothing to roll back to.
   */
  rollbackGate: RollbackEntryFacts = RollbackEntryFacts.none();
  /** The system hint row a successful rollback left in this session's transcript. */
  rollbackNotice: string = '';
  /** Host outcome of a rollback this client asked for, or empty for none. */
  rollbackOutcome: string = '';
  /** Monotonic id of that outcome, so two identical failures are two outcomes. */
  rollbackOutcomeSeq: number = 0;

  static project(
    route: AppRoute,
    remote: RemotePageState,
    general: GeneralChatPageState,
    generalInlineStatus: string
  ): ConversationViewState {
    if (route === AppRoute.RemoteChat) {
      return ConversationViewState.remote(remote);
    }
    return ConversationViewState.general(general, generalInlineStatus);
  }

  private static remote(remote: RemotePageState): ConversationViewState {
    const state = ConversationViewState.fromCore(remote.conversation);
    state.surface = ChatSurface.Remote;
    state.desktopName = remote.desktopName;
    state.workspaceBranch = remote.workspaceBranch;
    state.connectionState = remote.connectionState;
    state.isLoadingConversation = remote.isLoadingConversation;
    // Nothing is being waited for once the pane has no session: a skeleton left
    // standing after a disconnect or a delete would describe a load that was
    // abandoned rather than one still running.
    state.isLoadingTranscript = remote.isLoadingTranscript && remote.activeSession.sessionId.length > 0;
    if (state.isLoadingConversation) {
      state.activeSession = ConversationViewState.emptySession();
    }
    state.composerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
    state.showSuggestionsWhenEmpty = false;
    state.downloadingFilePath = remote.downloadingFilePath;
    state.downloadedFilePath = remote.downloadedFilePath;
    state.fileDownloadStatus = remote.fileDownloadStatus;
    state.interactionMailbox = remote.interactionMailbox;
    // A rollback needs an idle session on a host that serves the capability; a
    // dispatch session cannot be proven from this controller (see
    // `RollbackEntryFacts.isDispatchSession`), so the host's own refusal stays the
    // loud answer rather than a silent "no" invented here.
    state.rollbackGate = new RollbackEntryFacts(
      remote.hostCapabilities.slice(),
      remote.isBusy || state.canStop,
      false
    );
    state.rollbackNotice = remote.rollbackNotice;
    state.rollbackOutcome = remote.rollbackOutcome;
    state.rollbackOutcomeSeq = remote.rollbackOutcomeSeq;
    return state;
  }

  private static general(general: GeneralChatPageState, inlineStatus: string): ConversationViewState {
    const state = ConversationViewState.fromCore(general.conversation);
    state.inlineStatusText = inlineStatus;
    state.connectionState = GeneralChatServiceStatus.connectionState(general.serviceState);
    state.isSessionPinned = general.conversation.activeSession.sessionId.length > 0 &&
      general.pinnedSessionId() === general.conversation.activeSession.sessionId;
    return state;
  }

  private static fromCore(core: ConversationCoreState): ConversationViewState {
    const state = new ConversationViewState();
    state.activeSession = toConversationUiSession(core.activeSession);
    state.statusText = core.statusText;
    state.isBusy = core.isBusy;
    state.canStop = core.hasRunningActiveTurn();
    state.hasMoreMessages = core.hasMoreMessages;
    state.historyLoading = core.historyLoading;
    state.historyFailed = core.historyFailed;
    state.timelineItems = core.timelineItems;
    state.timelineRevision = core.timelineRevision;
    state.modelCatalog = toConversationUiModelCatalog(core.modelCatalog);
    state.selectedModelId = core.selectedModelId;
    state.selectedImages = core.selectedImages.map((image) => toConversationUiSelectedImage(image));
    state.isVoiceListening = core.isVoiceListening;
    state.chatInput = core.chatInput;
    return state;
  }

  private static emptySession(): ConversationUiSession {
    return {
      sessionId: '',
      title: '',
      workspacePath: '',
      agentType: 'chat'
    };
  }
}
