import { GitHubAccountProfile, GitHubProfileLoader } from '../../services/GitHubAccountProfile';
import { normalizeAccountRelayUrl, OFFICIAL_RELAY_URL } from '../../services/AccountDeviceLink';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { stampRemoteSessionsDevice } from '../../services/RemoteSessionIdentity';
import {
  DEFAULT_CLOUD_RELAY_URL,
  CloudAccountBinding,
  CloudAccountClient,
  CloudAccountDevice,
  CloudAccountRequestError,
  CloudAccountSession
} from '../../services/CloudAccountClient';
import { CloudAccountSessionStore, PersistedCloudAccountSession } from '../../services/CloudAccountSessionStore';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { Encoding } from '../../services/Encoding';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { WatchProvisionOutcome } from '../../services/WatchProvisionController';
import { RemotePermissionMode } from '../../model/RemoteModels';
import { RemotePageState } from '../state/RemotePageState';

export interface CloudAccountSettingsHooks {
  readonly deviceId: () => string;
  readonly openAuthorization: (url: string) => Promise<boolean>;
  readonly remoteAvailable: () => boolean;
  readonly invalidatePreview: () => void;
  readonly invalidateRemoteActivity: () => void;
  readonly invalidateRemoteConnection: () => void;
  readonly stopPolling: () => void;
  readonly stopHeartbeat: () => void;
  readonly startHeartbeat: () => void;
  readonly resetTimeline: () => void;
  readonly resetKnownRemoteState: () => void;
  /** Cached transcripts and session lists belong to the account that was signed in. */
  readonly clearCachedRemoteData: () => Promise<void>;
  readonly closeSettings: () => void;
  readonly closeConnectSheet: () => void;
  readonly navigateRemoteHome: () => void;
  readonly loadRecentWorkspaces: () => Promise<void>;
  readonly saveControlTargetType: (controlTargetType: string) => Promise<void>;
  readonly onAccountDevices: (devices: CloudAccountDevice[]) => void;
  /** Snapshot the outgoing live device before teardown clears its lists. */
  readonly onBeforeControlTargetChange: () => void;
  /** The incoming device owns a catalog request from the start of its switch. */
  readonly onControlTargetLoading: (deviceId: string) => void;
  readonly onControlTargetChanged: () => void;
}

export interface CloudAccountSettingsDependencies {
  readonly client: CloudAccountClient;
  readonly sessionStore: CloudAccountSessionStore;
  readonly profileLoader?: GitHubProfileLoader;
  readonly sessionManager: RemoteSessionManager;
  readonly remoteState: RemotePageState;
  readonly hooks: CloudAccountSettingsHooks;
}

export interface PreferredCloudTarget {
  readonly deviceId: string;
  readonly deviceName: string;
}

/** Owns the authenticated account and remote device selection. */
export class SettingsController {
  private readonly cloud?: CloudAccountSettingsDependencies;
  private cloudSession?: CloudAccountSession;
  private cloudRelayUrl: string = '';
  private selectedRelayUrl: string = DEFAULT_CLOUD_RELAY_URL;
  private accountLoginVersion: number = 0;
  /** Account login identity; pairing projections must never overwrite it. */
  private cloudAccountUsername: string = '';
  private accountDevices: CloudAccountDevice[] = [];
  private lastAccountDevicesAt: number = 0;
  private stopPresence?: () => void;
  private presenceGeneration: number = 0;
  private presenceRefreshing: boolean = false;
  private targetProbeTimer: number = -1;
  private targetProbing: boolean = false;
  private targetProbeDelay: number = 250;
  private restoringControlTarget: boolean = false;
  private accountDeviceSelectionVersion: number = 0;
  /** Last account device the user successfully controlled, independent of the live QR projection. */
  private preferredTargetDeviceId: string = '';
  private preferredTargetDeviceName: string = '';

  constructor(cloud: CloudAccountSettingsDependencies) {
    this.cloud = cloud;
  }

  async initializeCloudAccount(context: Context): Promise<void> {
    const cloud = this.requireCloud();
    await cloud.sessionStore.init(context);
    await this.restoreCloudAccountSession();
    void this.refreshCloudAccountProfile();
  }

  hasCloudAccountSession(): boolean {
    return this.cloudSession !== undefined;
  }

  /**
   * Whether this phone might be able to add a device to the account itself.
   *
   * The relay checks the credential's provisioning scope. A local session
   * makes the action available; a server refusal is reported to the caller.
   */
  canMintWatchCredential(): boolean {
    return this.cloudSession !== undefined && this.cloudRelayUrl.length > 0;
  }

