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
    if (state.isLoadingConversation) {
      state.activeSession = ConversationViewState.emptySession();
    }
    state.composerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
    state.showSuggestionsWhenEmpty = false;
    state.downloadingFilePath = remote.downloadingFilePath;
    state.downloadedFilePath = remote.downloadedFilePath;
    state.fileDownloadStatus = remote.fileDownloadStatus;
    state.interactionMailbox = remote.interactionMailbox;
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
