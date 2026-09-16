import {
  WorkspaceInfo
} from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { ClipboardService } from '../../services/ClipboardService';
import { Encoding } from '../../services/Encoding';
import { MobileIdentitySnapshot, MobileIdentityStore } from '../../services/MobileIdentityStore';
import { RemoteFileDownloadController } from '../../services/RemoteFileDownloadController';
import { RemoteModelController } from '../../services/RemoteModelController';
import { RemoteSessionController } from '../../services/RemoteSessionController';
import { accountDeviceLink } from '../../services/AccountDeviceLink';
import { RemoteUiState } from '../../services/RemoteUiState';
import { QrScanService } from '../../services/QrScanService';
import { RemoteConnectionCoordinator } from '../../services/RemoteConnectionCoordinator';
import { RemotePageState } from '../state/RemotePageState';
import { AppRoute } from '../navigation/AppRouteContract';
import { RemoteLogger } from '../../services/RemoteLogger';

export enum RemoteConnectionState {
  Idle = 'idle',
  Parsing = 'parsing',
  Pairing = 'pairing',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Failed = 'failed',
  Disconnected = 'disconnected'
}

export class RemoteConnectionController {
  private readonly pageState: RemotePageState;
  private readonly identity: MobileIdentityStore;
  private readonly connection: RemoteConnectionCoordinator;
  private readonly sessions: RemoteSessionController;
  private readonly models: RemoteModelController;
  private readonly files: RemoteFileDownloadController;
  private readonly clipboard: ClipboardService;
  private readonly scanner: QrScanService;
  private readonly resetTimeline: (sessionId: string) => void;
  private readonly resetKnownState: () => void;
  private readonly startHeartbeat: () => void;
  private readonly stopHeartbeat: () => void;
  private readonly stopPolling: () => void;
  private readonly loadRecentWorkspaces: () => Promise<void>;
  private readonly clearCachedRemoteData: () => Promise<void>;
  private readonly replaceRoute: (route: AppRoute) => void;
  private readonly closeConnectSheet: () => void;
  private readonly openConnectSheet: () => void;
  private deviceId: string = Encoding.randomId('harmony');
  private autoReconnectAttempted: boolean = false;
  private failureCount: number = 0;
  private lockUntil: number = 0;
  private restoredControlTargetType: string = '';