  /**
   * Mints a watch's own account credential straight from this phone.
   *
   * Returns `undefined` without a signed-in session and propagates server
   * refusals. The watch receives its own newly generated device secret,
   * sealed by the provisioning transport; the phone's secret stays local.
   */
  async provisionWatchCredential(
    deviceId: string,
    deviceName: string,
    requestId: string,
    password: string = ''
  ): Promise<WatchProvisionOutcome | undefined> {
    const session = this.cloudSession;
    if (!session || this.cloudRelayUrl.length === 0) {
      return undefined;
    }
    const cloud = this.requireCloud();
    try {
      const provisioned = await cloud.client.provisionDevice(
        this.cloudRelayUrl, session, deviceId, deviceName, requestId);
      RemoteLogger.info(`watch credential minted from the phone account device=${provisioned.deviceId}`);
      return {
        ok: true,
        passwordRequired: false,
        relayUrl: this.cloudRelayUrl,
        token: provisioned.token,
        userId: provisioned.userId,
        masterKeyBase64: Encoding.bytesToBase64(provisioned.deviceSecret),
        deviceId: provisioned.deviceId,
        failure: '',
        desktopReported: false
      };
    } catch (err) {
      throw err instanceof Error ? err : new Error('Watch credential provisioning failed.');
    }
  }

  selectAccountRelay(relayUrl: string): void {
    const endpoint = normalizeAccountRelayUrl(relayUrl);
    if (!endpoint) throw new Error('Invalid Relay URL');
    if (this.cloudRelayUrl !== endpoint) {
      this.teardownCloudAccountProjection(this.requireCloud());
      this.selectedRelayUrl = endpoint;
    }
  }

  async loginCloudAccount(): Promise<string> {
    const relayUrl = this.selectedRelayUrl;
    const generation = ++this.accountLoginVersion;
    const cloud = this.requireCloud();
    RemoteLogger.info('cloud account UI login requested');
    const deviceSecret = await cloud.sessionStore.deviceSecret();
    if (generation !== this.accountLoginVersion) { deviceSecret.fill(0); throw new Error('Account login cancelled'); }
    let session: CloudAccountSession;
    try {
      session = await cloud.client.login(relayUrl, cloud.hooks.deviceId(), cloud.hooks.openAuthorization, deviceSecret);
    } finally { deviceSecret.fill(0); }
    if (generation !== this.accountLoginVersion) {
      session.masterKey.fill(0);
      throw new Error('Account login cancelled');
    }
    const username = session.userId;
    this.clearPreferredCloudTarget();
    this.applyCloudAccountSession(session, relayUrl, username);
    try {
      await cloud.sessionStore.save({
        relayUrl: relayUrl.trim(), username: username.trim(), token: session.token, userId: session.userId,
        masterKey: Encoding.bytesToBase64(session.masterKey)
      });
    } catch (err) {
      RemoteLogger.warn(`cloud account session persistence failed: ${String(err)}`);
    }
    void this.refreshCloudAccountProfile();
    RemoteLogger.info('cloud account session active, refreshing account devices');
    RemoteLogger.info(`cloud account login success user=${session.userId}`);
    return session.userId;
  }

  applyCloudAccountSession(session: CloudAccountSession, relayUrl: string, username: string): void {
    const remoteState = this.requireCloud().remoteState;
    this.cloudSession = session;
    this.cloudRelayUrl = relayUrl.trim();
    this.selectedRelayUrl = this.cloudRelayUrl;
    this.cloudAccountUsername = username.trim();
    remoteState.setAccountAvatarUrl('');
    remoteState.setAccountUserId(session.userId);
    remoteState.setAccountUsername(this.cloudAccountUsername);
    this.startPresencePolling(0);
  }

  cancelCloudLogin(): void { this.cloud?.client.cancelAuthorization(); }

  async logoutCloudAccount(): Promise<void> {
    this.cancelCloudLogin();
    const cloud = this.requireCloud();
    cloud.hooks.invalidatePreview();
    this.teardownCloudAccountProjection(cloud);
    await cloud.sessionStore.clear();
    await cloud.hooks.clearCachedRemoteData();
    cloud.remoteState.clearControlTarget();
    cloud.remoteState.setHostCapabilities([]);
    await this.saveControlTargetType('');
    RemoteLogger.info('cloud account logout success');
  }

  activeCloudAccount(): CloudAccountBinding | undefined {
    const cloud = this.cloud;
    const session = this.cloudSession;
    if (!cloud || !session || this.cloudRelayUrl.length === 0) {
      return undefined;
    }
    const binding: CloudAccountBinding = {
      client: cloud.client,
      relayUrl: this.cloudRelayUrl,
      session
    };
    return binding;
  }

  cloudRelayEndpoint(): string {
    return this.cloudRelayUrl;
  }

