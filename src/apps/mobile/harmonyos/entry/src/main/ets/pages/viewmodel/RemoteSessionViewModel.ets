import { RemoteSession, SessionSummary } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteChatCommandController } from '../../services/RemoteChatCommandController';
import { RemoteModelController } from '../../services/RemoteModelController';
import { RemoteSessionController } from '../../services/RemoteSessionController';
import { RemoteFileDownloadController } from '../../services/RemoteFileDownloadController';
import { DeferredLoadingGate } from '../../services/DeferredLoadingGate';
import { RemoteLogger } from '../../services/RemoteLogger';
import { MainThreadStallProbe } from '../../services/MainThreadStallProbe';
import { RemotePageState } from '../state/RemotePageState';

export interface RemoteSessionViewModelHooks {
  readonly remoteAvailable: () => boolean;
  readonly isConnected: () => boolean;
  readonly isBusy: () => boolean;
  readonly onBusy: (busy: boolean) => void;
  readonly onRouteChat: (sessionId: string) => void;
  readonly onRouteHome: () => void;
  readonly onStopPolling: () => void;
  readonly onStartPolling: () => void;
  readonly onNudgePolling: () => void;
  readonly onResetTimeline: (sessionId: string) => void;
  readonly onClearRemoteFiles: () => void;
  readonly onKnownStateReset: () => void;
  readonly onLoadActiveMessages: () => Promise<void>;
  readonly onCreatedSession: (session: SessionSummary) => Promise<void>;
  readonly onRefreshSessions: () => Promise<void>;
  readonly onSelectWorkspace: (path: string) => Promise<void>;
}

/** Owns remote session commands and their page lifecycle effects. */
export class RemoteSessionViewModel {
  private readonly pageState: RemotePageState;
  private readonly sessions: RemoteSessionController;
  private readonly chat: RemoteChatCommandController;
  private readonly models: RemoteModelController;
  private readonly files: RemoteFileDownloadController;
  private readonly hooks: RemoteSessionViewModelHooks;
  // Long enough that a cached transcript never flashes a skeleton on its way in,
  // short enough that a transcript coming over the relay still says so.
  private readonly openLoadingGate: DeferredLoadingGate =
    new DeferredLoadingGate(140, (visible: boolean): void => this.pageState.setConversationLoading(visible));
  // How many opens this view model has started and not yet settled. Opening a
  // session raises the busy flag, so without this the flag an open sets would
  // read, to the next tap, as a run in progress.
  private openInFlight: number = 0;
  // Only the latest selection may start polling after a shared or delayed
  // transcript request settles. This is separate from the loading gate token:
  // the gate owns presentation, while this generation owns lifecycle effects.
  private openGeneration: number = 0;

  constructor(
    pageState: RemotePageState,
    sessions: RemoteSessionController,
    chat: RemoteChatCommandController,
    models: RemoteModelController,
    files: RemoteFileDownloadController,
    hooks: RemoteSessionViewModelHooks
  ) {
    this.pageState = pageState;
    this.sessions = sessions;
    this.chat = chat;
    this.models = models;
    this.files = files;
    this.hooks = hooks;
  }

