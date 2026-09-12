import { RemoteSession, SessionSummary } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { RemoteLogger } from '../../services/RemoteLogger';
import {
  stampRemoteSessionsDevice,
  stampRemoteSessionsWorkspace
} from '../../services/RemoteSessionIdentity';
import { RemoteUiState } from '../../services/RemoteUiState';
import { AppRootHostPort } from '../host/AppRootHostAdapter';
import { CONNECT_INTENT_SCAN } from '../state/AppShellState';
import {
  AppNavigationBackAction,
  AppRoute,
  AppRouteContract
} from '../navigation/AppRouteContract';
import {
  AppRootRuntimeComposition,
  ConnectionState
} from './AppRootRuntimeComposition';

/**
 * How stale an account device presence answer may be before returning to the
 * foreground, or opening the sidebar, refetches it. Short enough that a
 * desktop coming online is noticed in the same sitting, long enough that the
 * two events firing together on a cold start cost one request, not three.
 */
const DEVICE_PRESENCE_MAX_AGE_MS: number = 15000;

export class AppRootRuntime extends AppRootRuntimeComposition {
  private directorySelectionVersion: number = 0;

  constructor(host: AppRootHostPort) {
    super(host);
  }

  async aboutToAppear(): Promise<void> {
    await this.localeController.initialize(this.host.context());
    if (this.host.offerTaskNotifications) {
      await this.taskCompletionNotificationPort.offerOnboarding(
        (): Promise<boolean> => this.host.offerTaskNotifications!()
      );
    }
    this.syncRemotePageSummary();
    await this.remoteChatCache.init(this.host.context());
    await this.remoteSessionListCache.init(this.host.context());
    await this.restoreCachedRemoteSessions();
    await this.settingsController.initializeCloudAccount(this.host.context());
    if (this.settingsController.hasCloudAccountSession()) {
      try {
        await this.settingsController.listCloudAccountDevices();
        await this.deviceDirectoryViewModel.hydrateKnownDevices();
      } catch (err) {
        RemoteLogger.warn(`device directory restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.restoreIdentity();
    await this.startWatchProvisioning();
  }

  /**
   * Only ask for distributed data sync once the phone actually has something to
   * provision a watch with. A fresh install has nothing, and a permission
   * prompt at first launch would have no explanation behind it.
   *
   * A signed-in account counts on its own, with no desktop in sight: the phone
   * mints the watch's credential itself in that case, so waiting for a live
   * connection would keep the listener down exactly when it is not needed.
   */
  private async startWatchProvisioning(): Promise<void> {
    if (!this.settingsController.hasCloudAccountSession() && !this.hasRemoteBindingForResume()) {
      return;
    }
    await this.watchProvisionController.start(this.host.context());
  }

  onPageShow(): void {
    RemoteLogger.info(`page show state=${(this.remotePageState.connectionState as ConnectionState)} route=${this.appShellViewModel.currentRoute()}`);
    this.taskCompletionNotificationController.onForeground();
    this.remoteActivityViewModel.resume();
    // Idempotent: covers the pairing that happened after the last cold start.
    void this.startWatchProvisioning();
    void this.settingsController.refreshAccountDevicesIfStale(DEVICE_PRESENCE_MAX_AGE_MS);
    this.settingsController.startPresencePolling(DEVICE_PRESENCE_MAX_AGE_MS);
  }

  onPageHide(): void {
    RemoteLogger.info(`page hide state=${(this.remotePageState.connectionState as ConnectionState)} route=${this.appShellViewModel.currentRoute()}`);
    this.settingsController.stopPresencePolling();
    const activeRemoteTurn = this.remotePageState.activeTurnMessage;
    if (this.isRemoteConversationContext(this.remotePageState.activeSession.sessionId)) {
      this.trackRemoteTaskCompletion(this.remotePageState.activeSession.sessionId, activeRemoteTurn);
    }
    const keepRemotePolling = this.taskCompletionNotificationController.isTracking('remote');
    const watchingCompletion = this.taskCompletionNotificationController.onBackground();
    if (keepRemotePolling && watchingCompletion) {
      this.remoteActivityViewModel.suspendKeepingActiveTurnPoll();
    } else {
      this.remoteActivityViewModel.invalidate();
    }
    this.remoteConnectionCoordinator.invalidate();
    this.remotePageState.setBusy(false);
  }

  aboutToDisappear(): void {
    this.miniAppViewModel.close();
    this.settingsController.stopPresencePolling();
    this.watchProvisionController.stop();
    this.taskCompletionNotificationController.stop();
    this.remoteActivityViewModel.invalidate();
    this.remoteConnectionCoordinator.invalidate();
    this.remotePageState.setBusy(false);
    this.remoteFileDownloadController.cancel();
    this.filePreviewController.close();
    this.voiceInputLifecycleController.cancel(`${this.appShellViewModel.currentRoute()}`, () => {
      this.conversationController.clearAllVoiceListening();
    });
  }

  isRemoteConversationContext(sessionId: string): boolean {
    if (sessionId.length === 0 || this.remotePageState.activeSession.sessionId !== sessionId) {
      return false;
    }
    return this.appShellViewModel.isRoute(AppRoute.RemoteChat) || this.appShellViewModel.isRoute(AppRoute.RemoteHome);
  }

  handleNavigationBack(route: AppRoute): boolean {
    if (this.appShellState.showConnectSheet) {
      this.appShellState.setConnectSheetVisible(false);
      return true;
    }
    if (this.filePreviewState.visible) {
      this.filePreviewController.close();
      return true;
    }
    const action = this.appShellViewModel.backAction(route);
    if (action === AppNavigationBackAction.CloseSidebar) {
      this.closeAppSidebar();
      return true;
    }
    if (action === AppNavigationBackAction.CloseActiveChat) {
      this.exitActiveChat();
      return true;
    }
    if (action === AppNavigationBackAction.PopRemoteHome) {
      this.appShellViewModel.popRoute(AppRoute.RemoteHome);
      return true;
    }
    return false;
  }

  handleRootBack(): boolean {
    if (this.appShellState.showConnectSheet) {
      this.appShellState.setConnectSheetVisible(false);
      return true;
    }
    if (!this.filePreviewState.visible) {
      return false;
    }
    this.filePreviewController.close();
    return true;
  }


  async restoreIdentity(): Promise<void> {
    // Read the install id and old target hint without reconnecting an old room.
    // The authenticated directory is the sole authority for restoring control.
    await this.remoteConnectionController.restoreWithoutReconnect(this.host.context());
    if (!this.settingsController.hasCloudAccountSession()) {
      this.remotePageState.clearControlTarget();
      this.remotePageState.setConnectionState(ConnectionState.Disconnected);
      if (this.remotePageState.remoteUrl.length > 0) {
        this.remotePageState.setStatusText(RemoteI18n.t('connect.legacySignInRequired'));
      }
      return;
    }
    if (this.settingsController.preferredCloudTarget()) {
      await this.restoreAccountDeviceTarget(false);
    }
  }

  /** Restores only a device proven by the current authenticated directory. */
  private async restoreAccountDeviceTarget(navigateHome: boolean): Promise<void> {
    const preferredTarget = this.settingsController.preferredCloudTarget();
    const deviceId = preferredTarget?.deviceId || this.remotePageState.controlTargetDeviceId.trim();
    if (deviceId.length === 0) {
      return;
    }
    this.remotePageState.setConnectionState(ConnectionState.Reconnecting);
    this.remotePageState.setStatusText(RemoteI18n.t('status.restoringConnection'));
    await this.settingsController.restoreCloudTarget(
      deviceId,
      preferredTarget?.deviceName || this.remotePageState.controlTargetDeviceName,
      navigateHome
    );
  }

  async connect(autoReconnect: boolean = false, accountPassword: string = ''): Promise<void> {
    this.handleDetectedRemoteUrl(this.remotePageState.remoteUrl);
  }

  async reconnect(): Promise<void> {
    if (this.settingsController.preferredCloudTarget()) {
      await this.restoreAccountDeviceTarget(true);
      return;
    }
    this.appShellState.openSettings('account');
  }

  async disconnect(clearPairing: boolean): Promise<void> {
    this.filePreviewController.invalidate();
    await this.remoteConnectionController.disconnect(clearPairing);
  }

  syncRemotePageSummary(): void {
    if (this.remotePageState.statusText.length === 0) {
      this.remotePageState.setStatusText(RemoteI18n.t('status.waitingConnection'));
    }
    if (this.remotePageState.workspaceName.length === 0) {
      this.remotePageState.setWorkspace(RemoteI18n.t('status.notConnected'), '', '', '', 'normal');
    }
  }

  /**
   * A request that failed against a link the phone still has a binding for is a
   * link that dropped, not one that ended, so the heartbeat stays up and its
   * next ping is what notices the desktop coming back. Killing it here is what
   * used to make a momentary drop permanent: `failed` disables every remote
   * action, and nothing was left running to lift it again.
   */
  failRemoteConnection(err: Object): void {
    this.remotePageState.setStatusText(ConnectionErrorPolicy.errorText(err));
    if (this.hasRemoteBindingForResume()) {
      this.remotePageState.setConnectionState(ConnectionState.Reconnecting);
      this.remoteActivityViewModel.startHeartbeat();
      return;
    }
    this.remotePageState.setConnectionState(ConnectionState.Failed);
    this.remoteActivityViewModel.stopHeartbeat();
  }

  async selectWorkspace(path: string): Promise<void> {
    this.filePreviewController.close();
    await this.remoteWorkspaceViewModel.selectWorkspace(path);
  }

  async selectWorkspaceOnDevice(path: string, deviceId?: string): Promise<void> {
    await this.conversationController.ensureRemoteControlTarget(deviceId);
    await this.selectWorkspace(path);
  }

  async selectDirectoryDevice(deviceId: string): Promise<void> {
    const selectionVersion = ++this.directorySelectionVersion;
    // Selecting an already disclosed device is a local collapse. The remote
    // control target remains connected; only its workspace tree is hidden.
    // Bumping the version first also prevents an earlier async selection from
    // reopening the row after this second tap.
    if (this.deviceDirectoryState.collapseIfSelected(deviceId)) {
      return;
    }
    await this.deviceDirectoryViewModel.selectDevice(deviceId);
    if (selectionVersion !== this.directorySelectionVersion) {
      return;
    }
    const entry = this.deviceDirectoryState.find(deviceId);
    if (entry && !entry.online && !this.isConnectedDirectoryTarget(deviceId)) {
      return;
    }
    try {
      await this.conversationController.ensureRemoteControlTarget(deviceId);
      if (selectionVersion !== this.directorySelectionVersion) {
        return;
      }
      this.filePreviewController.close();
      if (this.appShellState.wideLayout) {
        await this.enterRemoteSurfaceWide();
      } else {
        // A device row is also the disclosure control for its workspaces. Keep
        // the compact drawer visible so selecting it can reveal that content;
        // entering Remote from any other compact entry point still dismisses
        // the drawer through the method's default behavior.
        await this.enterRemoteSurfaceCompact(false);
      }
      this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteHome);
    } catch (err) {
      RemoteLogger.warn(`device directory switch failed device=${deviceId}: ${String(err)}`);
    }
  }

  async openWorkspacePickerOnDevice(deviceId: string): Promise<void> {
    await this.deviceDirectoryViewModel.selectDevice(deviceId);
    const entry = this.deviceDirectoryState.find(deviceId);
    if (entry && !entry.online && !this.isConnectedDirectoryTarget(deviceId)) {
      return;
    }
    if (this.isConnectedDirectoryTarget(deviceId)) {
      await this.remoteWorkspaceViewModel.loadRecentWorkspacesInBackground();
    }
  }

  async retryDirectoryDevice(deviceId: string): Promise<void> {
    if (this.isConnectedDirectoryTarget(deviceId)) {
      await this.remoteWorkspaceViewModel.loadRecentWorkspacesInBackground();
      return;
    }
    await this.deviceDirectoryViewModel.retryDevice(deviceId);
  }

  async loadWorkspaceSessionsOnDevice(deviceId: string, path: string): Promise<void> {
    const targetDeviceId = deviceId.trim();
    const targetPath = path.trim();
    if (targetDeviceId.length === 0 || targetPath.length === 0) {
      return;
    }
    if (this.isConnectedDirectoryTarget(targetDeviceId)) {
      const sessions = await this.sessionManager.listSessionsForWorkspace(targetPath, 50);
      this.deviceDirectoryViewModel.captureWorkspaceSessions(targetDeviceId, targetPath, sessions);
      this.remoteWorkspaceSessions = this.replaceWorkspaceSessions(targetPath, sessions);
      this.publishRemoteWorkspaceSessions();
      return;
    }
    await this.deviceDirectoryViewModel.loadWorkspaceSessions(targetDeviceId, targetPath);
  }

  private isConnectedDirectoryTarget(deviceId: string): boolean {
    return deviceId === this.remotePageState.controlTargetDeviceId &&
      RemoteUiState.canUseRemote((this.remotePageState.connectionState as ConnectionState));
  }

  async selectAssistant(path: string): Promise<void> {
    this.filePreviewController.close();
    await this.remoteWorkspaceViewModel.selectAssistant(path);
  }

  openAppSidebar(): void {
    this.host.animate(230, () => {
      this.appShellState.setSidebarVisible(true);
    });
    // The device rows are only on screen from here, and a desktop that came
    // online since the last look would otherwise stay grey.
    void this.settingsController.refreshAccountDevicesIfStale(DEVICE_PRESENCE_MAX_AGE_MS);
  }

  closeAppSidebar(): void {
    this.host.animate(210, () => {
      this.appShellState.setSidebarVisible(false);
    });
  }

  async enterRemoteSurfaceWide(): Promise<void> {
    if (AppRouteContract.isRemoteRoute(this.appShellViewModel.currentRoute())) {
      return;
    }
    if (this.conversationController.visibleVoiceListening()) {
      await this.stopVoiceInput(false);
    }
    const activeRemoteSessionId = this.remotePageState.isConversationDismissed ? '' :
      (this.remotePageState.activeSession.sessionId || '');
    const target = AppRouteContract.remoteSurfaceDestination(
      RemoteUiState.canUseRemote((this.remotePageState.connectionState as ConnectionState)),
      activeRemoteSessionId
    );
    this.appShellViewModel.replaceRouteWithoutAnimation(
      target.name,
      target.hasSessionParam() ? target.routeParam().sessionId : ''
    );
    if (target.name === AppRoute.RemoteChat) {
      this.conversationController.startRemotePolling();
      await this.conversationController.loadRemoteMessages();
    }
  }

  /**
   * Compact counterpart of enterRemoteSurfaceWide. Reaching the remote surface
   * is a change of context, not a command to start something: it resumes the
   * session the user was last in, and otherwise rests on the Remote landing
   * surface rather than opening the create composer for them.
   */
  async enterRemoteSurfaceCompact(closeSidebar: boolean = true): Promise<void> {
    if (closeSidebar) {
      this.closeAppSidebar();
    }
    if (AppRouteContract.isRemoteRoute(this.appShellViewModel.currentRoute())) {
      return;
    }
    if (this.conversationController.visibleVoiceListening()) {
      await this.stopVoiceInput(false);
    }
    const activeRemoteSessionId = RemoteUiState.canUseRemote((this.remotePageState.connectionState as ConnectionState)) &&
      !this.remotePageState.isConversationDismissed ?
      (this.remotePageState.activeSession.sessionId || '') : '';
    if (activeRemoteSessionId.length === 0) {
      this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteHome);
      return;
    }
    this.appShellViewModel.replaceRouteWithoutAnimation(AppRoute.RemoteChat, activeRemoteSessionId);
    this.conversationController.startRemotePolling();
    await this.conversationController.loadRemoteMessages();
  }

  enterCompactLayout(): void {
    const sessionId = this.remotePageState.activeSession.sessionId || '';
    if (this.appShellViewModel.isRoute(AppRoute.RemoteHome) &&
      !this.remotePageState.isConversationDismissed && sessionId.length > 0) {
      this.appShellViewModel.pushRoute(AppRoute.RemoteChat, sessionId, false);
    }
  }

  /**
   * Exit control for an open conversation. Leaving a remote conversation on a
   * compact layout lands on Remote Home with no visible session list, so reveal
   * the drawer that owns navigation there. Compact chats have no back button of
   * their own, so this runs for the system back gesture.
   */
  exitActiveChat(): void {
    const revealSidebar = !this.appShellState.wideLayout &&
      this.appShellViewModel.isRoute(AppRoute.RemoteChat);
    this.conversationController.closeActiveChat();
    if (revealSidebar) {
      this.openAppSidebar();
    }
  }

  openRemoteControlSettings(): void {
    setTimeout(() => {
      this.appShellState.openSettings('remote');
    }, 180);
  }

  /**
   * From the settings row that says 「扫描二维码连接」, and so straight to the
   * camera: this is the one entry that names what it opens, and it is also the
   * only way a signed-in phone can reach the scanner at all — every other path
   * stops at the account's device list.
   */
  openAddConnectionFromSettings(): void {
    this.appShellState.setSettingsVisible(false);
    setTimeout(() => {
      this.openConnectSheet(CONNECT_INTENT_SCAN);
    }, 220);
  }

  /**
   * Reconciles the workspace row that owns a newly created remote session.
   *
   * Creating from the sidebar deliberately does not switch the desktop's
   * active workspace. A normal session refresh therefore still lists the old
   * active workspace and cannot discover the new row. Publish the confirmed
   * create immediately, then refresh the workspace named by the response.
   */
  async reconcileCreatedRemoteSession(session: SessionSummary): Promise<void> {
    const workspacePath = session.workspacePath.trim();
    if (workspacePath.length === 0 || workspacePath === this.remotePageState.workspacePath) {
      await this.remoteSessionViewModel.refreshSessions();
      return;
    }

    const now = new Date().toISOString();
    const created: RemoteSession = {
      id: session.sessionId,
      title: session.title,
      agentType: session.agentType,
      status: 'active',
      updatedAt: now,
      createdAt: now,
      messageCount: session.initialTurnId ? 1 : 0,
      workspacePath
    };
    this.remoteWorkspaceSessions = this.replaceWorkspaceSessions(
      workspacePath,
      this.mergeSessions([created], this.sessionsForWorkspace(workspacePath))
    );
    this.publishRemoteWorkspaceSessions();

    try {
      const refreshed = await this.sessionManager.listSessionsForWorkspace(workspacePath, 50);
      const containsCreated = refreshed.some((item: RemoteSession): boolean => item.id === session.sessionId);
      this.remoteWorkspaceSessions = this.replaceWorkspaceSessions(
        workspacePath,
        containsCreated ? refreshed : this.mergeSessions([created], refreshed)
      );
      this.publishRemoteWorkspaceSessions();
    } catch (err) {
      // The create already succeeded and is on screen. Keep that confirmed row
      // instead of turning a follow-up list failure into a false create error.
      RemoteLogger.warn(`created session workspace refresh failed path=${workspacePath}: ${String(err)}`);
    }
  }

  private sessionsForWorkspace(path: string): RemoteSession[] {
    return this.remotePageState.sessions.filter((item: RemoteSession): boolean => item.workspacePath === path);
  }

  private replaceWorkspaceSessions(path: string, replacement: RemoteSession[]): RemoteSession[] {
    const preserved = this.remotePageState.sessions.filter((item: RemoteSession): boolean => {
      return item.workspacePath !== path;
    });
    return replacement.concat(preserved);
  }

  private publishRemoteWorkspaceSessions(): void {
    const currentPath = this.remotePageState.workspacePath;
    const current = this.remotePageState.sessions.filter((item: RemoteSession): boolean => {
      return (item.workspacePath || currentPath) === currentPath;
    });
    const extras = this.remoteWorkspaceSessions.filter((item: RemoteSession): boolean => {
      return item.workspacePath !== currentPath;
    });
    this.publishRemoteSessions(this.mergeSessions(current, extras), this.remotePageState.hasMoreSessions);
  }

  /**
   * The single way a session list reaches the screen, so everything the user
   * sees is also what the next launch starts from.
   *
   * The write is deliberately not awaited: the list is on screen either way,
   * and making a repaint wait on disk is the one way this cache could make the
   * app feel slower than it did without it.
   */
  publishRemoteSessions(sessions: RemoteSession[], hasMore: boolean): void {
    const deviceId = this.remotePageState.controlTargetDeviceId || this.remotePageState.desktopId;
    const scoped = stampRemoteSessionsWorkspace(sessions, this.remotePageState.workspacePath);
    const stamped = stampRemoteSessionsDevice(scoped, deviceId);
    this.remotePageState.setSessions(stamped, hasMore);
    this.remoteSessionListCache.save(stamped, hasMore);
    const currentPath = this.remotePageState.workspacePath;
    if (currentPath.length > 0) {
      const currentSessions = stamped.filter((item: RemoteSession): boolean => {
        return (item.workspacePath || '') === currentPath;
      });
      this.deviceDirectoryViewModel.captureWorkspaceSessions(deviceId, currentPath, currentSessions);
    }
    this.deviceDirectoryViewModel.captureLive(
      deviceId,
      this.remotePageState.recentWorkspaces,
      stamped
    );
  }

  /**
   * Fills Remote Home from disk before anything is connected.
   *
   * Runs against whichever desktop was used last, because the device to key on
   * is not known this early — identity is still being restored, and the
   * auto-reconnect that follows targets exactly that desktop. Anything the
   * desktop reports replaces this, so a stale entry costs a repaint.
   */
  private async restoreCachedRemoteSessions(): Promise<void> {
    if (this.remotePageState.sessions.length > 0) {
      return;
    }
    const cached = await this.remoteSessionListCache.restoreLast();
    // Checked again: a connection may have landed while the read was in flight,
    // and the desktop's answer outranks the stored one.
    if (cached.sessions.length === 0 || this.remotePageState.sessions.length > 0) {
      return;
    }
    RemoteLogger.info(`session list from cache count=${cached.sessions.length}`);
    this.remotePageState.setSessions(cached.sessions, cached.hasMore);
  }

  mergeSessions(primary: RemoteSession[], extras: RemoteSession[]): RemoteSession[] {
    return RemoteUiState.mergeSessions(primary, extras);
  }

  async toggleVoiceInput(): Promise<void> {
    const route = this.appShellViewModel.currentRoute();
    await this.voiceInputLifecycleController.toggle(
      this.host.context(), this.conversationController.voiceInputSnapshot(route)
    );
  }

  async stopVoiceInput(showStatus: boolean): Promise<void> {
    const route = this.appShellViewModel.currentRoute();
    await this.voiceInputLifecycleController.stop(
      this.conversationController.voiceInputSnapshot(route), showStatus
    );
  }

  showVoiceInputError(message: string): void {
    const text = message.length > 0 ? message : RemoteI18n.t('errors.voiceInputUnavailable');
    this.conversationController.setVisibleStatusText(text);
    this.host.showToast(text, 2600);
  }

  async pickImages(): Promise<void> {
    if (this.conversationController.visibleBusy()) {
      return;
    }
    const route = this.appShellViewModel.currentRoute();
    if (this.conversationController.visibleVoiceListening()) {
      await this.stopVoiceInput(false);
    }
    try {
      this.conversationController.setVisibleStatusText(RemoteI18n.t('status.pickImage'));
      const picked = await this.imagePickerService.pickImages(
        3,
        this.conversationController.visibleSelectedImages().length
      );
      if (picked.length === 0) {
        this.conversationController.setVisibleStatusText(RemoteI18n.t('status.noImageSelected'));
        return;
      }
      this.conversationController.addSelectedImages(route, picked);
      this.conversationController.setVisibleStatusText(RemoteI18n.f(
        'status.imagesSelected',
        `${this.conversationController.visibleSelectedImages().length}`
      ));
    } catch (err) {
      this.conversationController.setVisibleStatusText(ConnectionErrorPolicy.errorText(err));
    }
  }

  currentActiveTurnId(): string {
    return this.conversationController.remoteActiveTurnId();
  }

  hasRemoteBindingForResume(): boolean {
    if (this.remotePageState.controlTargetType === 'account_device') {
      return this.remotePageState.accountUserId.trim().length > 0 &&
        this.remotePageState.controlTargetDeviceId.trim().length > 0 &&
        (this.remotePageState.connectionState as ConnectionState) !== ConnectionState.Idle &&
        (this.remotePageState.connectionState as ConnectionState) !== ConnectionState.Disconnected;
    }
    return false;
  }

  async reconnectActiveRemote(): Promise<void> {
    const preferredTarget = this.settingsController.preferredCloudTarget();
    if (!preferredTarget) {
      throw new Error(RemoteI18n.t('connect.legacySignInRequired'));
    }
    const targetId = preferredTarget.deviceId;
    const device = (await this.settingsController.listCloudAccountDevices())
      .find((item: CloudAccountDevice): boolean => item.deviceId === targetId);
    if (!device) {
      throw new Error(RemoteI18n.t('remote.settings.deviceOffline'));
    }
    await this.settingsController.selectCloudAccountDevice(device);
  }

  hasRemoteBindingForCodeHome(): boolean {
    return this.hasRemoteBindingForResume();
  }

}