  preferredCloudTarget(): PreferredCloudTarget | undefined {
    const deviceId = this.preferredTargetDeviceId.trim();
    if (deviceId.length === 0) {
      return undefined;
    }
    return {
      deviceId,
      deviceName: this.preferredTargetDeviceName.trim() || deviceId
    };
  }

  /** Account Socket.IO owns liveness. Presence snapshots update known rows
   * directly; reconnect and unknown devices hydrate metadata once, never idle. */
  startPresencePolling(_maxAgeMs: number): void {
    this.stopPresencePolling();
    const binding = this.activeCloudAccount();
    if (!binding) return;
    const epoch = this.presenceGeneration;
    try {
      this.stopPresence = binding.client.observePresence(binding.relayUrl, binding.session,
      (ids: string[]) => {
        if (epoch !== this.presenceGeneration) return;
        const previousTarget = this.accountDevices.find((device: CloudAccountDevice) => device.deviceId === this.requireCloud().remoteState.controlTargetDeviceId);
        this.accountDevices = this.accountDevices.map((device: CloudAccountDevice): CloudAccountDevice => ({
          deviceId: device.deviceId, deviceName: device.deviceName, deviceKind: device.deviceKind,
          lastSeenAt: device.lastSeenAt, online: ids.includes(device.deviceId)
        }));
        const cloud = this.requireCloud();
        cloud.hooks.onAccountDevices(this.accountDevices);
        const target = cloud.remoteState.controlTargetDeviceId;
        if (target && !ids.includes(target)) {
          cloud.remoteState.setConnectionState('reconnecting');
          cloud.remoteState.setStatusText(RemoteI18n.t('remote.settings.deviceUnavailable'));
          if (this.targetProbeTimer !== -1) clearTimeout(this.targetProbeTimer);
          this.targetProbeTimer = -1;
        } else if (target && previousTarget?.online !== true) {
          this.targetProbeDelay = 250; this.scheduleTargetProbe(epoch);
        }
        if (ids.some((id: string) => !this.accountDevices.some((device: CloudAccountDevice) => device.deviceId === id))) void this.hydratePresence(epoch);
      },
      () => { void this.hydratePresence(epoch); });
    } catch (error) {
      // Transport startup failure must not invalidate a restored account identity.
      const cloud = this.requireCloud();
      cloud.remoteState.setStatusText(ConnectionErrorPolicy.errorText(error));
      if (cloud.remoteState.controlTargetDeviceId) cloud.remoteState.setConnectionState('reconnecting');
      RemoteLogger.warn(`account presence observer failed: ${ConnectionErrorPolicy.errorText(error)}`);
    }
  }

  stopPresencePolling(): void {
    this.presenceGeneration++;
    this.stopPresence?.(); this.stopPresence = undefined;
    if (this.targetProbeTimer !== -1) clearTimeout(this.targetProbeTimer);
    this.targetProbeTimer = -1;
  }

  private async hydratePresence(epoch: number): Promise<void> {
    if (this.presenceRefreshing || epoch !== this.presenceGeneration) return;
    this.presenceRefreshing = true;
    try {
      await this.refreshAccountDevicesIfStale(0);
      if (epoch === this.presenceGeneration) { this.targetProbeDelay = 250; this.scheduleTargetProbe(epoch); }
    }
    finally { this.presenceRefreshing = false; }
  }

  private scheduleTargetProbe(epoch: number): void {
    if (epoch !== this.presenceGeneration || this.targetProbeTimer !== -1 || this.targetProbing) return;
    const cloud = this.requireCloud();
    const target = cloud.remoteState.controlTargetDeviceId;
    if (!target || !this.accountDevices.some((device: CloudAccountDevice) => device.deviceId === target && device.online)) return;
    this.targetProbeTimer = setTimeout(() => {
      this.targetProbeTimer = -1;
      void this.probeTarget(epoch, target);
    }, this.targetProbeDelay);
  }

  private async probeTarget(epoch: number, target: string): Promise<void> {
    if (epoch !== this.presenceGeneration || target !== this.requireCloud().remoteState.controlTargetDeviceId) return;
    this.targetProbing = true;
    let retry = false;
    try {
      await this.requireCloud().sessionManager.ping();
      if (epoch !== this.presenceGeneration || target !== this.requireCloud().remoteState.controlTargetDeviceId) return;
      this.requireCloud().remoteState.setConnectionState('connected');
      this.targetProbeDelay = 250;
    } catch (error) {
      if (epoch === this.presenceGeneration && target === this.requireCloud().remoteState.controlTargetDeviceId) {
        this.requireCloud().remoteState.setConnectionState('reconnecting');
        this.requireCloud().remoteState.setStatusText(ConnectionErrorPolicy.errorText(error));
        this.targetProbeDelay = Math.min(30000, this.targetProbeDelay * 2);
        retry = true;
      }
    } finally {
      this.targetProbing = false;
      if (retry) this.scheduleTargetProbe(epoch);
    }
  }