  constructor(
    pageState: RemotePageState,
    identity: MobileIdentityStore,
    connection: RemoteConnectionCoordinator,
    sessions: RemoteSessionController,
    models: RemoteModelController,
    files: RemoteFileDownloadController,
    clipboard: ClipboardService,
    scanner: QrScanService,
    resetTimeline: (sessionId: string) => void,
    resetKnownState: () => void,
    startHeartbeat: () => void,
    stopHeartbeat: () => void,
    stopPolling: () => void,
    loadRecentWorkspaces: () => Promise<void>,
    clearCachedRemoteData: () => Promise<void>,
    replaceRoute: (route: AppRoute) => void,
    closeConnectSheet: () => void,
    openConnectSheet: () => void
  ) {
    this.pageState = pageState;
    this.identity = identity;
    this.connection = connection;
    this.sessions = sessions;
    this.models = models;
    this.files = files;
    this.clipboard = clipboard;
    this.scanner = scanner;
    this.resetTimeline = resetTimeline;
    this.resetKnownState = resetKnownState;
    this.startHeartbeat = startHeartbeat;
    this.stopHeartbeat = stopHeartbeat;
    this.stopPolling = stopPolling;
    this.loadRecentWorkspaces = loadRecentWorkspaces;
    this.clearCachedRemoteData = clearCachedRemoteData;
    this.replaceRoute = replaceRoute;
    this.closeConnectSheet = closeConnectSheet;
    this.openConnectSheet = openConnectSheet;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  controlTargetPreference(): string {
    return this.restoredControlTargetType;
  }

  async rememberControlTargetType(controlTargetType: string): Promise<void> {
    const normalized = controlTargetType === 'account_device' ?
      controlTargetType : '';
    this.restoredControlTargetType = normalized;
    try {
      await this.identity.saveControlTargetType(normalized);
    } catch (err) {
      // The live transport is already authoritative. A persistence failure may
      // affect the next launch, but must not turn this connection into a failure.
      RemoteLogger.warn(`control target preference persistence failed: ${String(err)}`);
    }
  }

  async restore(context: Context): Promise<void> {
    await this.restoreWithReconnectPolicy(context, true);
  }

  async restoreWithoutReconnect(context: Context): Promise<void> {
    await this.restoreWithReconnectPolicy(context, false);
  }

  private async restoreWithReconnectPolicy(context: Context, reconnect: boolean): Promise<void> {
    try {
      const snapshot: MobileIdentitySnapshot = await this.identity.init(context);
      this.deviceId = snapshot.installId;
      this.pageState.setUserId(snapshot.userId || snapshot.installId);
      this.pageState.setRemoteUrl(snapshot.remoteUrl);
      this.restoredControlTargetType = snapshot.controlTargetType === 'account_device' ? snapshot.controlTargetType : '';
      this.models.setPreferredModelId(await this.identity.getLastModelId());
      this.failureCount = snapshot.userIdFailureCount;
      this.lockUntil = snapshot.userIdLockUntil > Date.now() ? snapshot.userIdLockUntil : 0;
      if (snapshot.userIdLockUntil > 0 && this.lockUntil === 0) {
        this.failureCount = 0;
        await this.identity.clearUserIdProtection();
      }
      this.pageState.setRemoteUrlInputVisible(snapshot.remoteUrl.length > 0);
    } catch (err) {
      this.pageState.setStatusText(ConnectionErrorPolicy.errorText(err));
      this.setState(RemoteConnectionState.Failed);
    }
  }

  async disconnect(clearPairing: boolean): Promise<void> {
    this.connection.invalidate();
    this.stopPolling();
    this.stopHeartbeat();
    this.connection.reset();
    this.sessions.clearSessions();
    this.pageState.clear();
    this.resetTimeline('');
    this.pageState.setHasMoreMessages(false);
    this.models.clearCatalog();
    this.pageState.clearActiveSession();
    this.resetKnownState();
    this.files.clear();
    this.pageState.setWorkspace(RemoteI18n.t('status.notConnected'), '', '', '', 'normal');
    this.pageState.setAuthenticatedUserId('');
    this.pageState.clearControlTarget();
    this.pageState.clearWorkspaceActions();
    this.setState(RemoteConnectionState.Disconnected);
    this.pageState.setConnectionFailureKind('');
    this.pageState.setStatusText(clearPairing ? RemoteI18n.t('status.pairingCleared') : RemoteI18n.t('status.disconnected'));
    this.replaceRoute(AppRoute.RemoteHome);
    if (clearPairing) {
      this.pageState.setRemoteUrl('');
      this.pageState.setDesktopIdentity('', '');
      this.pageState.setUserId(this.deviceId);
      this.pageState.setAccountPairing(false, '');
      this.pageState.setRemoteUrlInputVisible(false);
      await this.identity.clearPairingInput();
      await this.rememberControlTargetType('');
      // Unpairing is the user saying they are done with that desktop. Leaving
      // its sessions on disk would put them back on Remote Home at the next
      // launch, with nothing behind them to open.
      await this.clearCachedRemoteData();
    } else {
      this.pageState.setRemoteUrlInputVisible(this.pageState.remoteUrl.trim().length > 0);
    }
  }

  async paste(context: Context): Promise<void> {
    try {
      this.pageState.setStatusText(RemoteI18n.t('status.readClipboard'));
      const text = (await this.clipboard.readText(context)).trim();
      if (text.length === 0) {
        this.pageState.setRemoteUrlInputVisible(true);
        this.pageState.setStatusText(RemoteI18n.t('status.clipboardEmpty'));
        return;
      }
      this.applyRemoteUrl(text);
      try {
        if (!accountDeviceLink(text)) throw new Error(RemoteI18n.t('connect.deviceLinkInvalid'));
        this.pageState.setStatusText(RemoteI18n.t('status.clipboardUrlFilled'));
      } catch (_err) {
        this.pageState.setStatusText(RemoteI18n.t('status.clipboardNeedsConfirm'));
      }
    } catch (err) {
      this.pageState.setRemoteUrlInputVisible(true);
      this.pageState.setStatusText(ConnectionErrorPolicy.errorText(err));
    }
  }

  async scan(context: Context): Promise<string> {
    try {
      this.pageState.setStatusText(RemoteI18n.t('status.openScanner'));
      const text = (await this.scanner.scanRemoteUrl(context)).trim();
      if (text.length === 0) {
        this.pageState.setStatusText(RemoteI18n.t('status.scanEmpty'));
        return '';
      }
      return text;
    } catch (err) {
      this.pageState.setRemoteUrlInputVisible(true);
      this.pageState.setStatusText(ConnectionErrorPolicy.errorText(err));
      return '';
    }
  }

  ensureAvailable(): boolean {
    if (RemoteUiState.canUseRemote(this.pageState.connectionState)) {
      return true;
    }
    this.pageState.setStatusText(RemoteI18n.t('status.remoteUnavailable'));
    return false;
  }

  applyWorkspace(workspace: WorkspaceInfo): void {
    this.pageState.setWorkspace(workspace.name, workspace.path, workspace.assistantId || '', workspace.gitBranch,
      workspace.workspaceKind || 'normal', workspace.remoteConnectionId || '', workspace.remoteSshHost || '');
  }

  private applyRemoteUrl(remoteUrl: string): void {
    this.pageState.setRemoteUrl(remoteUrl);
    this.pageState.setConnectionFailureKind('');
    this.pageState.setRemoteUrlInputVisible(true);
  }



  private setState(state: RemoteConnectionState): void {
    this.pageState.setConnectionState(state);
  }
}