  private static shortId(value: string): string {
    if (value.length <= 10) {
      return value;
    }
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  async refreshSessions(): Promise<void> {
    await this.sessions.refresh(
      this.pageState.sessionQuery,
      this.pageState.sessionFilter,
      this.hooks.remoteAvailable(),
      this.hooks.isConnected()
    );
  }

  async loadMoreSessions(): Promise<void> {
    await this.sessions.loadMore(
      this.pageState.sessionQuery,
      this.pageState.sessionFilter,
      this.hooks.isBusy(),
      this.hooks.remoteAvailable()
    );
  }

  async setFilter(filter: string): Promise<void> {
    if (this.pageState.sessionFilter === filter) {
      return;
    }
    this.pageState.setFilter(filter);
    await this.refreshSessions();
  }

  async createSession(
    agentType: string,
    instruction: string = '',
    onRouteChat: (sessionId: string) => void = this.hooks.onRouteChat,
    modelId: string = '',
    routeBeforeCreate: boolean = true
  ): Promise<void> {
    if (this.hooks.isBusy() || !this.hooks.remoteAvailable()) {
      return;
    }
    const previousSession: SessionSummary = this.copySession(this.pageState.activeSession);
    this.beginSessionCreation(onRouteChat, routeBeforeCreate);
    try {
      const created = await this.performCreateSession(agentType, instruction, onRouteChat, modelId);
      if (!created && routeBeforeCreate) {
        this.restoreAfterFailedCreation(previousSession, onRouteChat);
      }
    } finally {
      this.pageState.setConversationLoading(false);
      this.pageState.setPendingSessionId('');
    }
  }

  private async performCreateSession(
    agentType: string,
    instruction: string,
    onRouteChat: (sessionId: string) => void,
    modelId: string,
    workspacePath: string = '',
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<SessionSummary | undefined> {
    const created = await this.sessions.create(
      agentType,
      this.hooks.isBusy(),
      this.hooks.remoteAvailable(),
      async (session: SessionSummary): Promise<void> => {
        this.pageState.clearComposer();
        this.pageState.setHasMoreMessages(false);
        this.hooks.onKnownStateReset();
        this.hooks.onResetTimeline(session.sessionId);
        onRouteChat(session.sessionId);
        // The create surface has already handed its optimistic instruction to
        // the remote projection. Do not cover it with a loading veil while the
        // empty initial transcript and first turn are being synchronized.
        this.pageState.setConversationLoading(false);
        // Same ordering as openSession: whatever the new session already has to
        // show goes up first. The model picker needs no request of its own —
        // the poll started here carries the catalog back with it.
        await this.hooks.onLoadActiveMessages();
        this.hooks.onStartPolling();
        await this.hooks.onCreatedSession(session);
      },
      instruction,
      modelId,
      workspacePath,
      remoteConnectionId,
      remoteSshHost
    );
    if (created && (created.initialTurnId || '').length > 0) {
      // The first poll may have observed the newly allocated session before
      // send_message reached the host and backed off as idle. Wake it as soon
      // as the initial turn is accepted instead of hiding up to ten seconds of
      // otherwise available streaming output.
      this.hooks.onNudgePolling();
    }
    return created;
  }

  async createSessionInWorkspace(
    path: string,
    instruction: string = '',
    agentType: string = 'code',
    onRouteChat: (sessionId: string) => void = this.hooks.onRouteChat,
    modelId: string = '',
    routeBeforeCreate: boolean = true,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<void> {
    if (this.hooks.isBusy() || !this.hooks.remoteAvailable()) {
      return;
    }
    const previousSession: SessionSummary = this.copySession(this.pageState.activeSession);
    this.beginSessionCreation(onRouteChat, routeBeforeCreate);
    let created: SessionSummary | undefined;
    try {
      created = await this.performCreateSession(agentType, instruction, onRouteChat, modelId, path, remoteConnectionId, remoteSshHost);
      if (!created && routeBeforeCreate) {
        this.restoreAfterFailedCreation(previousSession, onRouteChat);
      }
    } finally {
      this.pageState.setConversationLoading(false);
      this.pageState.setPendingSessionId('');
    }
  }

  private beginSessionCreation(
    onRouteChat: (sessionId: string) => void,
    routeBeforeCreate: boolean
  ): void {
    this.hooks.onStopPolling();
    this.pageState.setPendingSessionId('');
    this.pageState.setConversationLoading(true);
    if (routeBeforeCreate) {
      onRouteChat('');
    }
  }

  private restoreAfterFailedCreation(
    previousSession: SessionSummary,
    onRouteChat: (sessionId: string) => void
  ): void {
    if (previousSession.sessionId.length === 0) {
      this.hooks.onRouteHome();
      return;
    }
    this.pageState.setActiveSession(previousSession);
    onRouteChat(previousSession.sessionId);
    this.hooks.onStartPolling();
  }

  private copySession(session: SessionSummary): SessionSummary {
    return {
      sessionId: session.sessionId,
      title: session.title,
      workspacePath: session.workspacePath,
      remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost,
      agentType: session.agentType,
      initialTurnId: session.initialTurnId
    };
  }

  async openSession(
    item: RemoteSession,
    currentWorkspacePath: string,
    onRouteChat: (sessionId: string) => void = this.hooks.onRouteChat
  ): Promise<void> {
    // A tap that arrives while another open is still in flight is a correction,
    // not a mistake: the user has picked a different session and expects that
    // one. It used to be swallowed, because `RemoteSessionController.open`
    // raises the busy flag for the whole open and this guard read that flag as
    // a run in progress — so for the second or so an uncached open takes, every
    // row in the list was dead and nothing on screen said why. Opens supersede
    // each other instead; only a run this view model did not start blocks.
    const isBusy = this.hooks.isBusy() && this.openInFlight === 0;
    const remoteAvailable = this.hooks.remoteAvailable();
    if (isBusy || item.id.length === 0 || !remoteAvailable) {
      // Dropped taps are invisible from the outside — the row simply does
      // nothing — so say which guard swallowed it.
      RemoteLogger.info(`session open ignored session=${RemoteSessionViewModel.shortId(item.id)} busy=${isBusy ? '1' : '0'} available=${remoteAvailable ? '1' : '0'}`);
      return;
    }
    if (this.openInFlight > 0 && this.pageState.activeSession.sessionId === item.id) {
      RemoteLogger.info(
        `session open coalesced session=${RemoteSessionViewModel.shortId(item.id)}`
      );
      return;
    }
    // Bracketing the open: every stage between this line and the transcript
    // reaching the screen logs, so the gap that the user feels can be pinned on
    // one of them rather than inferred from the two ends.
    RemoteLogger.info(`session open tap session=${RemoteSessionViewModel.shortId(item.id)}`);
    MainThreadStallProbe.watch('session-open', 6000);
    this.pageState.setPendingSessionId(item.id);
    // No skeleton yet. The tapped row highlights from the pending id alone, and
    // everything the detail pane needs to show the new session empty — title,
    // workspace, a cleared timeline — is set synchronously below. If the
    // transcript is cached it lands before the gate opens and the pane goes
    // straight from one conversation to the next.
    const loadingToken = this.openLoadingGate.arm();
    const openGeneration = ++this.openGeneration;
    onRouteChat(item.id);
    RemoteLogger.info(`session open routed session=${RemoteSessionViewModel.shortId(item.id)}`);
    this.openInFlight += 1;
    try {
      await this.sessions.open(
        item,
        item.workspacePath || currentWorkspacePath,
        false,
        true,
        async (session: SessionSummary): Promise<void> => {
          this.hooks.onStopPolling();
          this.hooks.onResetTimeline(item.id);
          this.hooks.onKnownStateReset();
          this.pageState.setHasMoreMessages(false);
          this.files.clear();
          this.pageState.clearComposer();
          // Transcript first: it is the thing the user opened the session to
          // see, and a cached one needs no round trip at all.
          //
          // Nothing fetches the model catalog here. The reset above puts the
          // known catalog version back to zero, so the first poll asks for the
          // catalog as part of the same request and the desktop sends it. A
          // separate `get_model_catalog` would only queue ahead of the
          // transcript — the desktop answers device RPCs one at a time, and
          // measured against this device it pushed the transcript from ~2.4s
          // out to ~5.5s.
          await this.hooks.onLoadActiveMessages();
          if (openGeneration === this.openGeneration &&
            this.pageState.activeSession.sessionId === session.sessionId) {
            this.hooks.onStartPolling();
          }
        }
      );
    } finally {
      this.openInFlight -= 1;
      this.openLoadingGate.release(loadingToken);
      // Only the tap that still owns the gate owns the highlight: a second tap
      // during the first open has already moved both.
      if (loadingToken === this.openLoadingGate.currentToken()) {
        this.pageState.setPendingSessionId('');
      }
      RemoteLogger.info(`session open settled session=${RemoteSessionViewModel.shortId(item.id)}`);
    }
  }

  async deleteSession(item: RemoteSession, currentWorkspacePath: string): Promise<void> {
    await this.sessions.delete(
      item,
      this.pageState.activeSession.sessionId,
      this.hooks.isBusy(),
      this.hooks.remoteAvailable(),
      this.pageState.sessionQuery,
      this.pageState.sessionFilter,
      async (): Promise<void> => {
        this.hooks.onStopPolling();
        await this.chat.forgetMessages(item.id);
        this.hooks.onResetTimeline('');
        this.pageState.setHasMoreMessages(false);
        this.pageState.clearComposer();
        this.models.clearCatalog();
        this.hooks.onKnownStateReset();
        this.pageState.setActiveSession({
          sessionId: '',
          title: '',
          workspacePath: currentWorkspacePath,
          agentType: 'code'
        });
        this.pageState.clearActiveSession();
        this.hooks.onRouteHome();
      }
    );
  }

  async loadActiveMessages(isChatRoute: (sessionId: string) => boolean): Promise<void> {
    const sessionId = this.pageState.activeSession.sessionId || '';
    await this.chat.loadMessages(sessionId, isChatRoute);
  }

  async loadOlderMessages(knownPollVersion: number): Promise<void> {
    await this.chat.loadOlderMessages(
      this.pageState.activeSession.sessionId || '',
      knownPollVersion,
      this.pageState.hasMoreMessages,
      this.hooks.isBusy()
    );
  }

  async selectModel(modelId: string): Promise<void> {
    await this.models.selectModel(
      modelId,
      this.pageState.activeSession.sessionId || '',
      this.hooks.isBusy(),
      this.hooks.remoteAvailable()
    );
  }
}