  /**
   * Refetches account device presence when the last answer is older than
   * [maxAgeMs].
   *
   * The relay owns presence in a live socket registry, so its answer is only
   * as current as the last time we asked — and the only ask used to be at
   * cold start. A desktop that came online afterwards stayed grey in the
   * sidebar until the app was killed and relaunched.
   *
   * Failure is swallowed on purpose: this runs off returning to the
   * foreground, where the user asked for nothing and a thrown error would
   * surface as an alert about a request they never made.
   */
  async refreshAccountDevicesIfStale(maxAgeMs: number): Promise<void> {
    if (!this.hasCloudAccountSession()) {
      return;
    }
    if (Date.now() - this.lastAccountDevicesAt < maxAgeMs) {
      return;
    }
    try {
      await this.listCloudAccountDevices();
    } catch (err) {
      RemoteLogger.warn(`account device presence refresh failed: ${String(err)}`);
    }
  }

  /**
   * Re-publishes the cached device list so presence can be re-derived.
   *
   * Presence is not purely the relay's to decide: a device we hold a live link
   * to is online whatever the socket registry last projected. That override is
   * evaluated when the list is published, so a link going live has to republish
   * or the desktop we just connected to keeps whatever the last fetch claimed —
   * on a cold start that fetch happens before the reconnect lands, and the
   * answer it brought back is "offline".
   *
   * No request goes out: this is the same list, read again.
   */
  resyncAccountDevicePresence(): void {
    if (this.accountDevices.length === 0) {
      return;
    }
    this.requireCloud().hooks.onAccountDevices(this.accountDevices);
  }

  async listCloudAccountDevices(): Promise<CloudAccountDevice[]> {
    const cloud = this.requireCloud();
    const session = this.cloudSession;
    if (!session || this.cloudRelayUrl.length === 0) {
      return [];
    }
    try {
      const devices = await cloud.client.listDevices(this.cloudRelayUrl, session, cloud.hooks.deviceId());
      if (this.cloudSession !== session) throw new Error('Account changed while loading devices');
      this.accountDevices = devices;
      this.lastAccountDevicesAt = Date.now();
      cloud.hooks.onAccountDevices(devices);
      return devices;
    } catch (err) {
      if (this.cloudSession !== session) throw new Error('Account changed while loading devices');
      if (err instanceof CloudAccountRequestError && err.statusCode === 401) {
        await this.expireCloudAccountSession();
        throw new Error(RemoteI18n.t('remote.settings.accountExpired'));
      }
      if (err instanceof CloudAccountRequestError &&
        (err.statusCode === 404 || err.statusCode === 503 || err.statusCode === 504)) {
        throw new Error(RemoteI18n.t('remote.settings.deviceUnavailable'));
      }
      throw new Error(err instanceof Error ? err.message : RemoteI18n.t('remote.settings.deviceLoadFailed'));
    }
  }

  knownAccountDevice(deviceId: string): CloudAccountDevice | undefined {
    const target = deviceId.trim();
    if (target.length === 0) {
      return undefined;
    }
    return this.accountDevices.find((item: CloudAccountDevice): boolean => item.deviceId === target);
  }

  async getRemotePermissionMode(): Promise<RemotePermissionMode> {
    const cloud = this.requireCloud();
    if (!cloud.hooks.remoteAvailable()) {
      throw new Error(RemoteI18n.t('remote.permissions.connectionRequired'));
    }
    return cloud.sessionManager.getPermissionMode();
  }

  async setRemotePermissionMode(mode: RemotePermissionMode): Promise<RemotePermissionMode> {
    const cloud = this.requireCloud();
    if (!cloud.hooks.remoteAvailable()) {
      throw new Error(RemoteI18n.t('remote.permissions.connectionRequired'));
    }
    return cloud.sessionManager.setPermissionMode(mode);
  }

