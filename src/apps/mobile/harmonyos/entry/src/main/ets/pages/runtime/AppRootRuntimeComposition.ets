import { BuiltinMiniAppHost } from '../../services/BuiltinMiniAppHost';
import { MiniAppViewModel } from '../viewmodel/MiniAppViewModel';
import { SidebarConnectionActionPolicy } from '../policy/SidebarConnectionActionPolicy';
import { accountDeviceLink } from '../../services/AccountDeviceLink';
import {
  ChatMessage,
  RemoteModelCatalog,
  RemotePermissionMode,
  RemoteQuestionAnswerPayload,
  RemoteSession,
  RecentWorkspaceEntry,
  SelectedImageAttachment,
  SessionSummary,
  WorkspaceInfo
} from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { LocalePreferenceStore } from '../../services/LocalePreferenceStore';
import { ClipboardService } from '../../services/ClipboardService';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { ConnectionStatusPresenter } from '../../services/ConnectionStatusPresenter';
import { ImagePickerService } from '../../services/ImagePickerService';
import { MobileIdentityStore } from '../../services/MobileIdentityStore';
import { CloudAccountClient, CloudAccountDevice } from '../../services/CloudAccountClient';
import { GitHubAccountProfileClient } from '../../services/GitHubAccountProfile';
import { CloudAccountSessionStore } from '../../services/CloudAccountSessionStore';
import { RemoteActivityLifecycleController } from '../../services/RemoteActivityLifecycleController';
import { RemoteChatCache } from '../../services/RemoteChatCache';
import { RemoteChatCommandController } from '../../services/RemoteChatCommandController';
import { RemoteChatLocalRdbStore } from '../../services/RemoteChatLocalRdbStore';
import { RemoteChatPollingLifecycleController, RemoteChatPollingSnapshot } from '../../services/RemoteChatPollingLifecycleController';
import { RemoteFileDownloadController } from '../../services/RemoteFileDownloadController';
import { FilePreviewController } from '../viewmodel/FilePreviewController';
import { DeviceDirectoryViewModel } from '../viewmodel/DeviceDirectoryViewModel';
import { SettingsController } from '../viewmodel/SettingsController';
import { LocaleController } from '../viewmodel/LocaleController';
import { ConversationController } from '../viewmodel/ConversationController';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteModelController } from '../../services/RemoteModelController';
import { DetectedUrlAction } from '../../services/ConnectScanDecisionPolicy';
import { RemoteSessionController } from '../../services/RemoteSessionController';
import { RemoteSessionListCache } from '../../services/RemoteSessionListCache';
import { RemoteSessionListRdbStore } from '../../services/RemoteSessionListRdbStore';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { RemoteWorkspaceRepository } from '../../services/RemoteWorkspaceRepository';
import { RemoteWorkspaceCoordinator } from '../../services/RemoteWorkspaceCoordinator';
import { RemoteConnectionCoordinator } from '../../services/RemoteConnectionCoordinator';
import { RemoteToolActionController } from '../../services/RemoteToolActionController';
import { AsyncLifecycleGate } from '../../services/AsyncLifecycleGate';
import { QrScanService } from '../../services/QrScanService';
import { RemoteUiState } from '../../services/RemoteUiState';
import { VoiceInputLifecycleController } from '../../services/VoiceInputLifecycleController';
import { VoiceInputService } from '../../services/VoiceInputService';
import { ConversationIntent } from '../actions/ConversationIntent';
import { AppRootHostPort } from '../host/AppRootHostAdapter';
import { AppRootPresentationActions } from '../actions/AppRootPresentationActions';
import {
  AppNavigationBackAction,
  AppRoute,
  AppRouteContract
} from '../navigation/AppRouteContract';
import { AppShellState, CONNECT_INTENT_AUTO, CONNECT_INTENT_SCAN } from '../state/AppShellState';
import {
  RemoteConnectEntryKind,
  RemoteSurfaceEntryPolicy
} from '../policy/RemoteSurfaceEntryPolicy';
import { AppShellViewModel } from '../viewmodel/AppShellViewModel';
import { RemoteActivityViewModel } from '../viewmodel/RemoteActivityViewModel';
import {
  RemoteConnectionController
} from '../viewmodel/RemoteConnectionController';
import { ConversationIntentDispatcher } from '../actions/ConversationIntentDispatcher';
import { GeneralChatPageState } from '../state/GeneralChatPageState';
import { DeviceDirectoryState } from '../state/DeviceDirectoryState';
import { RemotePageState } from '../state/RemotePageState';
import { WatchProvisionState } from '../state/WatchProvisionState';
import {
  WatchProvisionController,
  WatchProvisionOutcome,
  WatchProvisionPort
} from '../../services/WatchProvisionController';
import { ConversationViewModel } from '../viewmodel/ConversationViewModel';
import { FilePreviewState } from '../state/FilePreviewState';
import { FilePreviewRequest } from '../../model/FilePreviewTarget';
import { RemoteWorkspaceViewModel } from '../viewmodel/RemoteWorkspaceViewModel';
import { RemoteSessionViewModel } from '../viewmodel/RemoteSessionViewModel';
import { HarmonyTaskCompletionNotificationPort } from '../../services/HarmonyTaskCompletionNotificationPort';
import {
  TaskCompletionNotificationController,
  TaskCompletionObservation
} from '../../services/TaskCompletionNotificationController';

export enum ConnectionState {
  Idle = 'idle',
  Parsing = 'parsing',
  Pairing = 'pairing',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Failed = 'failed',
  Disconnected = 'disconnected'
}


export abstract class AppRootRuntimeComposition {
  readonly host: AppRootHostPort;

  constructor(host: AppRootHostPort) {
    this.host = host;
  }

