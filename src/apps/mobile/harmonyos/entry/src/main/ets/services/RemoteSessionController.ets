import {
  CreateSessionOptions,
  RemoteSession,
  SessionListResult,
  SessionSummary
} from '../model/RemoteModels';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { ConnectionErrorPolicy } from './ConnectionErrorPolicy';
import { RemoteLogger } from './RemoteLogger';
import { RemoteUiState } from './RemoteUiState';

export interface RemoteSessionClient {
  listSessions(limit: number, offset: number, query: string, agentType: string): Promise<SessionListResult>;
  createSession(
    options: CreateSessionOptions,
    onAllocated?: (session: SessionSummary) => Promise<void>
  ): Promise<SessionSummary>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface RemoteSessionControllerCallbacks {
  onSessions: (sessions: RemoteSession[], hasMore: boolean) => void;
  onActiveSession: (session: SessionSummary) => void;
  onStatusText: (statusText: string) => void;
  onBusy: (isBusy: boolean) => void;
  onLoading: (isLoading: boolean) => void;
  onSessionError: (errorText: string) => void;
  onReconnecting: () => void;
  onConnected: () => void;
  onConnectionFailed: (err: Object) => void;
  onStartHeartbeat: () => void;
}

export class RemoteSessionController {
  private readonly client: RemoteSessionClient;
  private readonly pageSize: number;
  private readonly callbacks: RemoteSessionControllerCallbacks;
  private sessions: RemoteSession[] = [];
  private hasMore: boolean = false;
  private offset: number = 0;
  private openGeneration: number = 0;
  private listGeneration: number = 0;
  private listing: boolean = false;
  private loadingMore: boolean = false;

  constructor(
    client: RemoteSessionClient,
    pageSize: number,
    callbacks: RemoteSessionControllerCallbacks
  ) {
    this.client = client;
    this.pageSize = pageSize;
    this.callbacks = callbacks;
  }

  private static shortId(value: string): string {
    if (value.length <= 10) {
      return value;
    }
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  setSessions(sessions: RemoteSession[], hasMore: boolean): void {
    this.supersedeListRequest();
    this.sessions = sessions.slice();
    this.hasMore = hasMore;
    this.offset = this.sessions.length;
    this.callbacks.onSessions(this.sessions, this.hasMore);
  }

  clearSessions(): void {
    this.supersedeListRequest();
    this.sessions = [];
    this.hasMore = false;
    this.offset = 0;
    this.callbacks.onSessions(this.sessions, this.hasMore);
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.sessions = RemoteUiState.updateSessionTitle(this.sessions, sessionId, title);
    this.offset = this.sessions.length;
    this.callbacks.onSessions(this.sessions, this.hasMore);
  }

  async refresh(
    query: string,
    filter: string,
    remoteAvailable: boolean,
    isConnected: boolean
  ): Promise<void> {
    if (!remoteAvailable) {
      return;
    }
    const generation = this.supersedeListRequest();
    this.listing = true;
    try {
      if (!isConnected) {
        this.callbacks.onReconnecting();
      }
      this.callbacks.onStatusText(RemoteI18n.t('status.refreshSessions'));
      this.callbacks.onLoading(true);
      this.offset = 0;
      const result = await this.client.listSessions(this.pageSize, this.offset, query, filter);
      if (generation !== this.listGeneration) return;
      this.sessions = result.sessions;
      this.hasMore = result.hasMore;
      this.offset = this.sessions.length;
      this.callbacks.onSessions(this.sessions, this.hasMore);
      this.callbacks.onConnected();
      this.callbacks.onStatusText(RemoteI18n.t('connection.connected'));
      this.callbacks.onStartHeartbeat();
    } catch (err) {
      if (generation !== this.listGeneration) return;
      this.callbacks.onSessionError(ConnectionErrorPolicy.errorText(err));
      this.callbacks.onConnectionFailed(err);
    } finally {
      if (generation === this.listGeneration) this.finishListRequest();
    }
  }

  async loadMore(
    query: string,
    filter: string,
    isBusy: boolean,
    remoteAvailable: boolean
  ): Promise<void> {
    if (isBusy || !this.hasMore || !remoteAvailable) {
      return;
    }
    const generation = this.supersedeListRequest();
    this.listing = true;
    this.loadingMore = true;
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onLoading(true);
      this.callbacks.onStatusText(RemoteI18n.t('status.loadMoreSessions'));
      const result = await this.client.listSessions(this.pageSize, this.offset, query, filter);
      if (generation !== this.listGeneration) return;
      this.sessions = RemoteUiState.mergeSessions(this.sessions, result.sessions);
      this.hasMore = result.hasMore;
      this.offset = this.sessions.length;
      this.callbacks.onSessions(this.sessions, this.hasMore);
      this.callbacks.onStatusText(RemoteI18n.t('status.sessionsUpdated'));
    } catch (err) {
      if (generation !== this.listGeneration) return;
      this.callbacks.onSessionError(ConnectionErrorPolicy.errorText(err));
      this.callbacks.onConnectionFailed(err);
    } finally {
      if (generation === this.listGeneration) this.finishListRequest();
    }
  }