  /**
   * Puts the account back on the desktop it was last driving.
   *
   * `navigateHome` is off for the cold-start restore: the launch route is the
   * user's business, and reconnecting in the background should not move them
   * off the screen the app opened on. A manual reconnect is already on the
   * Remote surface, so there it lands where the user expects.
   */
  async restoreCloudTarget(
    targetDeviceId: string,
    targetDeviceName: string,
    navigateHome: boolean = true
  ): Promise<void> {
    const targetId = targetDeviceId.trim();
    if (targetId.length === 0) {
      return;
    }
    this.setPreferredCloudTarget(targetId, targetDeviceName.trim() || targetId);
    const remoteState = this.requireCloud().remoteState;
    try {
      const devices = await this.listCloudAccountDevices();
      const target = devices.find((device: CloudAccountDevice): boolean => device.deviceId === targetId);
      if (!target || !target.online) {
        const targetName = target?.deviceName || targetDeviceName || targetId;
        remoteState.setControlTarget('account_device', targetId, targetName);
        remoteState.setDesktopIdentity(targetName, targetId);
        remoteState.setConnectionState('reconnecting');
        remoteState.setStatusText(RemoteI18n.t('remote.settings.deviceUnavailable'));
        this.requireCloud().hooks.startHeartbeat();
        return;
      }
      await this.selectCloudAccountDevice({
        deviceId: target.deviceId,
        deviceName: target.deviceName || targetDeviceName || target.deviceId,
        online: target.online,
        lastSeenAt: target.lastSeenAt
      }, navigateHome);
    } catch (err) {
      RemoteLogger.warn(`cloud target restore failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      if (!this.cloudSession) {
        // The account itself went away — an expired token clears it — so there
        // is no desktop left to aim at, and the surfaces already say as much.
        return;
      }
      // A failed connect attempt drops the target so a half-open link cannot be
      // mistaken for a live one, but a restore that failed is exactly the case
      // where the target still matters: without it the reconnect button has
      // nothing to retry and falls through to the paired-desktop path.
      remoteState.setControlTarget('account_device', targetId, targetDeviceName.trim() || targetId);
      remoteState.setConnectionState('reconnecting');
      remoteState.setStatusText(ConnectionErrorPolicy.errorText(err));
      this.requireCloud().hooks.startHeartbeat();
    }
  }

  async handleRemoteConnectionError(err: Object): Promise<boolean> {
    const remoteState = this.requireCloud().remoteState;
    if (remoteState.controlTargetType !== 'account_device' ||
      !(err instanceof CloudAccountRequestError) || err.statusCode !== 401) {
      return false;
    }
    await this.expireCloudAccountSession();
    remoteState.setStatusText(RemoteI18n.t('remote.settings.accountExpired'));
    return true;
  }

  async selectCloudAccountDevice(device: CloudAccountDevice, navigateHome: boolean = true): Promise<void> {
    const cloud = this.requireCloud();
    const session = this.cloudSession;
    if (!device.online) {
      throw new Error(RemoteI18n.t('remote.settings.deviceOffline'));
    }
    if (!session || this.cloudRelayUrl.length === 0) {
      throw new Error(RemoteI18n.t('remote.settings.accountNotSignedIn'));
    }
    const deviceId = device.deviceId.trim();
    if (deviceId.length === 0 || deviceId === cloud.hooks.deviceId()) {
      return;
    }
    const selectionVersion = ++this.accountDeviceSelectionVersion;
    // A QR room and an account-device link can identify the same physical
    // desktop. Only short-circuit when the active transport is already the
    // account path the user selected; otherwise this tap is an intentional
    // room -> account migration and must replace the transport and persist the
    // account target for the next launch.
    if (cloud.remoteState.controlTargetType === 'account_device' &&
      deviceId === cloud.remoteState.controlTargetDeviceId &&
      cloud.remoteState.connectionState === 'connected') {
      cloud.hooks.closeConnectSheet();
      if (navigateHome) {
        cloud.hooks.navigateRemoteHome();
      }
      return;
    }
    // Taken before the teardown, which is the last moment the outgoing device
    // is still readable off the page state.
    const previousTarget = this.restorableControlTarget();
    this.prepareAccountDeviceConnection(deviceId);
    try {
      const initialSync = await cloud.sessionManager.connectAccountDevice(
        cloud.client,
        this.cloudRelayUrl,
        session,
        deviceId
      );
      if (selectionVersion !== this.accountDeviceSelectionVersion) {
        RemoteLogger.info(`stale device switch completion ignored device=${deviceId}`);
        return;
      }
      RemoteLogger.info(
        `account device sync device=${deviceId} workspace=${initialSync.workspace.path} sessions=${initialSync.sessions.length}`
      );
      cloud.remoteState.setControlTarget('account_device', deviceId, device.deviceName);
      cloud.remoteState.setDesktopIdentity(device.deviceName, deviceId);
      cloud.remoteState.setWorkspace(
        initialSync.workspace.name,
        initialSync.workspace.path,
        initialSync.workspace.assistantId || '',
        initialSync.workspace.gitBranch,
        initialSync.workspace.workspaceKind || 'normal',
        initialSync.workspace.remoteConnectionId || '',
        initialSync.workspace.remoteSshHost || '',
        initialSync.workspace.workspaceId || ''
      );
      cloud.remoteState.setSessions(
        stampRemoteSessionsDevice(initialSync.sessions, deviceId),
        initialSync.hasMoreSessions
      );
      cloud.hooks.onControlTargetChanged();
      cloud.remoteState.setAuthenticatedUserId(initialSync.authenticatedUserId);
      cloud.remoteState.setHostCapabilities(initialSync.capabilities || []);
      cloud.remoteState.setConnectionState('connected');
      this.setPreferredCloudTarget(deviceId, device.deviceName || deviceId);
      await this.saveControlTargetType('account_device');
      this.resyncAccountDevicePresence();
      cloud.remoteState.setStatusText(RemoteI18n.t('connection.connected'));
      // Dismissing the picker and going home are the same event: the switch the
      // user asked for from a sheet is done. A switch nobody asked for — the
      // one behind opening a session on another desktop, or the restore after a
      // failed one — must not take their place in the UI away from them.
      if (navigateHome) {
        cloud.hooks.closeSettings();
        cloud.hooks.closeConnectSheet();
        cloud.hooks.navigateRemoteHome();
      }
      try {
        await this.persistCurrentCloudSessionTarget(deviceId, device.deviceName || deviceId);
      } catch (err) {
        RemoteLogger.warn(`account target persistence failed device=${deviceId}: ${String(err)}`);
      }
      cloud.hooks.startHeartbeat();
      // Same reasoning as the paired-desktop path in RemoteConnectionController:
      // the cross-workspace scan runs behind a list that is already usable.
      void cloud.hooks.loadRecentWorkspaces();
    } catch (err) {
      if (selectionVersion !== this.accountDeviceSelectionVersion) {
        RemoteLogger.info(`stale device switch failure ignored device=${deviceId}`);
        return;
      }
      if (err instanceof CloudAccountRequestError && err.statusCode === 401) {
        await this.expireCloudAccountSession();
      }
      cloud.remoteState.clearControlTarget();
      cloud.remoteState.setConnectionState('failed');
      const message = ConnectionErrorPolicy.errorText(err);
      cloud.remoteState.setStatusText(message);
      cloud.sessionManager.reset();
      await this.restoreControlTarget(previousTarget);
      throw new Error(message);
    } finally {
      if (selectionVersion === this.accountDeviceSelectionVersion) {
        cloud.remoteState.setLoadingHome(false);
        cloud.remoteState.setBusy(false);
      }
    }
  }

  /**
   * The device to fall back to if the switch about to start fails, or nothing.
   *
   * Only an account device qualifies. A QR-paired room is re-established by
   * `RemoteConnectionController`, not from here, so offering to restore it
   * would be a promise this method cannot keep. `online: true` is not a guess:
   * it is what the live connection just proved, and it is what
   * `selectCloudAccountDevice` refuses to dial without.
   */
  private restorableControlTarget(): CloudAccountDevice | undefined {
    const state = this.requireCloud().remoteState;
    if (state.controlTargetType !== 'account_device' || state.connectionState !== 'connected') {
      return undefined;
    }
    const deviceId = state.controlTargetDeviceId.trim();
    if (deviceId.length === 0) {
      return undefined;
    }
    return {
      deviceId,
      deviceName: state.controlTargetDeviceName || deviceId,
      online: true
    };
  }

  /**
   * Puts the phone back on the desktop it was talking to before a failed switch.
   *
   * There is one transport, so `prepareAccountDeviceConnection` has to tear the
   * old link down before dialling the new one. When the dial fails, what is
   * left is no device at all, with polling and the heartbeat stopped — tapping
   * a session on a machine that has gone away costs the user the machine they
   * were actually using. The restore is best effort and deliberately silent:
   * the original failure is still what gets reported, because the thing the
   * user asked for did not happen either way. The re-entry guard is what stops
   * a restore that fails from trying to restore itself.
   */
  private async restoreControlTarget(previous?: CloudAccountDevice): Promise<void> {
    if (!previous || this.restoringControlTarget) {
      return;
    }
    this.restoringControlTarget = true;
    try {
      await this.selectCloudAccountDevice(previous, false);
      RemoteLogger.info(`control target restored device=${previous.deviceId}`);
    } catch (err) {
      RemoteLogger.warn(`control target restore failed device=${previous.deviceId}: ${String(err)}`);
    } finally {
      this.restoringControlTarget = false;
    }
  }

  async refreshCloudAccountProfile(): Promise<void> {
    const cloud = this.requireCloud();
    const session = this.cloudSession;
    const loader = cloud.profileLoader;
    if (!session || !loader) return;
    const version = this.accountLoginVersion;
    const isCurrent = (): boolean => this.cloudSession === session && this.accountLoginVersion === version;
    const apply = (profile: GitHubAccountProfile): void => {
      if (!isCurrent() || profile.userId !== session.userId) return;
      this.cloudAccountUsername = profile.login;
      cloud.remoteState.setAccountUsername(profile.login);
      cloud.remoteState.setAccountAvatarUrl(profile.avatarUrl);
    };
    try {
      const cached = await cloud.sessionStore.loadProfile(session.userId);
      if (!isCurrent()) return;
      if (cached) {
        apply(cached);
        const age = Date.now() - cached.fetchedAt;
        if (age >= 0 && age < 24 * 60 * 60 * 1000) return;
      }
    } catch (_err) { RemoteLogger.warn('GitHub profile cache unavailable'); }
    if (!isCurrent()) return;
    try {
      const profile = await loader.load(session.userId);
      if (!isCurrent() || profile.userId !== session.userId) return;
      apply(profile);
      await cloud.sessionStore.saveProfile(profile);
    } catch (_err) {
      // Optional public metadata must never expire or block the authenticated session.
      RemoteLogger.warn('GitHub profile refresh unavailable; keeping account session');
    }
  }

  private async restoreCloudAccountSession(): Promise<void> {
    const cloud = this.requireCloud();
    try {
      const persisted = await cloud.sessionStore.load();
      if (!persisted) {
        return;
      }
      if (/^https:\/\/remote\.openbitfun\.com\/v\/[^/]+\/?$/.test(persisted.relayUrl) && persisted.relayUrl.replace(/\/+$/, '') !== OFFICIAL_RELAY_URL) {
        // Relay credentials are database-scoped; never replay an older credential at a new endpoint.
        this.selectedRelayUrl = OFFICIAL_RELAY_URL;
        this.cloudRelayUrl = OFFICIAL_RELAY_URL;
        // Saved profile identity is not authentication against the current relay.
        // Keep the encrypted record and display name, but expose the sign-in entry.
        cloud.remoteState.setAccountUserId('');
        cloud.remoteState.setAccountUsername(persisted.username || persisted.userId);
        cloud.remoteState.setStatusText(RemoteI18n.t('remote.settings.relayReauthorizationRequired'));
        RemoteLogger.warn('Saved account requires authorization for the current relay');
        return;
      }
      const session: CloudAccountSession = {
        token: persisted.token,
        userId: persisted.userId,
        masterKey: Encoding.base64ToBytes(persisted.masterKey)
      };
      this.applyCloudAccountSession(session, persisted.relayUrl, persisted.username || session.userId);
      this.restorePersistedControlTarget(persisted);
    } catch (err) {
      RemoteLogger.warn(`cloud account restore failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      // Retain the encrypted record. A temporary keystore/storage failure must
      // not turn into an implicit logout and erase the only resumable session.
      cloud.remoteState.setStatusText(ConnectionErrorPolicy.errorText(err));
    }
  }

  /**
   * Names the desktop this account was last driving, without connecting to it.
   *
   * The account path has no pairing snapshot on disk the way the scanned-room
   * path does — the target rides along in the encrypted account record — so
   * without this a cold start could not even say which desktop it used to be
   * on, and the restore that follows would have nothing to aim at.
   */
  private restorePersistedControlTarget(persisted: PersistedCloudAccountSession): void {
    const targetId = (persisted.targetDeviceId || '').trim();
    if (targetId.length === 0) {
      return;
    }
    const targetName = (persisted.targetDeviceName || '').trim() || targetId;
    this.setPreferredCloudTarget(targetId, targetName);
    this.restorePreferredCloudTargetProjection();
  }

  private async expireCloudAccountSession(): Promise<void> {
    const cloud = this.requireCloud();
    cloud.hooks.invalidatePreview();
    // Revocation removes live authority, not the user's encrypted record or
    // cached remote sessions. Only explicit logout may erase those records.
    this.teardownCloudAccountProjection(cloud);
    RemoteLogger.info('cloud account session expired');
  }

  /** Publishes the complete signed-out projection as one synchronous transition. */
  private teardownCloudAccountProjection(
    cloud: CloudAccountSettingsDependencies
  ): void {
    // Invalidate late device-selection completions before touching observable
    // state. During an in-flight switch the target is deliberately `none`, but
    // its busy/status/session projection still belongs to the account.
    cloud.client.closeAccount();
    this.accountDeviceSelectionVersion += 1;
    this.resetAccountDeviceConnection(true);
    this.clearCloudAccountIdentity(cloud);
  }

  private async saveControlTargetType(controlTargetType: string): Promise<void> {
    try {
      await this.requireCloud().hooks.saveControlTargetType(controlTargetType);
    } catch (err) {
      RemoteLogger.warn(`control target preference persistence failed: ${String(err)}`);
    }
  }

  /** Drops the remaining account identity facts after remote teardown. */
  private clearCloudAccountIdentity(cloud: CloudAccountSettingsDependencies): void {
    this.stopPresencePolling();
    this.accountLoginVersion += 1;
    this.cloudSession?.masterKey.fill(0);
    this.cloudSession = undefined;
    this.cloudRelayUrl = '';
    this.cloudAccountUsername = '';
    this.clearPreferredCloudTarget();
    this.accountDevices = [];
    this.lastAccountDevicesAt = 0;
    cloud.hooks.onAccountDevices([]);
    cloud.remoteState.setAccountUserId('');
    cloud.remoteState.setAccountUsername('');
    cloud.remoteState.setAccountAvatarUrl('');
  }

  private prepareAccountDeviceConnection(deviceId: string): void {
    const cloud = this.requireCloud();
    cloud.hooks.onBeforeControlTargetChange();
    cloud.hooks.invalidatePreview();
    cloud.hooks.invalidateRemoteActivity();
    cloud.hooks.invalidateRemoteConnection();
    cloud.hooks.stopPolling();
    cloud.hooks.stopHeartbeat();
    cloud.remoteState.setConnectionState('reconnecting');
    cloud.remoteState.setLoadingHome(true);
    cloud.remoteState.clearControlTarget();
    cloud.remoteState.setWorkspace(RemoteI18n.t('status.notConnected'), '', '', '', 'normal');
    // The workspace catalog belongs to the control target, just like the
    // workspace and session projection above. Keeping it alive across this
    // boundary makes the outgoing desktop's catalog look like the incoming
    // desktop's while the latter is still connecting.
    cloud.remoteState.clearWorkspaceActions();
    cloud.hooks.onControlTargetLoading(deviceId);
    cloud.remoteState.setBusy(true);
    cloud.remoteState.setStatusText(RemoteI18n.t('remote.settings.deviceConnecting'));
    cloud.remoteState.clearActiveSession();
    cloud.hooks.resetTimeline();
    cloud.hooks.resetKnownRemoteState();
    cloud.remoteState.setSessions([], false);
  }

  private resetAccountDeviceConnection(clearWorkspace: boolean): void {
    const cloud = this.requireCloud();
    cloud.hooks.invalidateRemoteActivity();
    cloud.hooks.stopPolling();
    cloud.hooks.stopHeartbeat();
    cloud.sessionManager.reset();
    cloud.remoteState.resetConversationContext();
    cloud.hooks.resetTimeline();
    cloud.hooks.resetKnownRemoteState();
    if (clearWorkspace) {
      cloud.remoteState.setWorkspace(RemoteI18n.t('status.notConnected'), '', '', '', 'normal');
      cloud.remoteState.setAuthenticatedUserId('');
      cloud.remoteState.clearWorkspaceActions();
    }
    cloud.remoteState.clearControlTarget();
    cloud.remoteState.setConnectionState('disconnected');
  }

  private setPreferredCloudTarget(deviceId: string, deviceName: string): void {
    this.preferredTargetDeviceId = deviceId.trim();
    this.preferredTargetDeviceName = deviceName.trim() || this.preferredTargetDeviceId;
  }

  private clearPreferredCloudTarget(): void {
    this.preferredTargetDeviceId = '';
    this.preferredTargetDeviceName = '';
  }

  private restorePreferredCloudTargetProjection(): void {
    const target = this.preferredCloudTarget();
    if (!target) {
      return;
    }
    const remoteState = this.requireCloud().remoteState;
    remoteState.setControlTarget('account_device', target.deviceId, target.deviceName);
    remoteState.setDesktopIdentity(target.deviceName, target.deviceId);
  }

  private async persistCurrentCloudSessionTarget(deviceId: string, deviceName: string): Promise<void> {
    const cloud = this.requireCloud();
    const session = this.cloudSession;
    if (!session || this.cloudRelayUrl.length === 0) {
      return;
    }
    await cloud.sessionStore.save({
      relayUrl: this.cloudRelayUrl,
      username: this.cloudAccountUsername || session.userId,
      token: session.token,
      userId: session.userId,
      masterKey: Encoding.bytesToBase64(session.masterKey),
      targetDeviceId: deviceId.trim(),
      targetDeviceName: deviceName.trim() || deviceId.trim()
    });
  }

  private requireCloud(): CloudAccountSettingsDependencies {
    if (!this.cloud) {
      throw new Error('Cloud account settings dependencies are not configured.');
    }
    return this.cloud;
  }
}