  abstract closeAppSidebar(): void;
  abstract connect(autoReconnect?: boolean, accountPassword?: string): Promise<void>;
  abstract currentActiveTurnId(): string;
  abstract disconnect(clearPairing: boolean): Promise<void>;
  abstract enterCompactLayout(): void;
  abstract enterRemoteSurfaceCompact(closeSidebar?: boolean): Promise<void>;
  abstract enterRemoteSurfaceWide(): Promise<void>;
  abstract exitActiveChat(): void;
  abstract failRemoteConnection(err: Object): void;
  abstract handleNavigationBack(route: AppRoute): boolean;
  abstract hasRemoteBindingForResume(): boolean;
  abstract isRemoteConversationContext(sessionId: string): boolean;
  abstract mergeSessions(primary: RemoteSession[], extras: RemoteSession[]): RemoteSession[];
  abstract loadWorkspaceSessionsOnDevice(deviceId: string, path: string): Promise<void>;
  abstract openAddConnectionFromSettings(): void;
  abstract openAppSidebar(): void;
  abstract openRemoteControlSettings(): void;
  abstract openWorkspacePickerOnDevice(deviceId: string): Promise<void>;
  abstract pickImages(): Promise<void>;
  abstract publishRemoteSessions(sessions: RemoteSession[], hasMore: boolean): void;
  abstract reconcileCreatedRemoteSession(session: SessionSummary): Promise<void>;
  abstract reconnect(): Promise<void>;
  abstract reconnectActiveRemote(): Promise<void>;
  abstract retryDirectoryDevice(deviceId: string): Promise<void>;
  abstract selectDirectoryDevice(deviceId: string): Promise<void>;
  abstract selectAssistant(path: string): Promise<void>;
  abstract selectWorkspace(path: string): Promise<void>;
  abstract selectWorkspaceOnDevice(path: string, deviceId?: string): Promise<void>;
  abstract showVoiceInputError(message: string): void;
  abstract stopVoiceInput(showStatus: boolean): Promise<void>;
  abstract toggleVoiceInput(): Promise<void>;

  readonly sessionManager: RemoteSessionManager = new RemoteSessionManager();
  readonly miniAppViewModel: MiniAppViewModel = new MiniAppViewModel(new BuiltinMiniAppHost((): Context => this.host.context()));
  readonly taskCompletionNotificationPort: HarmonyTaskCompletionNotificationPort =
    new HarmonyTaskCompletionNotificationPort((): Context => this.host.context());
  readonly taskCompletionNotificationController: TaskCompletionNotificationController =
    new TaskCompletionNotificationController(
      this.taskCompletionNotificationPort,
      (observation: TaskCompletionObservation): void => {
        if (observation.source === 'remote') {
          this.remoteChatPollingLifecycleController.stop();
        }
      }
    );
  readonly workspaceRepository: RemoteWorkspaceRepository =
    new RemoteWorkspaceRepository(this.sessionManager);
  readonly workspaceCoordinator: RemoteWorkspaceCoordinator =
    new RemoteWorkspaceCoordinator(this.workspaceRepository);
  readonly remoteResumeGate: AsyncLifecycleGate = new AsyncLifecycleGate();
  readonly remoteConnectionGate: AsyncLifecycleGate = new AsyncLifecycleGate();
  readonly filePreviewState: FilePreviewState = new FilePreviewState();
  readonly identityStore: MobileIdentityStore = new MobileIdentityStore();
  readonly clipboardService: ClipboardService = new ClipboardService();
  readonly qrScanService: QrScanService = new QrScanService();
  readonly imagePickerService: ImagePickerService = new ImagePickerService();
  readonly remoteConnectionCoordinator: RemoteConnectionCoordinator =
    new RemoteConnectionCoordinator(
      this.sessionManager,
      this.remoteConnectionGate
    );
  readonly generalChatPageState: GeneralChatPageState = new GeneralChatPageState();
  readonly remotePageState: RemotePageState = new RemotePageState();
  readonly deviceDirectoryState: DeviceDirectoryState = new DeviceDirectoryState();
  readonly watchProvisionState: WatchProvisionState = new WatchProvisionState();
  private readonly watchProvisionPort: WatchProvisionPort = {
    canProvision: (): boolean => this.settingsController.canMintWatchCredential(),
    provision: (deviceId: string, deviceName: string, requestId: string, password: string): Promise<WatchProvisionOutcome> =>
      this.provisionWatchDevice(deviceId, deviceName, requestId, password)
  };
  readonly watchProvisionController: WatchProvisionController =
    new WatchProvisionController(this.watchProvisionState, this.watchProvisionPort);

  private async provisionWatchDevice(
    deviceId: string,
    deviceName: string,
    requestId: string,
    password: string
  ): Promise<WatchProvisionOutcome> {
    return await this.settingsController.provisionWatchCredential(deviceId, deviceName, requestId, password) ||
      AppRootRuntimeComposition.provisionUnavailable();
  }

