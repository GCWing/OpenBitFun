import { TimeFormat } from '../../services/TimeFormat';
import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { WorkspaceToolsState } from './WorkspaceToolsState';
import {
  SavedRuntimeConnection,
  AssistantEntry,
  ChatMessage,
  RecentWorkspaceEntry,
  RemoteModelCatalog,
  RemoteSession,
  SelectedImageAttachment,
  SessionSummary
} from '../../model/RemoteModels';
import { ChatTimelineItem, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { RemoteUiState } from '../../services/RemoteUiState';
import { ConversationCoreState } from './ConversationCoreState';

/**
 * Observable projection for the Remote home page.
 * Connection, persistence and transport ownership stay outside this object.
 */
@ObservedV2
export class RemotePageState {
  @Trace interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  readonly workspaceTools: WorkspaceToolsState = new WorkspaceToolsState();
  @Trace conversation: ConversationCoreState = new ConversationCoreState('code');
  @Trace desktopName: string = '';
  @Trace desktopId: string = '';
  @Trace remoteUrl: string = '';
  @Trace userId: string = '';
  @Trace requiresAccountAuth: boolean = false;
  @Trace accountUsername: string = '';
  @Trace accountAvatarUrl: string = '';
  @Trace accountUserId: string = '';
  @Trace authenticatedUserId: string = '';
  @Trace hostCapabilities: string[] = [];
  @Trace controlTargetType: string = 'none';
  @Trace controlTargetDeviceId: string = '';
  @Trace controlTargetDeviceName: string = '';
  @Trace connectionState: string = 'idle';
  @Trace connectionFailureKind: string = '';
  @Trace isLoadingHome: boolean = false;
  @Trace showRemoteUrlInput: boolean = false;
  @Trace workspaceName: string = '';
  @Trace workspacePath: string = '';
  @Trace workspaceConnectionId: string = '';
  @Trace workspaceSshHost: string = '';
  @Trace workspaceBranch: string = '';
  @Trace workspaceKind: string = 'normal';
  @Trace assistantId: string = '';
  @Trace savedConnections: SavedRuntimeConnection[] = [];
  @Trace savedConnectionsTargetId: string = '';
  @Trace recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Trace assistants: AssistantEntry[] = [];
  @Trace showWorkspacePicker: boolean = false;
  @Trace showAssistantPicker: boolean = false;
  @Trace downloadingFilePath: string = '';
  @Trace downloadedFilePath: string = '';
  @Trace fileDownloadStatus: string = '';
  @Trace sessionQuery: string = '';
  @Trace sessionFilter: string = 'all';
  @Trace hasMoreSessions: boolean = false;
  @Trace isLoadingSessions: boolean = false;
  @Trace isLoadingConversation: boolean = false;
  // Separate from isLoadingConversation, which means the session itself is not
  // known yet and so blanks the header. Here the session is known and named;
  // only its transcript is still on the way, and the header should keep saying
  // which conversation the pane is about while the body says it is filling.
  @Trace isLoadingTranscript: boolean = false;
  @Trace pendingSessionId: string = '';
  @Trace isConversationDismissed: boolean = false;
  @Trace sessionErrorText: string = '';
  // Deliberately untraced: the memo behind visibleSessions(), not state anything
  // renders. Tracing it would make reading the list a write to the list.
  private visibleSessionsCache: RemoteSession[] = [];
  private visibleSessionsSource: RemoteSession[] | undefined = undefined;
  private visibleSessionsQuery: string = ' ';
  get activeSession(): SessionSummary { return this.conversation.activeSession; }
  get sessions(): RemoteSession[] { return this.conversation.sessions; }
  get persistedMessages(): ChatMessage[] { return this.conversation.persistedMessages; }
  get optimisticMessages(): ChatMessage[] { return this.conversation.optimisticMessages; }
  get activeTurnMessage(): ChatMessage { return this.conversation.activeTurnMessage; }
  get hasMoreMessages(): boolean { return this.conversation.hasMoreMessages; }
  get timelineItems(): ObservableChatTimelineItem[] { return this.conversation.timelineItems; }
  get timelineRevision(): number { return this.conversation.timelineRevision; }
  get isBusy(): boolean { return this.conversation.isBusy; }
  get modelCatalog(): RemoteModelCatalog { return this.conversation.modelCatalog; }
  get selectedModelId(): string { return this.conversation.selectedModelId; }
  get statusText(): string { return this.conversation.statusText; }
  get chatInput(): string { return this.conversation.chatInput; }
  get selectedImages(): SelectedImageAttachment[] { return this.conversation.selectedImages; }
  get isVoiceListening(): boolean { return this.conversation.isVoiceListening; }

  setQuery(query: string): void {
    this.sessionQuery = query;
  }

  setFilter(filter: string): void {
    this.sessionFilter = filter;
  }

  setDesktopName(desktopName: string): void {
    this.desktopName = desktopName;
  }

  setDesktopIdentity(desktopName: string, desktopId: string): void {
    this.desktopName = desktopName;
    this.desktopId = desktopId;
  }

  setPairingInput(remoteUrl: string, userId: string, showRemoteUrlInput: boolean): void {
    this.remoteUrl = remoteUrl;
    this.userId = userId;
    this.showRemoteUrlInput = showRemoteUrlInput;
  }

  setAccountPairing(requiresAccountAuth: boolean, accountUsername: string): void {
    this.requiresAccountAuth = requiresAccountAuth;
    this.accountUsername = accountUsername;
  }

  setAccountAvatarUrl(avatarUrl: string): void {
    this.accountAvatarUrl = avatarUrl;
  }

  setAccountUsername(accountUsername: string): void {
    this.accountUsername = accountUsername;
  }

  setAccountUserId(accountUserId: string): void {
    this.accountUserId = accountUserId;
  }

  setControlTarget(type: string, deviceId: string, deviceName: string): void {
    if (deviceId !== this.controlTargetDeviceId) {
      this.workspaceTools.visible = false; this.workspaceTools.busy = false;
      this.workspaceTools.entries = []; this.workspaceTools.content = '';
      this.workspaceTools.output = ''; this.workspaceTools.terminalId = '';
    }
    this.controlTargetType = type;
    this.controlTargetDeviceId = deviceId;
    this.controlTargetDeviceName = deviceName;
  }

  clearControlTarget(): void {
    this.setControlTarget('none', '', '');
  }

  setRemoteUrl(remoteUrl: string): void {
    this.remoteUrl = remoteUrl;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setAuthenticatedUserId(authenticatedUserId: string): void {
    this.authenticatedUserId = authenticatedUserId;
  }

  setHostCapabilities(capabilities: string[]): void {
    this.hostCapabilities = capabilities.slice();
  }

  supportsHostCapability(capability: string): boolean {
    return this.hostCapabilities.indexOf(capability) >= 0;
  }

  setStatusText(statusText: string): void {
    this.conversation.setStatusText(statusText);
  }

  setConnectionState(connectionState: string): void {
    this.connectionState = connectionState;
  }

  setConnectionFailureKind(connectionFailureKind: string): void {
    this.connectionFailureKind = connectionFailureKind;
  }

  setBusy(isBusy: boolean): void {
    this.conversation.setBusy(isBusy);
  }

  setLoadingHome(isLoadingHome: boolean): void {
    this.isLoadingHome = isLoadingHome;
  }

  setRemoteUrlInputVisible(visible: boolean): void {
    this.showRemoteUrlInput = visible;
  }

  setWorkspace(
    workspaceName: string,
    workspacePath: string,
    assistantId: string,
    workspaceBranch: string = '',
    workspaceKind: string = 'normal',
    remoteConnectionId: string = '',
    remoteSshHost: string = ''
  ): void {
    this.workspaceName = workspaceName;
    this.workspacePath = workspacePath;
    this.workspaceConnectionId = remoteConnectionId;
    this.workspaceSshHost = remoteSshHost;
    this.assistantId = assistantId;
    this.workspaceBranch = workspaceBranch;
    this.workspaceKind = workspaceKind;
  }

  setRecentWorkspaces(recentWorkspaces: RecentWorkspaceEntry[]): void {
    this.recentWorkspaces = recentWorkspaces.slice();
  }

  setAssistants(assistants: AssistantEntry[]): void {
    this.assistants = assistants.slice();
  }

  setWorkspacePickerVisible(visible: boolean): void {
    this.showWorkspacePicker = visible;
  }

  setAssistantPickerVisible(visible: boolean): void {
    this.showAssistantPicker = visible;
  }

  closePickers(): void {
    this.showWorkspacePicker = false;
    this.showAssistantPicker = false;
  }

  setSessions(sessions: RemoteSession[], hasMore: boolean): void {
    this.conversation.setSessions(sessions);
    this.hasMoreSessions = hasMore;
    this.sessionErrorText = '';
  }

  setActiveSession(session: SessionSummary): void {
    if (this.conversation.activeSession.sessionId !== session.sessionId) this.interactionMailbox = new InteractionMailboxState();
    this.conversation.setActiveSession(session);
  }

  clearActiveSession(): void {
    this.interactionMailbox = new InteractionMailboxState();
    this.conversation.clearActiveSession();
    this.isLoadingConversation = false;
    this.isLoadingTranscript = false;
    this.pendingSessionId = '';
    this.isConversationDismissed = false;
    this.setModelCatalog(RemoteUiState.emptyModelCatalog(), '');
  }

  setTimelineProjection(
    persistedMessages: ChatMessage[],
    optimisticMessages: ChatMessage[],
    activeTurnMessage: ChatMessage,
    hasMoreMessages: boolean,
    timelineItems: ChatTimelineItem[]
  ): void {
    this.conversation.setTimelineProjection(
      persistedMessages,
      optimisticMessages,
      activeTurnMessage,
      hasMoreMessages,
      timelineItems
    );
  }

  setHasMoreMessages(hasMoreMessages: boolean): void {
    this.conversation.setHasMoreMessages(hasMoreMessages);
  }

  setHistoryLoadState(loading: boolean, failed: boolean): void {
    this.conversation.historyLoading = loading;
    this.conversation.historyFailed = failed;
  }

  clearTimeline(): void {
    this.conversation.clearTimeline();
  }

  setModelCatalog(modelCatalog: RemoteModelCatalog, selectedModelId: string): void {
    this.conversation.setModelCatalog(modelCatalog, selectedModelId);
  }

  setDownloadStatus(downloadingFilePath: string, downloadedFilePath: string, fileDownloadStatus: string): void {
    this.downloadingFilePath = downloadingFilePath;
    this.downloadedFilePath = downloadedFilePath;
    this.fileDownloadStatus = fileDownloadStatus;
  }

  clearDownloadingFilePath(): void {
    this.downloadingFilePath = '';
  }

  clearDownloadStatus(): void {
    this.downloadingFilePath = '';
    this.downloadedFilePath = '';
    this.fileDownloadStatus = '';
  }

  setChatInput(chatInput: string): void {
    this.conversation.setChatInput(chatInput);
  }

  setSelectedImages(selectedImages: SelectedImageAttachment[]): void {
    this.conversation.setSelectedImages(selectedImages);
  }

  addSelectedImages(selectedImages: SelectedImageAttachment[]): void {
    this.conversation.addSelectedImages(selectedImages);
  }

  removeSelectedImage(imageId: string): void {
    this.conversation.removeSelectedImage(imageId);
  }

  clearComposer(): void {
    this.conversation.clearComposer();
  }

  setVoiceListening(isVoiceListening: boolean): void {
    this.conversation.setVoiceListening(isVoiceListening);
  }

  setLoading(loading: boolean): void {
    this.isLoadingSessions = loading;
  }

  setConversationLoading(loading: boolean): void {
    this.isLoadingConversation = loading;
  }

  setTranscriptLoading(loading: boolean): void {
    this.isLoadingTranscript = loading;
  }

  setPendingSessionId(sessionId: string): void {
    this.pendingSessionId = sessionId;
  }

  setConversationDismissed(dismissed: boolean): void {
    this.isConversationDismissed = dismissed;
  }

  setError(errorText: string): void {
    this.sessionErrorText = errorText;
    this.isLoadingSessions = false;
  }

  clear(): void {
    this.conversation.setSessions([]);
    this.hasMoreSessions = false;
    this.isLoadingSessions = false;
    this.isLoadingConversation = false;
    this.isLoadingTranscript = false;
    this.pendingSessionId = '';
    this.isConversationDismissed = false;
    this.isLoadingHome = false;
    this.sessionErrorText = '';
    this.hostCapabilities = [];
  }

  /** Clears every conversation-scoped value when its remote identity ends. */
  resetConversationContext(): void {
    this.interactionMailbox = new InteractionMailboxState();
    this.conversation.reset();
    this.hasMoreSessions = false;
    this.isLoadingSessions = false;
    this.isLoadingConversation = false;
    this.isLoadingTranscript = false;
    this.pendingSessionId = '';
    this.isConversationDismissed = false;
    this.isLoadingHome = false;
    this.sessionErrorText = '';
    this.hostCapabilities = [];
    this.clearDownloadStatus();
  }

  clearWorkspaceActions(): void {
    this.recentWorkspaces = [];
    this.assistants = [];
    this.closePickers();
  }

  /**
   * The sessions the sidebar may show, as a stable array.
   *
   * This is read straight into a `@Param`, so returning a fresh array each call
   * marked the session list dirty on every rebuild of its parent — including
   * the rebuild that a selection change causes, which is the one case where
   * nothing about the list has moved. Handing back the same instance until the
   * source or the query changes lets the list keep what it already computed.
   */
  visibleSessions(): RemoteSession[] {
    const source = this.conversation.sessions;
    const query = this.sessionQuery.trim().toLowerCase();
    if (source === this.visibleSessionsSource && query === this.visibleSessionsQuery) {
      return this.visibleSessionsCache;
    }
    this.visibleSessionsSource = source;
    this.visibleSessionsQuery = query;
    this.visibleSessionsCache = source.filter((item: RemoteSession) => {
      if (item.id.length === 0 || item.status === 'archived') {
        return false;
      }
      return query.length === 0 || item.title.toLowerCase().indexOf(query) >= 0;
    });
    return this.visibleSessionsCache;
  }

  private recentHomeSource: RemoteSession[] | undefined = undefined;
  private recentHomeCache: RemoteSession[] = [];

  recentHomeSessions(): RemoteSession[] {
    const source = this.conversation.sessions;
    if (this.recentHomeSource === source) return this.recentHomeCache;
    this.recentHomeSource = source;
    this.recentHomeCache = source.filter((session: RemoteSession): boolean =>
      session.id.trim().length > 0 && session.status !== 'archived')
      .sort((left: RemoteSession, right: RemoteSession): number =>
        this.recentSessionTime(right) - this.recentSessionTime(left))
      .filter((session: RemoteSession, index: number, rows: RemoteSession[]): boolean =>
        rows.findIndex((row: RemoteSession): boolean => row.id === session.id) === index).slice(0, 3);
    return this.recentHomeCache;
  }

  private recentSessionTime(session: RemoteSession): number {
    const updated = TimeFormat.timestampMs(session.updatedAt);
    if (Number.isFinite(updated) && updated > 0) return updated;
    const created = TimeFormat.timestampMs(session.createdAt);
    return Number.isFinite(created) ? created : 0;
  }

  hasRunningActiveTurn(): boolean {
    return this.conversation.hasRunningActiveTurn();
  }
}