  /** A sidebar snapshot or target reset supersedes older list responses. */
  private supersedeListRequest(): number {
    this.listGeneration++;
    this.finishListRequest();
    return this.listGeneration;
  }

  private finishListRequest(): void {
    if (this.loadingMore) this.callbacks.onBusy(false);
    if (this.listing) this.callbacks.onLoading(false);
    this.loadingMore = false;
    this.listing = false;
  }

  async create(
    agentType: string,
    isBusy: boolean,
    remoteAvailable: boolean,
    onCreated: (session: SessionSummary) => Promise<void>,
    instruction: string = '',
    modelId: string = '',
    workspacePath: string = '',
    remoteConnectionId?: string,
    remoteSshHost?: string,
    workspaceId?: string
  ): Promise<SessionSummary | undefined> {
    if (isBusy || !remoteAvailable) {
      return undefined;
    }
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onStatusText(RemoteI18n.t('status.createSession'));
      let allocationHandled = false;
      const handleAllocated = async (session: SessionSummary): Promise<void> => {
        allocationHandled = true;
        this.callbacks.onActiveSession(session);
        this.callbacks.onStatusText(RemoteI18n.t('status.sessionCreated'));
        await onCreated(session);
      };
      const session = await this.client.createSession({
        workspaceId: workspaceId?.trim() || undefined,
        agentType,
        title: '',
        instruction,
        modelId,
        workspacePath,
        remoteConnectionId,
        remoteSshHost
      }, handleAllocated);
      if (!allocationHandled) {
        await handleAllocated(session);
      } else {
        // Allocation routes immediately. Refresh the summary after the model
        // and initial turn settle without rebuilding the conversation again.
        this.callbacks.onActiveSession(session);
      }
      return session;
    } catch (err) {
      this.callbacks.onStatusText(ConnectionErrorPolicy.errorText(err));
      return undefined;
    } finally {
      this.callbacks.onBusy(false);
    }
  }

  async open(
    item: RemoteSession,
    workspacePath: string,
    isBusy: boolean,
    remoteAvailable: boolean,
    onOpened: (session: SessionSummary) => Promise<void>
  ): Promise<void> {
    if (isBusy || item.id.length === 0 || !remoteAvailable) {
      RemoteLogger.info(`open session dropped session=${RemoteSessionController.shortId(item.id)} busy=${isBusy ? '1' : '0'} available=${remoteAvailable ? '1' : '0'}`);
      return;
    }
    // Opens supersede each other, so the one that finishes first is not
    // necessarily the one still on screen. Lowering the busy flag from that one
    // would tell the composer the session it is attached to had finished
    // loading while the newer open was still fetching.
    this.openGeneration += 1;
    const generation = this.openGeneration;
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onStatusText(RemoteI18n.t('status.loadMessages'));
      const session: SessionSummary = {
        sessionId: item.id,
        title: item.title,
        workspaceId: item.workspaceIdentity?.workspaceId,
        workspacePath: item.workspaceIdentity?.path || workspacePath,
        remoteConnectionId: item.workspaceIdentity?.remoteConnectionId,
        remoteSshHost: item.workspaceIdentity?.remoteSshHost,
        agentType: item.agentType
      };
      this.callbacks.onActiveSession(session);
      await onOpened(session);
    } finally {
      if (generation === this.openGeneration) {
        this.callbacks.onBusy(false);
      }
    }
  }

  async delete(
    item: RemoteSession,
    activeSessionId: string,
    isBusy: boolean,
    remoteAvailable: boolean,
    query: string,
    filter: string,
    onDeletedActive: () => Promise<void>
  ): Promise<void> {
    if (isBusy || item.id.length === 0 || !remoteAvailable) {
      return;
    }
    try {
      this.callbacks.onBusy(true);
      this.callbacks.onStatusText(RemoteI18n.t('status.deletingSession'));
      await this.client.deleteSession(item.id);
      this.sessions = this.sessions.filter((session: RemoteSession) => session.id !== item.id);
      this.offset = this.sessions.length;
      this.callbacks.onSessions(this.sessions, this.hasMore);
      if (activeSessionId === item.id) {
        await onDeletedActive();
      }
      this.callbacks.onStatusText(RemoteI18n.t('status.sessionDeleted'));
      if (this.hasMore && this.sessions.length < this.pageSize) {
        this.callbacks.onBusy(false);
        await this.loadMore(query, filter, false, remoteAvailable);
      }
    } catch (err) {
      this.callbacks.onStatusText(ConnectionErrorPolicy.errorText(err));
    } finally {
      this.callbacks.onBusy(false);
    }
  }
}