  private static provisionUnavailable(): WatchProvisionOutcome {
    return {
      ok: false, passwordRequired: false, relayUrl: '', token: '', userId: '', masterKeyBase64: '', deviceId: '',
      failure: '', desktopReported: false
    };
  }
  readonly localePreferenceStore: LocalePreferenceStore = new LocalePreferenceStore();
  readonly chatTimelineStore: ConversationViewModel = new ConversationViewModel();
  // Scoped to the desktop currently being controlled: session ids are issued by
  // the desktop, so two of them on one account can name different conversations
  // with the same id.
  readonly remoteChatCache: RemoteChatCache =
    new RemoteChatCache(
      new RemoteChatLocalRdbStore(),
      (): string => this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId
    );
  readonly remoteSessionListStore: RemoteSessionListRdbStore = new RemoteSessionListRdbStore();
  readonly remoteSessionListCache: RemoteSessionListCache =
    new RemoteSessionListCache(
      this.remoteSessionListStore,
      (): string => this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId
    );
  // Both caches hold what one account saw on one desktop, so they are dropped
  // together whenever that binding ends.
  readonly clearCachedRemoteData: () => Promise<void> = async (): Promise<void> => {
    await this.remoteChatCache.clear();
    await this.remoteSessionListCache.clear();
  };
  readonly voiceInputService: VoiceInputService = new VoiceInputService();
  readonly remoteActivityLifecycleController: RemoteActivityLifecycleController =
    new RemoteActivityLifecycleController((): Promise<void> => {
      // Returned, not fired and forgotten: the heartbeat skips its next tick
      // while this one is still out, and it can only do that if it is handed
      // something to wait on.
      return this.remoteActivityViewModel.checkConnectionHealth();
    });
  readonly remoteActivityViewModel: RemoteActivityViewModel =
    new RemoteActivityViewModel(
      this.remoteActivityLifecycleController,
      this.remoteConnectionCoordinator,
      this.remoteResumeGate,
      {
        isConnected: (): boolean => (this.remotePageState.connectionState as ConnectionState) === ConnectionState.Connected,
        isReconnecting: (): boolean => (this.remotePageState.connectionState as ConnectionState) === ConnectionState.Reconnecting,
        isBusy: (): boolean => this.remotePageState.isBusy,
        hasRemoteBinding: (): boolean => this.hasRemoteBindingForResume(),
        isRemoteChat: (): boolean => this.appShellViewModel.isRoute(AppRoute.RemoteChat),
        activeSession: (): SessionSummary => this.remotePageState.activeSession,
        onConnectionState: (state: string): void => this.remotePageState.setConnectionState(state as ConnectionState),
        onStatus: (status: string): void => this.remotePageState.setStatusText(status),
        onConnectionError: async (err: Object): Promise<boolean> => this.settingsController.handleRemoteConnectionError(err),
        onStartPolling: (): void => this.conversationController.startRemotePolling(),
        onStopPolling: (): void => this.remoteChatPollingLifecycleController.stop(),
        onPoll: async (): Promise<void> => {
          await this.remoteChatPollingLifecycleController.pollNow();
        },
        onReconnect: async (): Promise<void> => {
          await this.reconnectActiveRemote();
        },
        onRestoreSession: async (session: SessionSummary): Promise<void> => {
          this.conversationController.applyRemoteActiveSession(session);
          await this.conversationController.loadRemoteMessages();
        }
      }
    );
  readonly remoteWorkspaceViewModel: RemoteWorkspaceViewModel =
    new RemoteWorkspaceViewModel(
      this.remotePageState,
      this.workspaceCoordinator,
      {
        isRemoteAvailable: (): boolean => this.remoteConnectionController.ensureAvailable(),
        remoteTargetId: (): string => this.remotePageState.controlTargetDeviceId,
        isBusy: (): boolean => this.remotePageState.isBusy,
        onBusy: (isBusy: boolean): void => {
          this.remotePageState.setBusy(isBusy);
        },
        onStatus: (statusText: string): void => {
          this.remotePageState.setStatusText(statusText);
        },
        onWorkspaceSelected: (workspace: WorkspaceInfo): void => {
          this.remoteConnectionController.applyWorkspace(workspace);
          this.remoteSessionController.clearSessions();
        },
        onCatalogLoading: (targetId: string): void => {
          this.deviceDirectoryViewModel.beginLiveCatalog(targetId);
        },
        onCatalogLoaded: (targetId: string, workspaces: RecentWorkspaceEntry[]): void => {
          this.deviceDirectoryViewModel.completeLiveCatalog(targetId, workspaces);
        },
        onCatalogFailed: (targetId: string): void => {
          this.deviceDirectoryViewModel.failLiveCatalog(targetId);
        },
        onRefreshSessions: async (): Promise<void> => {
          await this.remoteSessionViewModel.refreshSessions();
        },
        onConnectionFailure: (error: Object): void => {
          this.failRemoteConnection(error);
        }
      }
    );
  remoteWorkspaceSessions: RemoteSession[] = [];
  readonly appShellViewModel: AppShellViewModel = new AppShellViewModel();
  readonly appShellState: AppShellState = this.appShellViewModel.state;
  readonly localeController: LocaleController = new LocaleController(
    this.localePreferenceStore,
    {
      onLanguageChanged: (_language: string): void => {
        this.appShellState.setLocaleRevision(RemoteI18n.revision());
        this.refreshLocalizedRuntimeCopy();
      }
    }
  );
  readonly voiceInputLifecycleController: VoiceInputLifecycleController =
    new VoiceInputLifecycleController(
      this.voiceInputService,
      {
        currentInputText: (): string => this.conversationController.visibleChatInput(),
        currentStatusText: (): string => this.conversationController.visibleStatusText(),
        onInputText: (routeId: string, text: string) => {
          this.conversationController.setChatInput(routeId as AppRoute, text);
        },
        onListening: (routeId: string, isListening: boolean) => {
          this.conversationController.setVoiceListening(routeId as AppRoute, isListening);
        },
        onStatusText: (statusText: string) => {
          this.conversationController.setVisibleStatusText(statusText);
        },
        onError: (message: string) => {
          this.showVoiceInputError(message);
        }
      }
    );
  readonly remoteSessionController: RemoteSessionController =
    new RemoteSessionController(
      this.sessionManager,
      8,
      {
        onSessions: (sessions: RemoteSession[], hasMore: boolean) => {
          const extras = this.remoteWorkspaceSessions.filter((item: RemoteSession) => {
            return item.workspacePath !== this.remotePageState.workspacePath;
          });
          this.publishRemoteSessions(this.mergeSessions(sessions, extras), hasMore);
        },
        onActiveSession: (session: SessionSummary) => {
          this.conversationController.applyRemoteActiveSession(session);
        },
        onStatusText: (statusText: string) => {
          this.remotePageState.setStatusText(statusText);
        },
        onBusy: (isBusy: boolean) => {
          this.remotePageState.setBusy(isBusy);
        },
        onLoading: (isLoading: boolean) => {
          this.remotePageState.setLoading(isLoading);
        },
        onSessionError: (errorText: string) => {
          this.remotePageState.setError(errorText);
        },
        onReconnecting: () => {
          this.remotePageState.setConnectionState(ConnectionState.Reconnecting);
        },
        onConnected: () => {
          this.remotePageState.setConnectionState(ConnectionState.Connected);
          // A live link outranks the relay's presence answer, and that override
          // is applied where the list is published, not where it is read.
          this.settingsController.resyncAccountDevicePresence();
        },
        onConnectionFailed: (err: Object) => {
          this.failRemoteConnection(err);
        },
        onStartHeartbeat: () => {
          this.remoteActivityViewModel.startHeartbeat();
        }
      }
    );
  readonly remoteChatCommandController: RemoteChatCommandController =
    new RemoteChatCommandController(
      this.sessionManager,
      {
        onMessagesLoaded: (messages: ChatMessage[], hasMoreMessages: boolean) => {
          this.chatTimelineStore.setPersistedMessages(messages);
          this.remotePageState.setHasMoreMessages(hasMoreMessages);
          this.conversationController.syncRemoteTimeline();
        },
        onMessageCountKnown: (pollVersion: number, knownMessageCount: number) => {
          this.conversationController.updateKnownMessageCount(pollVersion, knownMessageCount);
        },
        onTimelineReady: () => {
          this.remotePageState.setConversationLoading(false);
        },
        onComposerSubmitted: (sessionId: string, text: string, images: SelectedImageAttachment[]) => {
          if (this.remotePageState.activeSession.sessionId !== sessionId) {
            return;
          }
          if (this.remotePageState.chatInput.trim() === text.trim()) {
            this.remotePageState.setChatInput('');
          }
          this.remotePageState.setSelectedImages(this.remotePageState.selectedImages.filter(
            (image: SelectedImageAttachment) => !images.some((sent: SelectedImageAttachment) => sent.id === image.id)
          ));
        },
        onSendSucceeded: (turnId: string, pendingActiveId: string, localMessageId: string) => {
          this.chatTimelineStore.acknowledgeOptimisticTurn(localMessageId, turnId);
          if (turnId.length > 0) {
            this.chatTimelineStore.setLocalActiveTurn(turnId);
            this.conversationController.syncRemoteTimeline();
          } else if (pendingActiveId.length > 0) {
            this.chatTimelineStore.clearPendingActiveTurn(pendingActiveId);
            this.conversationController.syncRemoteTimeline();
          }
          this.taskCompletionNotificationController.track({
            source: 'remote',
            sessionId: this.remotePageState.activeSession.sessionId || '',
            turnId
          });
          this.remoteChatPollingLifecycleController.nudge();
        },
        onSteerSucceeded: (
          steeringId: string,
          turnId: string,
          displayText: string,
          images: SelectedImageAttachment[]
        ) => {
          this.chatTimelineStore.appendSteeringItem(turnId, steeringId, displayText, images);
          this.conversationController.syncRemoteTimeline();
          this.remoteChatPollingLifecycleController.nudge();
        },
        onSendFailed: (
          rawText: string,
          images: SelectedImageAttachment[],
          localMessageId: string,
          pendingActiveId: string
        ) => {
          this.chatTimelineStore.markOptimisticMessageFailed(localMessageId);
          if (pendingActiveId.length > 0) {
            this.chatTimelineStore.clearPendingActiveTurn(pendingActiveId);
          }
          this.conversationController.syncRemoteTimeline();
        },
        onActiveSession: (session: SessionSummary) => {
          this.conversationController.applyRemoteActiveSession(session);
        },
        onSessionTitleChanged: (sessionId: string, title: string) => {
          this.remoteSessionController.updateSessionTitle(sessionId, title);
        },
        onStatusText: (statusText: string) => {
          this.remotePageState.setStatusText(statusText);
        },
        onToast: (message: string) => {
          this.conversationController.showHomeToast(message);
        },
        onBusy: (isBusy: boolean) => {
          this.remotePageState.setBusy(isBusy);
        },
        onPollRequested: () => {
          this.remoteChatPollingLifecycleController.nudge();
        }
      },
      this.remoteChatCache
    );
  readonly remoteFileDownloadController: RemoteFileDownloadController =
    new RemoteFileDownloadController(
      this.sessionManager,
      (downloadingFilePath: string, downloadedFilePath: string, fileDownloadStatus: string) => {
        this.remotePageState.setDownloadStatus(downloadingFilePath, downloadedFilePath, fileDownloadStatus);
      },
      () => {
        this.remotePageState.clearDownloadingFilePath();
      },
      (statusText: string) => {
        this.remotePageState.setStatusText(statusText);
      },
      (isBusy: boolean) => {
        this.remotePageState.setBusy(isBusy);
      }
    );
  readonly filePreviewController: FilePreviewController =
    new FilePreviewController(
      this.sessionManager,
      this.filePreviewState,
      {
        remoteAvailable: (): boolean => RemoteUiState.canUseRemote((this.remotePageState.connectionState as ConnectionState)),
        activeSession: (): SessionSummary => this.remotePageState.conversation.activeSession,
        workspacePath: (): string => this.remotePageState.workspacePath,
        openExternalLink: async (reference: string): Promise<boolean> =>
          this.host.openExternalLink ? await this.host.openExternalLink(reference) : false,
        onGeneralStatus: (statusText: string): void => this.generalChatPageState.setStatus(statusText),
        onRemoteStatus: (statusText: string): void => this.remotePageState.setStatusText(statusText)
      }
    );
  readonly remoteToolActionController: RemoteToolActionController =
    new RemoteToolActionController(
      this.sessionManager,
      (statusText: string) => {
        this.remotePageState.setStatusText(statusText);
      },
      (isBusy: boolean) => {
        this.remotePageState.setBusy(isBusy);
      },
      () => {
        this.remoteChatPollingLifecycleController.nudge();
      }
    );
  readonly remoteChatPollingLifecycleController: RemoteChatPollingLifecycleController =
    new RemoteChatPollingLifecycleController(
      this.sessionManager,
      {
        canPoll: (sessionId: string) => {
          return this.remotePageState.activeSession.sessionId === sessionId &&
            this.isRemoteConversationContext(sessionId) &&
            this.remoteConnectionController.ensureAvailable();
        },
        onSnapshot: (snapshot: RemoteChatPollingSnapshot) => {
          this.conversationController.applyRemoteSnapshot(snapshot);
          if (snapshot.activeTurn && snapshot.activeTurn.id.length > 0) {
            const status = (snapshot.activeTurn.status || '').toLowerCase();
            if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
              if (this.taskCompletionNotificationController.cancel('remote', snapshot.sessionId)) {
                this.remoteChatPollingLifecycleController.stop();
              }
            } else {
              this.trackRemoteTaskCompletion(snapshot.sessionId, snapshot.activeTurn);
            }
          } else if (snapshot.sessionState.toLowerCase() === 'idle' && snapshot.completedTurnId.length === 0 &&
            this.taskCompletionNotificationController.cancel('remote', snapshot.sessionId)) {
            this.remoteChatPollingLifecycleController.stop();
          }
          if (snapshot.completedTurnId.length > 0 &&
            this.taskCompletionNotificationController.complete(
              'remote', snapshot.sessionId, snapshot.completedTurnId
            )) {
            this.remoteChatPollingLifecycleController.stop();
          }
        },
        onError: (error: Object) => {
          this.remotePageState.setStatusText(ConnectionErrorPolicy.errorText(error));
        }
      }
    );
  readonly remoteModelController: RemoteModelController =
    new RemoteModelController(
      this.sessionManager,
      this.identityStore,
      (modelCatalog: RemoteModelCatalog, selectedModelId: string, knownModelCatalogVersion: number) => {
        this.conversationController.updateKnownModelCatalogVersion(knownModelCatalogVersion);
        this.remotePageState.setModelCatalog(modelCatalog, selectedModelId);
      },
      (modelCatalog: RemoteModelCatalog, selectedModelId: string, knownModelCatalogVersion: number) => {
        this.conversationController.updateKnownModelCatalogVersion(knownModelCatalogVersion);
        this.chatTimelineStore.setModelCatalog(modelCatalog, selectedModelId);
        this.remotePageState.setModelCatalog(modelCatalog, selectedModelId);
      },
      (statusText: string) => {
        this.remotePageState.setStatusText(statusText);
      },
      (isBusy: boolean) => {
        this.remotePageState.setBusy(isBusy);
      }
    );
  readonly remoteSessionViewModel: RemoteSessionViewModel =
    new RemoteSessionViewModel(
      this.remotePageState,
      this.remoteSessionController,
      this.remoteChatCommandController,
      this.remoteModelController,
      this.remoteFileDownloadController,
      {
        remoteAvailable: (): boolean => this.remoteConnectionController.ensureAvailable(),
        isConnected: (): boolean => (this.remotePageState.connectionState as ConnectionState) === ConnectionState.Connected,
        isBusy: (): boolean => this.remotePageState.isBusy,
        onBusy: (busy: boolean): void => this.remotePageState.setBusy(busy),
        onRouteChat: (sessionId: string): void => this.conversationController.routeCreatedRemoteSession(sessionId),
        onRouteHome: (): void => this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteHome),
        onStopPolling: (): void => this.remoteChatPollingLifecycleController.stop(),
        onStartPolling: (): void => this.conversationController.startRemotePolling(),
        onNudgePolling: (): void => this.remoteChatPollingLifecycleController.nudge(),
        onResetTimeline: (sessionId: string): void => this.conversationController.resetRemoteTimeline(sessionId),
        onClearRemoteFiles: (): void => this.remoteFileDownloadController.clear(),
        onKnownStateReset: (): void => this.conversationController.resetKnownRemoteState(),
        onLoadActiveMessages: async (): Promise<void> => {
          await this.conversationController.loadRemoteMessages();
        },
        onCreatedSession: async (session: SessionSummary): Promise<void> => {
          await this.reconcileCreatedRemoteSession(session);
        },
        onRefreshSessions: async (): Promise<void> => {
          await this.remoteSessionController.refresh(
            this.remotePageState.sessionQuery,
            this.remotePageState.sessionFilter,
            this.remoteConnectionController.ensureAvailable(),
            (this.remotePageState.connectionState as ConnectionState) === ConnectionState.Connected
          );
        },
        onSelectWorkspace: async (path: string): Promise<void> => {
          await this.selectWorkspace(path);
        }
      }
    );
  protected trackRemoteTaskCompletion(sessionId: string, activeTurn: ChatMessage): void {
    const status = (activeTurn.status || '').toLowerCase();
    if (status !== 'active' && status !== 'completed' && status !== 'done' && status !== 'success') {
      return;
    }
    const explicitTurnId = (activeTurn.turnId || '').trim();
    const turnId = explicitTurnId.length > 0 ? explicitTurnId :
      (activeTurn.id.indexOf('active-') === 0 ? activeTurn.id.slice('active-'.length) : '');
    this.taskCompletionNotificationController.track({ source: 'remote', sessionId, turnId });
  }
  readonly remoteConnectionController: RemoteConnectionController =
    new RemoteConnectionController(
      this.remotePageState,
      this.identityStore,
      this.remoteConnectionCoordinator,
      this.remoteSessionController,
      this.remoteModelController,
      this.remoteFileDownloadController,
      this.clipboardService,
      this.qrScanService,
      (sessionId: string): void => this.conversationController.resetRemoteTimeline(sessionId),
      (): void => this.conversationController.resetKnownRemoteState(),
      (): void => this.remoteActivityViewModel.startHeartbeat(),
      (): void => this.remoteActivityViewModel.stopHeartbeat(),
      (): void => this.remoteChatPollingLifecycleController.stop(),
      async (): Promise<void> => {
        await this.remoteWorkspaceViewModel.loadRecentWorkspacesInBackground();
      },
      this.clearCachedRemoteData,
      (route: AppRoute): void => this.appShellViewModel.replaceRouteWithoutAnimation(route),
      (): void => this.dismissConnectSheetAfterSuccess(),
      (): void => this.openConnectSheet()
    );
  readonly settingsController: SettingsController =
    new SettingsController(
      {
        client: new CloudAccountClient(),
        sessionStore: new CloudAccountSessionStore(),
        profileLoader: new GitHubAccountProfileClient(),
        sessionManager: this.sessionManager,
        remoteState: this.remotePageState,
        hooks: {
          deviceId: (): string => this.remoteConnectionController.getDeviceId(),
          openAuthorization: async (url: string): Promise<boolean> => this.host.openExternalLink ? await this.host.openExternalLink(url) : false,
          remoteAvailable: (): boolean => this.remoteConnectionController.ensureAvailable(),
          invalidatePreview: (): void => this.filePreviewController.invalidate(),
          invalidateRemoteActivity: (): void => this.remoteActivityViewModel.invalidate(),
          invalidateRemoteConnection: (): void => this.remoteConnectionCoordinator.invalidate(),
          stopPolling: (): void => this.remoteChatPollingLifecycleController.stop(),
          stopHeartbeat: (): void => this.remoteActivityViewModel.stopHeartbeat(),
          startHeartbeat: (): void => this.remoteActivityViewModel.startHeartbeat(),
          resetTimeline: (): void => this.conversationController.resetRemoteTimeline(''),
          resetKnownRemoteState: (): void => this.conversationController.resetKnownRemoteState(),
          clearCachedRemoteData: this.clearCachedRemoteData,
          closeSettings: (): void => this.appShellState.setSettingsVisible(false),
          closeConnectSheet: (): void => this.dismissConnectSheetAfterSuccess(),
          navigateRemoteHome: (): void => this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteHome),
          loadRecentWorkspaces: async (): Promise<void> => {
            await this.remoteWorkspaceViewModel.loadRecentWorkspacesInBackground();
          },
          saveControlTargetType: async (controlTargetType: string): Promise<void> => {
            await this.remoteConnectionController.rememberControlTargetType(controlTargetType);
          },
          onAccountDevices: (devices: CloudAccountDevice[]): void => {
            this.deviceDirectoryViewModel.syncDevices(devices);
          },
          onBeforeControlTargetChange: (): void => {
            this.captureLiveControlTarget();
          },
          onControlTargetLoading: (deviceId: string): void => {
            this.deviceDirectoryViewModel.beginLiveCatalog(deviceId);
          },
          onControlTargetChanged: (): void => {
            this.activateLiveControlTarget();
          }
        }
      }
    );
  readonly deviceDirectoryViewModel: DeviceDirectoryViewModel =
    new DeviceDirectoryViewModel(
      this.deviceDirectoryState,
      {
        credentials: () => this.settingsController.activeCloudAccount(),
        activeDeviceId: (): string => {
          return this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId;
        },
        activeDeviceConnected: (): boolean =>
          (this.remotePageState.connectionState as ConnectionState) === ConnectionState.Connected
      },
      this.remoteSessionListStore
    );
  readonly conversationController: ConversationController =
    new ConversationController(
      this.generalChatPageState,
      this.remotePageState,
      { currentRoute: (): AppRoute => this.appShellViewModel.currentRoute() },
      {
        timeline: this.chatTimelineStore,
        chat: this.remoteChatCommandController,
        chatCache: this.remoteChatCache,
        polling: this.remoteChatPollingLifecycleController,
        models: this.remoteModelController,
        files: this.remoteFileDownloadController,
        tools: this.remoteToolActionController,
        connection: this.remoteConnectionController,
        imagePicker: this.imagePickerService,
        clipboard: this.clipboardService,
        sessions: this.remoteSessionViewModel,
        sessionManager: this.sessionManager,
        workspace: this.workspaceCoordinator,
        settings: this.settingsController,
        appShell: this.appShellViewModel,
        filePreview: this.filePreviewController,
        hooks: {
          isConversationContext: (sessionId: string): boolean => this.isRemoteConversationContext(sessionId),
          isFilePreviewVisible: (): boolean => this.filePreviewState.visible,
          stopVoiceInput: async (): Promise<void> => this.stopVoiceInput(false),
          showToast: (message: string): boolean => this.host.showToast(message, 2600),
          selectAssistantWorkspace: async (path: string): Promise<void> => {
            await this.selectAssistant(path);
          }
        }
      }
    );
  readonly conversationIntentDispatcher: ConversationIntentDispatcher =
    new ConversationIntentDispatcher({
      openSidebar: (): void => this.openAppSidebar(),
      back: (): void => this.exitActiveChat(),
      newRemoteSession: (): void => { this.conversationController.createRemoteSession('code'); },
      unsupported: (): void => this.conversationController.showHomeToast(RemoteI18n.t('remote.actionUnsupported')),
      stop: async (): Promise<void> => { await this.conversationController.stopVisibleTask(); },
      loadOlder: async (): Promise<void> => { await this.conversationController.loadOlderRemoteMessages(); },
      approve: async (id: string, input?: Object): Promise<void> => {
        await this.conversationController.approveRemoteTool(id, input);
      },
      reject: async (id: string): Promise<void> => { await this.conversationController.rejectRemoteTool(id); },
      cancel: async (id: string): Promise<void> => { await this.conversationController.cancelRemoteTool(id); },
      answer: async (id: string, answers: RemoteQuestionAnswerPayload): Promise<void> => {
        await this.conversationController.answerRemoteQuestion(id, answers);
      },
      rename: async (title: string): Promise<void> => {
        await this.conversationController.renameVisibleSession(title);
      },
      copy: async (text: string): Promise<void> => { await this.conversationController.copyRemoteMessage(text); },
      retry: async (text: string): Promise<void> => { await this.conversationController.retryVisibleMessage(text); },
      selectModel: async (id: string): Promise<void> => { await this.conversationController.selectVisibleModel(id); },
      pickImages: async (): Promise<void> => { await this.pickImages(); },
      removeImage: (id: string): void => this.conversationController.removeSelectedImage(this.appShellViewModel.currentRoute(), id),
      openFilePreview: (route: AppRoute, request: FilePreviewRequest): void =>
        this.filePreviewController.open(route, request),
      downloadFile: (path: string): void => this.conversationController.downloadVisibleFile(path),
      buildPlan: async (path: string, name: string): Promise<void> => {
        await this.conversationController.buildRemotePlan(path, name);
      },
      send: async (): Promise<void> => { await this.conversationController.sendVisibleMessage(); },
      voiceInput: async (): Promise<void> => { await this.toggleVoiceInput(); },
      inputChanged: (route: AppRoute, value: string): void =>
        this.conversationController.onVisibleChatInputChange(route, value)
    });
  readonly presentationActions: AppRootPresentationActions = {
    onNavigationBack: (route: AppRoute): boolean => this.handleNavigationBack(route),
    onConversationIntent: (route: AppRoute, intent: ConversationIntent): void =>
      this.conversationIntentDispatcher.dispatch(route, intent),
    onCloseSidebar: (): void => this.closeAppSidebar(),
    onCompactLayoutEntered: (): void => this.enterCompactLayout(),
    onLayoutModeChanged: (wideLayout: boolean): void => this.appShellState.setWideLayout(wideLayout),
    onRemoteHome: {
      openMiniApps: (): void => { this.closeAppSidebar(); this.miniAppViewModel.actions.open(); },
      openSidebar: (): void => this.openAppSidebar(),
      connectWorkspace: (): void => this.openConnectSheet(),
      addConnection: (): void => this.openConnectSheet(),
      openSettings: (): void => this.openRemoteControlSettings(),
      refresh: (): void => { this.remoteSessionViewModel.refreshSessions(); },
      showWorkspaces: (): void => { this.remoteWorkspaceViewModel.toggleRecentWorkspaces(); },
      showAssistants: (): void => { this.remoteWorkspaceViewModel.toggleAssistants(); },
      selectWorkspace: (path: string, deviceId?: string): void => {
        void this.selectWorkspaceOnDevice(path, deviceId);
      },
      selectAssistant: (path: string): void => { this.selectAssistant(path); },
      cancelWorkspace: (): void => this.remotePageState.setWorkspacePickerVisible(false),
      cancelAssistant: (): void => this.remotePageState.setAssistantPickerVisible(false),
      queryChanged: (query: string): void => this.remotePageState.setQuery(query),
      search: (): void => { this.remoteSessionViewModel.refreshSessions(); },
      loadMore: (): void => { this.remoteSessionViewModel.loadMoreSessions(); },
      reconnect: (): void => { this.reconnect(); },
      disconnect: (): void => { this.disconnect(false); },
      clearPairing: (): void => { this.disconnect(true); },
      create: (agentType: string): void => { this.conversationController.createRemoteSession(agentType); },
      createInPlace: (agentType: string): void => {
        this.conversationController.createRemoteSession(agentType, true);
      },
      createInWorkspace: (path: string, agentType: string, deviceId?: string): void => {
        this.conversationController.createRemoteSessionInWorkspace(path, agentType, false, deviceId);
      },
      createInWorkspaceInPlace: (path: string, agentType: string, deviceId?: string): void => {
        this.conversationController.createRemoteSessionInWorkspace(path, agentType, true, deviceId);
      },
      selectDirectoryDevice: (deviceId: string): void => {
        void this.selectDirectoryDevice(deviceId);
      },
      addDirectoryWorkspace: (deviceId: string): void => {
        void this.openWorkspacePickerOnDevice(deviceId);
      },
      retryDirectoryDevice: (deviceId: string): void => {
        void this.retryDirectoryDevice(deviceId);
      },
      loadWorkspaceSessions: async (deviceId: string, path: string): Promise<void> => {
        await this.loadWorkspaceSessionsOnDevice(deviceId, path);
      },
      openSession: (session: RemoteSession): void => this.conversationController.openHomeSession(session),
      openSessionInPlace: (session: RemoteSession): void => this.conversationController.openHomeSession(session, true),
      deleteSession: (session: RemoteSession): void => { this.conversationController.deleteHomeSession(session); }
    },
    onSidebar: {
      close: (): void => this.closeAppSidebar(),
      newChat: async (agentType: string = 'code'): Promise<void> => {
        if (!SidebarConnectionActionPolicy.canCreateSession(this.remotePageState.connectionState, this.remotePageState.isBusy)) return;
        this.closeAppSidebar();
        await this.conversationController.createRemoteSession(agentType);
      },
      enterCode: (): void => { this.closeAppSidebar(); this.enterCodeEntry(); },
      scanDesktop: (): void => { this.closeAppSidebar(); this.openConnectSheet(CONNECT_INTENT_SCAN); },
      addDesktop: (): void => {
        this.closeAppSidebar();
        this.openConnectSheet(CONNECT_INTENT_SCAN);
      },
      refreshDevices: async (): Promise<void> => {
        await this.settingsController.refreshAccountDevicesIfStale(0);
      },
      settings: (): void => { this.closeAppSidebar(); this.appShellState.openSettings('general'); },
      openAccount: (): void => {
        this.closeAppSidebar();
        setTimeout(() => this.appShellState.openSettings('account'), 180);
      },
      openSession: (session: RemoteSession): void => {
        // The shell supplies the horizontal motion; do not stack a second
        // NavDestination push animation on top of the closing drawer.
        this.closeAppSidebar();
        this.conversationController.openHomeSession(session, true);
      },
      deleteSession: (session: RemoteSession): void => { this.conversationController.deleteHomeSession(session); }
    },
    onSettings: {
      close: (): void => this.appShellState.leaveSettings(),
      addConnection: (): void => this.openAddConnectionFromSettings(),
      disconnect: (): void => { this.disconnect(false); },
      clearPairing: (): void => {
        this.appShellState.setSettingsVisible(false);
        this.disconnect(true);
      },
      reconnect: (): void => { this.reconnect(); },
      openAccount: (): void => { this.appShellState.openSettings('account'); },
      cloudCancelLogin: (): void => this.settingsController.cancelCloudLogin(),
      cloudLogin: async (): Promise<string> => {
        const user = await this.settingsController.loginCloudAccount();
        const pending = this.pendingAccountDeviceId;
        this.pendingAccountDeviceId = '';
        if (pending.length > 0) {
          await this.connectAccountDeviceLink(pending);
        }
        return user;
      },
      cloudLogout: (): Promise<void> => this.settingsController.logoutCloudAccount(),
      cloudListDevices: (): Promise<CloudAccountDevice[]> => this.settingsController.listCloudAccountDevices(),
      cloudSelectDevice: (device: CloudAccountDevice): Promise<void> =>
        this.settingsController.selectCloudAccountDevice(device),
      getPermissionMode: (): Promise<RemotePermissionMode> => this.settingsController.getRemotePermissionMode(),
      setPermissionMode: (mode: RemotePermissionMode): Promise<RemotePermissionMode> =>
        this.settingsController.setRemotePermissionMode(mode),
      setLanguage: async (language: string): Promise<void> => {
        await this.localeController.setLanguage(language);
      }
    },
    onConnect: {
      back: (): void => this.appShellState.setConnectSheetVisible(false),
      openAccount: (): void => {
        this.appShellState.setConnectSheetVisible(false);
        setTimeout(() => this.appShellState.openSettings('account'), 180);
      },
      connect: (password?: string): void => {
        this.connect(false, password || '');
      },
      clearPairing: (): void => { this.appShellState.setConnectSheetVisible(false); this.disconnect(true); },
      urlChanged: (url: string): void => { this.remotePageState.setRemoteUrl(url); },
      userChanged: (user: string): void => this.remotePageState.setUserId(user),
      detected: (url: string): string => this.handleDetectedRemoteUrl(url),
      inputVisible: (visible: boolean): void => this.remotePageState.setRemoteUrlInputVisible(visible),
      paste: (): void => { void this.remoteConnectionController.paste(this.host.context()); },
      scan: (): void => { void this.scanRemotePairCode(); },
      cloudListDevices: (): Promise<CloudAccountDevice[]> => this.settingsController.listCloudAccountDevices(),
      cloudSelectDevice: (device: CloudAccountDevice): Promise<void> =>
        this.settingsController.selectCloudAccountDevice(device)
    },
    onFilePreview: {
      close: (): void => this.filePreviewController.close(),
      refresh: (): void => this.filePreviewController.refresh(),
      download: (path: string): void => this.conversationController.downloadVisibleFile(path),
      openLink: (reference: string, label: string): void => this.filePreviewController.openLink(reference, label)
    },
    generalStatus: (): string => ''
  };
  readonly navigationStack: NavPathStack = this.appShellViewModel.navigationStack;

  private captureLiveControlTarget(): void {
    const deviceId = this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId;
    this.deviceDirectoryViewModel.captureLive(
      deviceId,
      this.remotePageState.recentWorkspaces,
      this.remotePageState.sessions
    );
  }

  private activateLiveControlTarget(): void {
    const deviceId = this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId;
    this.deviceDirectoryViewModel.activateLive(
      deviceId,
      this.remotePageState.recentWorkspaces,
      this.remotePageState.sessions
    );
  }

  enterCodeEntry(): void {
    this.enterRemoteSurface();
  }

  enterRemoteSurface(): void {
    this.appShellState.setConnectSheetVisible(false);
    if (this.appShellState.wideLayout) {
      void this.enterRemoteSurfaceWide();
      return;
    }
    void this.enterRemoteSurfaceCompact();
  }

  openConnectSheet(intent: string = CONNECT_INTENT_AUTO): void {
    const kind = intent === CONNECT_INTENT_SCAN ?
      RemoteConnectEntryKind.OpenScan : RemoteConnectEntryKind.OpenConnect;
    if (!RemoteSurfaceEntryPolicy.shouldOpenConnectSheet(kind)) {
      this.enterRemoteSurface();
      return;
    }
    this.appShellState.setConnectSheetVisible(true, intent);
  }

  /**
   * Close the sheet only after a connect that the user is watching on it.
   * Heartbeat reconnects and background restores must not steal the current
   * route just because they also go through the same success path.
   */
  dismissConnectSheetAfterSuccess(): void {
    const opened = this.appShellState.showConnectSheet;
    this.appShellState.setConnectSheetVisible(false);
    if (opened) {
      this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteHome);
    }
  }

  refreshLocalizedRuntimeCopy(): void {
    this.remotePageState.setStatusText(RemoteI18n.retranslateKnown(
      this.remotePageState.statusText,
      [
        ConnectionStatusPresenter.labelKey(this.remotePageState.connectionState),
        'status.restoringConnection',
        'status.waitingConnection',
        'status.notConnected'
      ]
    ));
    this.remotePageState.setError(RemoteI18n.retranslate(this.remotePageState.sessionErrorText));
    this.remotePageState.setWorkspace(
      RemoteI18n.retranslateKnown(this.remotePageState.workspaceName, ['status.notConnected']),
      this.remotePageState.workspacePath,
      this.remotePageState.assistantId,
      this.remotePageState.workspaceBranch,
      this.remotePageState.workspaceKind
    );
    this.remotePageState.setDownloadStatus(
      this.remotePageState.downloadingFilePath,
      this.remotePageState.downloadedFilePath,
      RemoteI18n.retranslate(this.remotePageState.fileDownloadStatus)
    );
    this.filePreviewState.errorText = RemoteI18n.retranslate(this.filePreviewState.errorText);
  }

  private pendingAccountDeviceId: string = '';

  handleDetectedRemoteUrl(url: string): string {
    const link = accountDeviceLink(url);
    if (!link) {
      this.remotePageState.setStatusText(RemoteI18n.t('connect.deviceLinkInvalid'));
      this.remotePageState.setConnectionState(ConnectionState.Failed);
      return DetectedUrlAction.INVALID;
    }
    const deviceId = link.deviceId;
    this.remotePageState.setRemoteUrl(url);
    if (this.settingsController.cloudRelayEndpoint() !== link.relayUrl) {
      this.settingsController.selectAccountRelay(link.relayUrl);
    }
    if (!this.settingsController.hasCloudAccountSession()) {
      this.pendingAccountDeviceId = deviceId;
      this.appShellState.setConnectSheetVisible(false);
      this.appShellState.openSettings('account');
      return DetectedUrlAction.SHOW_CLOUD_DEVICES;
    }
    void this.connectAccountDeviceLink(deviceId);
    return DetectedUrlAction.USE_CLOUD_DEVICE;
  }

  private async connectAccountDeviceLink(deviceId: string): Promise<void> {
    try {
      const devices = await this.settingsController.listCloudAccountDevices();
      const device = devices.find((item: CloudAccountDevice): boolean => item.deviceId === deviceId && item.online);
      if (!device) {
        throw new Error(RemoteI18n.t('connect.deviceLinkUnavailable'));
      }
      await this.settingsController.selectCloudAccountDevice(device);
    } catch (err) {
      this.remotePageState.setStatusText(ConnectionErrorPolicy.errorText(err));
      this.remotePageState.setConnectionState(ConnectionState.Failed);
    }
  }

  async scanRemotePairCode(): Promise<void> {
    const text = await this.remoteConnectionController.scan(this.host.context());
    if (text.length === 0) {
      return;
    }
    const action = this.handleDetectedRemoteUrl(text);
  }
}
