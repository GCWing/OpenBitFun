import { ReadFileChunkResult } from '../main/ets/model/RemoteModels';
import { GitHubAccountProfile, GitHubProfileLoader, normalizeGitHubProfile, readCachedGitHubProfile } from '../main/ets/services/GitHubAccountProfile';
import { accountDeviceLink } from '../main/ets/services/AccountDeviceLink';
import { describe, it, expect } from '@ohos/hypium';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { ChatSessionController, ChatSessionSnapshot } from '../main/ets/services/ChatSessionController';
import { ChatComposerPolicy, ComposerPrimaryAction } from '../main/ets/services/ChatComposerPolicy';
import { ChatTimelineItem, ChatTimelineProjector } from '../main/ets/services/ChatTimelineProjector';
import { ChatTimelineStore } from '../main/ets/services/ChatTimelineStore';
import { ConversationEvent } from '../main/ets/services/ConversationEvent';
import { AsyncLifecycleGate } from '../main/ets/services/AsyncLifecycleGate';
import { Encoding } from '../main/ets/services/Encoding';
import {
  GeneralChatDraftStore,
  GeneralChatLocalStore,
  GeneralChatSendResult,
  GeneralChatStreamCallbacks,
  GeneralChatStreamObserver
} from '../main/ets/services/general-chat/GeneralChatPort';
import { GeneralChatApiClient } from '../main/ets/services/general-chat/GeneralChatApiClient';
import { GeneralChatBootstrapController } from '../main/ets/services/general-chat/GeneralChatBootstrapController';
import { GeneralChatCommandClient, GeneralChatCommandController } from '../main/ets/services/general-chat/GeneralChatCommandController';
import {
  GeneralChatConfigSnapshot,
  GeneralChatConfigStore,
  GeneralChatConfigUpdate,
  GeneralChatConfigValidator,
  GeneralChatModelSelectionPolicy
} from '../main/ets/services/general-chat/GeneralChatConfigStore';
import { GeneralChatDraftController, GeneralChatDraftScheduler } from '../main/ets/services/general-chat/GeneralChatDraftController';
import { GeneralChatDraftLifecycleController } from '../main/ets/services/general-chat/GeneralChatDraftLifecycleController';
import { GeneralChatCloudConfigPolicy } from '../main/ets/services/general-chat/GeneralChatCloudConfigPolicy';
import { GeneralChatEventMapper } from '../main/ets/services/general-chat/GeneralChatEventMapper';
import { GeneralChatExportFormatter } from '../main/ets/services/general-chat/GeneralChatExportFormatter';
import {
  GeneralChatHttpHeaders,
  GeneralChatHttpMethod,
  GeneralChatHttpResponse,
  GeneralChatHttpTransport,
  GeneralChatTokenProvider
} from '../main/ets/services/general-chat/GeneralChatHttpTransport';
import { GeneralChatRepository } from '../main/ets/services/general-chat/GeneralChatRepository';
import {
  GeneralChatServiceState,
  GeneralChatServiceStatus
} from '../main/ets/services/general-chat/GeneralChatServiceState';
import { GeneralChatStreamCoordinator } from '../main/ets/services/general-chat/GeneralChatStreamCoordinator';
import { GeneralChatStreamLifecycleController } from '../main/ets/services/general-chat/GeneralChatStreamLifecycleController';
import {
  ModelProviderGeneralChatAdapter,
  ModelProviderMessage,
  ModelProviderHttpTransport,
  ModelProviderProtocol
} from '../main/ets/services/general-chat/ModelProviderGeneralChatAdapter';
import { ModelProviderSseParser } from '../main/ets/services/general-chat/ModelProviderSseParser';
import { MockGeneralChatAdapter } from '../main/ets/services/general-chat/MockGeneralChatAdapter';
import { MarkdownParser } from '../main/ets/services/MarkdownParser';
import { RemoteCommandFactory } from '../main/ets/services/RemoteCommandFactory';
import { toRemoteQuestionAnswer } from '../main/ets/pages/state/ConversationUiModels';
import { RemoteCrypto, RemoteCryptoCipher } from '../main/ets/services/RemoteCrypto';
import { RemoteActivityLifecycleController } from '../main/ets/services/RemoteActivityLifecycleController';
import { RemoteChatCommandClient, RemoteChatCommandController } from '../main/ets/services/RemoteChatCommandController';
import { RemoteChatPollingLifecycleController } from '../main/ets/services/RemoteChatPollingLifecycleController';
import {
  RemoteFileDownloadClient,
  RemoteFileDownloadController,
  RemoteFileDownloadScheduler
} from '../main/ets/services/RemoteFileDownloadController';
import { RemoteHeartbeatController, RemoteHeartbeatScheduler } from '../main/ets/services/RemoteHeartbeatController';
import {
  RemoteModelClient,
  RemoteModelController,
  RemoteModelPreferenceStore
} from '../main/ets/services/RemoteModelController';
import { RemoteResponseMapper } from '../main/ets/services/RemoteResponseMapper';
import { RemoteSessionClient, RemoteSessionController } from '../main/ets/services/RemoteSessionController';
import { RemoteSessionManager } from '../main/ets/services/RemoteSessionManager';
import { RemoteWorkspaceCoordinator } from '../main/ets/services/RemoteWorkspaceCoordinator';
import { RemoteWorkspaceDataSource } from '../main/ets/services/RemoteWorkspaceRepository';
import { RemoteToolActionClient, RemoteToolActionController } from '../main/ets/services/RemoteToolActionController';
import { RemoteUiState } from '../main/ets/services/RemoteUiState';
import {
  VoiceInputLifecycleCallbacks,
  VoiceInputLifecycleController,
  VoiceInputRouteSnapshot
} from '../main/ets/services/VoiceInputLifecycleController';
import { VoiceInputCallbacks, VoiceInputService } from '../main/ets/services/VoiceInputService';
import { AppShellState } from '../main/ets/pages/state/AppShellState';
import { GeneralChatPageState } from '../main/ets/pages/state/GeneralChatPageState';
import {
  CloudAccountSettingsDependencies,
  CloudAccountSettingsHooks,
  SettingsController
} from '../main/ets/pages/viewmodel/SettingsController';
import {
  CloudAccountClient,
  CloudAccountDevice,
  CloudProvisionedDevice,
  CloudAccountRequestError,
  CloudAccountSession
} from '../main/ets/services/CloudAccountClient';
import {
  CloudAccountSessionStore,
  PersistedCloudAccountSession
} from '../main/ets/services/CloudAccountSessionStore';
import { RemotePageState } from '../main/ets/pages/state/RemotePageState';
import { ConversationViewState } from '../main/ets/pages/state/ConversationViewState';
import {
  GENERAL_CHAT_COMPOSER_CAPABILITIES,
  REMOTE_CHAT_COMPOSER_CAPABILITIES
} from '../main/ets/pages/state/ChatComposerCapabilities';
import { ChatSurface } from '../main/ets/pages/state/ChatSurface';
import { ConversationViewContract } from '../main/ets/pages/components/ConversationViewContract';
import {
  AppNavigationBackAction,
  AppNavigationPathSpec,
  AppRoute,
  AppRouteContract
} from '../main/ets/pages/navigation/AppRouteContract';
import { TimeFormat } from '../main/ets/services/TimeFormat';
import { X25519 } from '../main/ets/services/X25519';
import {
  ChatMessage,
  CommandStatusResponse,
  FileInfo,
  ImageAttachment,
  PollSessionResult,
  RecentWorkspaceEntry,
  AssistantEntry,
  CreateSessionOptions,
  RemoteImageContext,
  RemoteQuestionAnswerPayload,
  InitialSyncResult,
  InitialSyncResponse,
  RemoteModelCatalog,
  ReadFileResult,
  RemoteCommand,
  RemoteSession,
  SelectedImageAttachment,
  SessionItemResponse,
  SessionListResult,
  SessionMessagesResult,
  SessionSummary,
  WorkspaceInfo
} from '../main/ets/model/RemoteModels';

import {
  ToolInputFixture,
  CryptoImageFixture,
  CryptoCommandFixture,
  CryptoSimpleCommandFixture,
  GeneralChatRecordedRequest,
  FakeRemoteWorkspaceDataSource,
  FakeRemoteCryptoCipher,
  hexToBytes,
  bytesToHex,
  fixedRandomBytes,
  expectCommandJson,
  connectedPeers,
  chatMessage,
  remoteSession,
  selectedImage,
  remoteModelCatalog,
  activeChatMessage,
  chatMessageWithImage,
  imageAttachment,
  pollResult,
  delay,
  FakePollSessionManager,
  BlockingPollSessionManager,
  FakeGeneralChatLocalStore,
  FailingGeneralChatAdapter,
  PartialFailingGeneralChatAdapter,
  FakeGeneralChatTokenProvider,
  FakeGeneralChatHttpTransport,
  FakeRemoteHeartbeatScheduler,
  FakeGeneralChatDraftScheduler,
  FakeVoiceInputLifecycleService,
  FakeRemoteFileDownloadScheduler,
  FakeRemoteFileDownloadClient,
  RemoteDownloadStatusRecord,
  FakeRemoteToolActionClient,
  FakeRemoteModelClient,
  FakeRemoteModelPreferenceStore,
  RemoteModelProjectionRecord,
  FakeRemoteSessionClient,
  RemoteSessionProjectionRecord,
  FakeRemoteChatCommandClient,
  RemoteChatMessagesProjectionRecord,
  FakeGeneralChatCommandClient,
  FakeGeneralChatConfigStore
} from './LocalTestFixtures';

class ModelProviderRecordedRequest {
  url: string = '';
  apiKey: string = '';
  body: string = '';
  protocol: ModelProviderProtocol = ModelProviderProtocol.OpenAi;
}

class ModelProviderRecordedResponse {
  statusCode: number = 200;
  body: string = '';
}

class FakeModelProviderHttpTransport implements ModelProviderHttpTransport {
  requests: ModelProviderRecordedRequest[] = [];
  responses: ModelProviderRecordedResponse[] = [];

  async postStream(
    url: string,
    apiKey: string,
    body: string,
    protocol: ModelProviderProtocol,
    onData: (chunk: string) => void
  ): Promise<ModelProviderRecordedResponse> {
    const request = new ModelProviderRecordedRequest();
    request.url = url;
    request.apiKey = apiKey;
    request.body = body;
    request.protocol = protocol;
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Missing fake model provider HTTP response.');
    }
    if (response.body.length > 0) {
      onData(response.body);
    }
    return response;
  }

  cancel(): void {
  }
}

function modelProviderRecordedResponse(statusCode: number, body: string): ModelProviderRecordedResponse {
  const response = new ModelProviderRecordedResponse();
  response.statusCode = statusCode;
  response.body = body;
  return response;
}

class InMemorySettingsConfigStore extends GeneralChatConfigStore {
  snapshotResult: GeneralChatConfigSnapshot = {
    apiUrl: '',
    modelName: '',
    hasApiKey: false
  };
  accessTokenResult: string = '';
  modelCatalogResults: RemoteModelCatalog[] = [];
  modelCatalogCalls: number = 0;
  saveRequests: GeneralChatConfigUpdate[] = [];
  selectLocalModelCalls: number = 0;

  async snapshot(): Promise<GeneralChatConfigSnapshot> {
    return this.snapshotResult;
  }

  async save(update: GeneralChatConfigUpdate): Promise<GeneralChatConfigSnapshot> {
    this.saveRequests.push(update);
    this.snapshotResult = {
      apiUrl: update.apiUrl.trim(),
      modelName: update.modelName.trim(),
      hasApiKey: !update.clearApiKey
    };
    return this.snapshotResult;
  }

  async accessToken(): Promise<string> {
    return this.accessTokenResult;
  }

  async modelCatalog(): Promise<RemoteModelCatalog> {
    const index = Math.min(this.modelCatalogCalls, this.modelCatalogResults.length - 1);
    this.modelCatalogCalls += 1;
    if (index >= 0) {
      return this.modelCatalogResults[index];
    }
    return { version: 1, models: [], default_models: {} };
  }

  async selectLocalModel(): Promise<void> {
    this.selectLocalModelCalls += 1;
  }

  async activeSnapshot(): Promise<GeneralChatConfigSnapshot> {
    return this.snapshotResult;
  }

  async activeAccessToken(): Promise<string> {
    return this.accessTokenResult;
  }
}

/** Answers the handshake for every device except the ones named unreachable. */
class ScriptedAccountSessionManager extends RemoteSessionManager {
  readonly unreachable: Set<string> = new Set<string>();
  readonly dialled: string[] = [];
  resets: number = 0;

  async connectAccountDevice(
    _accountClient: CloudAccountClient,
    _relayUrl: string,
    session: CloudAccountSession,
    targetDeviceId: string
  ): Promise<InitialSyncResult> {
    this.dialled.push(targetDeviceId);
    if (this.unreachable.has(targetDeviceId)) {
      throw new Error('目标桌面暂时不可用，请刷新设备列表后重试。');
    }
    return {
      workspace: {
        path: `/w/${targetDeviceId}`,
        name: targetDeviceId,
        hasWorkspace: true,
        gitBranch: 'main',
        workspaceKind: 'normal'
      },
      sessions: [],
      hasMoreSessions: false,
      authenticatedUserId: session.userId
    };
  }

  reset(): void {
    this.resets += 1;
    super.reset();
  }
}

class OutputFileSessionManager extends RemoteSessionManager {
  readonly offsets: number[] = [];
  invalid: boolean = false;
  revisionChanges: boolean = false;

  async readFileChunk(_path: string, offset: number, _limit: number, _sessionId?: string): Promise<ReadFileChunkResult> {
    this.offsets.push(offset);
    const bytes = offset === 0 ? 'a' : 'bcd';
    return { name: 'preview.png', contentBase64: Encoding.bytesToBase64(Encoding.utf8ToBytes(bytes)),
      offset: this.invalid && offset > 0 ? 0 : offset, chunkSize: bytes.length, totalSize: 4, mimeType: 'image/png',
      revision: this.revisionChanges ? `4:${offset}` : undefined };
  }
}

class TestCloudAccountClient extends CloudAccountClient {
  observePresence(_relay: string, _session: CloudAccountSession, _onPresence: (ids: string[]) => void,
    _onReconnect: () => void): () => void { return () => {}; }
}

class RecordingAccountDeviceClient extends TestCloudAccountClient {
  async deviceRpc<T extends CommandStatusResponse>(
    _relayUrl: string,
    _session: CloudAccountSession,
    _targetDeviceId: string,
    command: RemoteCommand,
    _timeoutMs: number = 130000
  ): Promise<T> {
    if (command.cmd === 'get_workspace_info') {
      return JSON.parse(
        '{"resp":"workspace_info","has_workspace":true,"workspace_path":"/account-workspace",' +
        '"workspace_name":"Account workspace"}'
      ) as T;
    }
    return JSON.parse(
      '{"resp":"session_list","sessions":[{"session_id":"account-device-session",' +
      '"name":"Account device session","agent_type":"agentic"}],"has_more":false}'
    ) as T;
  }
}

/** Holds one switch so a newer device choice can finish first. */
class GatedAccountSessionManager extends ScriptedAccountSessionManager {
  private releaseHeldSwitch: () => void = () => {};
  private markHeldSwitchStarted: () => void = () => {};
  private readonly heldSwitch: Promise<void>;
  readonly heldSwitchStarted: Promise<void>;

  constructor() {
    super();
    this.heldSwitch = new Promise<void>((resolve: () => void) => {
      this.releaseHeldSwitch = resolve;
    });
    this.heldSwitchStarted = new Promise<void>((resolve: () => void) => {
      this.markHeldSwitchStarted = resolve;
    });
  }

  async connectAccountDevice(
    _accountClient: CloudAccountClient,
    _relayUrl: string,
    session: CloudAccountSession,
    targetDeviceId: string
  ): Promise<InitialSyncResult> {
    this.dialled.push(targetDeviceId);
    if (targetDeviceId === 'desk-a') {
      this.markHeldSwitchStarted();
      await this.heldSwitch;
    }
    return {
      workspace: {
        path: `/w/${targetDeviceId}`,
        name: targetDeviceId,
        hasWorkspace: true,
        gitBranch: 'main',
        workspaceKind: 'normal'
      },
      sessions: [],
      hasMoreSessions: false,
      authenticatedUserId: session.userId
    };
  }

  release(): void {
    this.releaseHeldSwitch();
  }
}

/** HUKS and preferences are not reachable from a local unit run. */
class InMemoryCloudAccountSessionStore extends CloudAccountSessionStore {
  readonly saved: PersistedCloudAccountSession[] = [];
  profile?: GitHubAccountProfile;
  async loadProfile(_userId: string): Promise<GitHubAccountProfile | undefined> { return this.profile; }
  async saveProfile(profile: GitHubAccountProfile): Promise<void> { this.profile = profile; }
  clears: number = 0;
  failSaves: boolean = false;
  failLoads: boolean = false;

  async init(_context: Context): Promise<void> {
  }

  async save(session: PersistedCloudAccountSession): Promise<void> {
    if (this.failSaves) {
      throw new Error('storage unavailable');
    }
    this.saved.push(session);
  }

  async load(): Promise<PersistedCloudAccountSession | undefined> {
    if (this.failLoads) {
      throw new Error('keystore temporarily unavailable');
    }
    return undefined;
  }

  async clear(): Promise<void> {
    this.clears += 1;
  }
}

/** Publishes one roster, then models the relay revoking the account token. */
class ExpiringAccountClient extends TestCloudAccountClient {
  listCalls: number = 0;

  async listDevices(
    _relayUrl: string,
    _session: CloudAccountSession,
    _selfDeviceId: string = ''
  ): Promise<CloudAccountDevice[]> {
    this.listCalls += 1;
    if (this.listCalls === 1) {
      return [{ deviceId: 'desk-a', deviceName: 'Desktop A', online: true }];
    }
    throw new CloudAccountRequestError('expired', 401);
  }
}

class OfflineAccountClient extends TestCloudAccountClient {
  async listDevices(
    _relayUrl: string,
    _session: CloudAccountSession,
    _selfDeviceId: string = ''
  ): Promise<CloudAccountDevice[]> {
    return [{ deviceId: 'desk-a', deviceName: 'Desktop A', online: false }];
  }
}

class ProvisioningFailureAccountClient extends TestCloudAccountClient {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }

  async provisionDevice(
    _relayUrl: string,
    _session: CloudAccountSession,
    _deviceId: string,
    _deviceName: string,
    _requestId: string
  ): Promise<CloudProvisionedDevice> {
    throw new CloudAccountRequestError('provisioning failed', this.statusCode);
  }
}

class TestGitHubProfileLoader implements GitHubProfileLoader {
  calls: number = 0;
  fail: boolean = false;
  beforeResponse: () => Promise<void> = async (): Promise<void> => {};
  async load(userId: string): Promise<GitHubAccountProfile> {
    this.calls++;
    await this.beforeResponse();
    if (this.fail) throw new Error('offline');
    return normalizeGitHubProfile(userId, { id: Number(userId), login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
  }
}

class AccountDeviceSwitchHarness {
  readonly remoteState: RemotePageState = new RemotePageState();
  readonly sessionManager: ScriptedAccountSessionManager;
  readonly sessionStore: InMemoryCloudAccountSessionStore = new InMemoryCloudAccountSessionStore();
  heartbeatStarts: number = 0;
  heartbeatStops: number = 0;
  timelineResets: number = 0;
  knownRemoteStateResets: number = 0;
  cachedRemoteClears: number = 0;
  settingsClosings: number = 0;
  readonly accountDeviceSnapshots: CloudAccountDevice[][] = [];
  readonly loadingCatalogTargets: string[] = [];
  readonly changedWorkspaceSnapshots: string[][] = [];
  readonly savedControlTargetTypes: string[] = [];
  readonly controller: SettingsController;

  constructor(
    client: CloudAccountClient = new TestCloudAccountClient(),
    sessionManager: ScriptedAccountSessionManager = new ScriptedAccountSessionManager(),
    applyExistingSession: boolean = true,
    profileLoader?: GitHubProfileLoader
  ) {
    this.sessionManager = sessionManager;
    const hooks: CloudAccountSettingsHooks = {
      openAuthorization: async (_url: string): Promise<boolean> => true,
      deviceId: (): string => 'phone',
      remoteAvailable: (): boolean => true,
      invalidatePreview: (): void => {},
      invalidateRemoteActivity: (): void => {},
      invalidateRemoteConnection: (): void => {},
      stopPolling: (): void => {},
      stopHeartbeat: (): void => { this.heartbeatStops += 1; },
      startHeartbeat: (): void => { this.heartbeatStarts += 1; },
      resetTimeline: (): void => { this.timelineResets += 1; },
      resetKnownRemoteState: (): void => { this.knownRemoteStateResets += 1; },
      clearCachedRemoteData: async (): Promise<void> => { this.cachedRemoteClears += 1; },
      closeSettings: (): void => { this.settingsClosings += 1; },
      closeConnectSheet: (): void => {},
      navigateRemoteHome: (): void => {},
      loadRecentWorkspaces: async (): Promise<void> => {},
      saveControlTargetType: async (controlTargetType: string): Promise<void> => {
        this.savedControlTargetTypes.push(controlTargetType);
      },
      onAccountDevices: (devices: CloudAccountDevice[]): void => {
        this.accountDeviceSnapshots.push(devices.slice());
      },
      onBeforeControlTargetChange: (): void => {},
      onControlTargetLoading: (deviceId: string): void => {
        this.loadingCatalogTargets.push(deviceId);
      },
      onControlTargetChanged: (): void => {
        this.changedWorkspaceSnapshots.push(
          this.remoteState.recentWorkspaces.map((item: RecentWorkspaceEntry): string => item.path)
        );
      }
    };
    const cloud: CloudAccountSettingsDependencies = {
      client,
      sessionStore: this.sessionStore,
      profileLoader,
      sessionManager: this.sessionManager,
      remoteState: this.remoteState,
      hooks
    };
    this.controller = new SettingsController(cloud);
    if (applyExistingSession) {
      this.controller.applyCloudAccountSession(
        { token: 't', userId: 'u', masterKey: new Uint8Array(32) },
        'https://relay.example.com',
        'someone'
      );
    }
  }

  device(deviceId: string): CloudAccountDevice {
    return { deviceId, deviceName: deviceId, online: true };
  }
}

export default function transportAndGeneralChatUnitTest() {
  describe('Account device links', () => {
    it('uses the same device selector for official and LAN endpoints', 0, () => {
      for (const endpoint of ['https://remote.openbitfun.com/v/1.0.1', 'http://192.168.1.10:9700']) {
        const parsed = accountDeviceLink(`${endpoint}/#/pair?did=desktop-1`);
        expect(parsed?.deviceId).assertEqual('desktop-1');
        expect(parsed?.relayUrl).assertEqual(endpoint);
      }
    });
    it('rejects credentials, legacy rooms, duplicate targets and public lookalikes', 0, () => {
      const prefix = 'https://remote.openbitfun.com/v/1.0.1/#/pair?';
      for (const suffix of ['did=desktop-1&pk=untrusted', 'did=desktop-1&relay=evil',
        'did=desktop-1&did=desktop-2', 'did=%00', 'did=%ZZ', 'room=old&pk=old']) {
        expect(accountDeviceLink(prefix + suffix)).assertUndefined();
      }
      expect(accountDeviceLink('https://evil.test/v/1.0.0/#/pair?did=desktop-1')).assertUndefined();
      expect(accountDeviceLink('https://remote.openbitfun.com@evil.test/v/1.0.0/#/pair?did=desktop-1')).assertUndefined();
    });
  });

  describe('Output file transfer', () => {
    it('reassembles short padded chunks as bytes', 0, async () => {
      const manager = new OutputFileSessionManager();
      const file = await manager.readFile('preview.png', 'origin-session');
      expect(Encoding.bytesToUtf8(Encoding.base64ToBytes(file.contentBase64))).assertEqual('abcd');
      expect(manager.offsets.join(',')).assertEqual('0,1');
    });
    it('rejects a wrong offset instead of downloading a corrupt file', 0, async () => {
      const manager = new OutputFileSessionManager();
      manager.invalid = true;
      let failed = false;
      try { await manager.readFile('preview.png', 'origin-session'); } catch (_) { failed = true; }
      expect(failed).assertTrue();
    });
    it('rejects a changed revision even when the file size is unchanged', 0, async () => {
      const manager = new OutputFileSessionManager();
      manager.revisionChanges = true;
      let failed = false;
      try { await manager.readFile('preview.png', 'origin-session'); } catch (_) { failed = true; }
      expect(failed).assertTrue();
    });
    it('does not request the next chunk after the target is reset', 0, async () => {
      const manager = new OutputFileSessionManager();
      let failed = false;
      try { await manager.readFile('preview.png', 'origin-session', () => manager.reset()); } catch (_) { failed = true; }
      expect(failed).assertTrue();
      expect(manager.offsets.length).assertEqual(1);
    });
  });

  describe('RemoteSessionManager account connection', () => {
    it('loads account device sessions through either relay endpoint', 0, async () => {
      const manager = new RemoteSessionManager();
      for (const endpoint of ['https://remote.openbitfun.com/v/1.0.1', 'http://192.168.1.10:9700']) {
        const result = await manager.connectAccountDevice(new RecordingAccountDeviceClient(), endpoint,
          { token: 'token', userId: 'account-user', masterKey: new Uint8Array(32) }, 'desktop-device');
        expect(result.workspace.path).assertEqual('/account-workspace');
        expect(result.sessions[0].id).assertEqual('account-device-session');
        expect(result.authenticatedUserId).assertEqual('account-user');
      }
    });
  });

  describe('X25519', () => {
    const alicePrivate = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
    const alicePublic = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    const bobPrivate = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
    const bobPublic = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
    const sharedSecret = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    const mobileWebPrivate = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const mobileWebPublic = '8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f';
    const desktopPrivate = 'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff';
    const desktopPublic = 'ed99ba8df1a6a8c6396beafc3a42b8212fde389a7663217e170e82b68377e858';
    const mobileWebSharedSecret = '251b4e394babbef8dc30269e5a065946c08d89d6df010376549baa469c552f4b';

    it('matches RFC 7748 public key vectors', 0, () => {
      expect(bytesToHex(X25519.scalarMultBase(hexToBytes(alicePrivate)))).assertEqual(alicePublic);
      expect(bytesToHex(X25519.scalarMultBase(hexToBytes(bobPrivate)))).assertEqual(bobPublic);
    });

    it('matches RFC 7748 shared secret vector from both peers', 0, () => {
      expect(bytesToHex(X25519.scalarMult(hexToBytes(alicePrivate), hexToBytes(bobPublic)))).assertEqual(sharedSecret);
      expect(bytesToHex(X25519.scalarMult(hexToBytes(bobPrivate), hexToBytes(alicePublic)))).assertEqual(sharedSecret);
    });

    it('matches the mobile-web noble-curves shared secret shape', 0, () => {
      expect(bytesToHex(X25519.scalarMultBase(hexToBytes(mobileWebPrivate)))).assertEqual(mobileWebPublic);
      expect(bytesToHex(X25519.scalarMultBase(hexToBytes(desktopPrivate)))).assertEqual(desktopPublic);
      expect(bytesToHex(X25519.scalarMult(hexToBytes(mobileWebPrivate), hexToBytes(desktopPublic))))
        .assertEqual(mobileWebSharedSecret);
      expect(bytesToHex(X25519.scalarMult(hexToBytes(desktopPrivate), hexToBytes(mobileWebPublic))))
        .assertEqual(mobileWebSharedSecret);
    });
  });

  describe('RemoteCrypto', () => {
    it('encrypts and decrypts JSON between derived peers', 0, async () => {
      const peers = connectedPeers();
      const alice = peers[0];
      const bob = peers[1];
      const command: CryptoCommandFixture = {
        cmd: 'send_message',
        session_id: 'session-1',
        content: 'hello from mobile',
        agent_type: 'code',
        image_contexts: [{
          id: 'image-1',
          data_url: 'data:image/png;base64,aGVsbG8=',
          mime_type: 'image/png'
        }]
      };

      const encrypted = await alice.encryptJson(command);
      const decrypted = await bob.decryptJson<CryptoCommandFixture>(encrypted);

      expect(decrypted.cmd).assertEqual(command.cmd);
      expect(decrypted.session_id).assertEqual(command.session_id);
      expect(decrypted.content).assertEqual(command.content);
      expect(decrypted.agent_type).assertEqual(command.agent_type);
      expect(decrypted.image_contexts.length).assertEqual(1);
      expect(decrypted.image_contexts[0].id).assertEqual('image-1');
      expect(decrypted.image_contexts[0].mime_type).assertEqual('image/png');
    });

    it('produces relay-compatible encrypted payload shape', 0, async () => {
      const peers = connectedPeers();
      const command: CryptoSimpleCommandFixture = {
        cmd: 'get_workspace_info'
      };
      const encrypted = await peers[0].encryptJson(command);
      const keys = Object.keys(encrypted).sort().join(',');
      const nonce = Encoding.base64ToBytes(encrypted.nonce);
      const encryptedData = Encoding.base64ToBytes(encrypted.encrypted_data);

      expect(keys).assertEqual('encrypted_data,nonce');
      expect(nonce.length).assertEqual(12);
      expect(encryptedData.length).assertLarger(16);
      expect(encrypted.encrypted_data.indexOf('get_workspace_info')).assertEqual(-1);
      const decrypted = await peers[1].decryptJson<CryptoCommandFixture>(encrypted);
      expect(decrypted.cmd).assertEqual('get_workspace_info');
    });

    it('rejects use before shared-key derivation', 0, async () => {
      let didThrow = false;
      try {
        const command: CryptoSimpleCommandFixture = {
          cmd: 'ping'
        };
        const privateKey = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
        await new RemoteCrypto({
          cipher: new FakeRemoteCryptoCipher(),
          keyPair: {
            privateKey,
            publicKey: X25519.scalarMultBase(privateKey)
          },
          randomBytes: fixedRandomBytes
        }).encryptJson(command);
      } catch (_err) {
        didThrow = true;
      }
      expect(didThrow).assertEqual(true);
    });
  });

  describe('TimeFormat', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z');

    it('formats recent timestamps as just now', 0, () => {
      expect(TimeFormat.relative('2026-06-10T11:59:45.000Z', now)).assertEqual(RemoteI18n.t('time.justNow'));
    });

    it('formats minute and hour relative timestamps', 0, () => {
      expect(TimeFormat.relative('2026-06-10T11:42:00.000Z', now)).assertEqual(RemoteI18n.f('time.minutesAgo', '18'));
      expect(TimeFormat.relative('2026-06-10T09:00:00.000Z', now)).assertEqual(RemoteI18n.f('time.hoursAgo', '3'));
    });

    it('formats older timestamps as days or dates', 0, () => {
      expect(TimeFormat.relative('2026-06-08T12:00:00.000Z', now)).assertEqual(RemoteI18n.f('time.daysAgo', '2'));
      expect(TimeFormat.relative('2026-05-30T12:00:00.000Z', now)).assertEqual(RemoteI18n.formatAbsoluteDate(
        Date.parse('2026-05-30T12:00:00.000Z')
      ));
    });

    it('does not show invalid timestamps as just now', 0, () => {
      expect(TimeFormat.relative('', now)).assertEqual(RemoteI18n.t('time.unknown'));
      expect(TimeFormat.relative('not-a-date', now)).assertEqual(RemoteI18n.t('time.unknown'));
    });

    it('formats numeric timestamps and future timestamps safely', 0, () => {
      expect(TimeFormat.relative('1781091720', now)).assertEqual(RemoteI18n.f('time.minutesAgo', '18'));
      expect(TimeFormat.timestampMs('1781091720000')).assertEqual(now - 18 * 60 * 1000);
      expect(TimeFormat.timestampMs('1781091720000000')).assertEqual(now - 18 * 60 * 1000);
      expect(TimeFormat.timestampMs('1781091720000000000')).assertEqual(now - 18 * 60 * 1000);
      expect(TimeFormat.relative('2026-06-12T12:00:00.000Z', now)).assertEqual(RemoteI18n.formatAbsoluteDate(
        Date.parse('2026-06-12T12:00:00.000Z')
      ));
    });
  });

  describe('GeneralChatRepository', () => {
    it('persists a complete ordinary chat and restores it without Remote state', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      const session = await repository.createSession('帮我整理一份发布计划');
      const result = await repository.sendMessage(session.id, '先给我三个步骤');
      await repository.recordAssistantMessage(session.id, result.assistantMessage);

      expect(repository.listSessions().length).assertEqual(1);
      expect(repository.listSessions()[0].agentType).assertEqual('chat');
      expect(repository.listSessions()[0].messageCount).assertEqual(2);

      const restored = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      await restored.restoreFromLocal();
      const restoredMessages = await restored.messages(session.id);
      expect(restored.listSessions().length).assertEqual(1);
      expect(restoredMessages.length).assertEqual(2);
      expect(restoredMessages[0].role).assertEqual('user');
      expect(restoredMessages[1].role).assertEqual('assistant');
    });

    it('renames ordinary chat sessions through the local repository', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      const session = await repository.createSession('原始标题');
      await repository.renameSession(session.id, '新的标题');

      expect(repository.listSessions()[0].title).assertEqual('新的标题');
      expect(localStore.sessions[0].title).assertEqual('新的标题');
    });

    it('archives ordinary chat sessions and restores the archived state', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      const session = await repository.createSession('待归档会话');
      await repository.archiveSession(session.id, true);

      const restored = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      await restored.restoreFromLocal();
      expect(restored.listSessions()[0].status).assertEqual('archived');

      await restored.archiveSession(session.id, false);
      expect(restored.listSessions()[0].status).assertEqual('ready');
      expect(localStore.sessions[0].status).assertEqual('ready');
    });

    it('persists drafts independently and removes session-owned data on delete', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      const session = await repository.createSession('待删除会话');
      await repository.saveDraft('new-chat', '首页草稿');
      await repository.saveDraft(session.id, '会话草稿');
      await repository.sendMessage(session.id, '一条消息');

      expect(await repository.draft('new-chat')).assertEqual('首页草稿');
      expect(await repository.draft(session.id)).assertEqual('会话草稿');
      await repository.deleteSession(session.id);

      expect(repository.listSessions().length).assertEqual(0);
      expect((await repository.messages(session.id)).length).assertEqual(0);
      expect(await repository.draft(session.id)).assertEqual('');
      expect(await repository.draft('new-chat')).assertEqual('首页草稿');
    });

    it('persists a failed user message when the provider rejects before streaming', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new FailingGeneralChatAdapter(), localStore);
      const session = await repository.createSession('失败状态');
      let failed = false;
      try {
        await repository.sendMessage(session.id, '请重试我');
      } catch (_err) {
        failed = true;
      }

      const messages = await repository.messages(session.id);
      expect(failed).assertEqual(true);
      expect(messages.length).assertEqual(1);
      expect(messages[0].status).assertEqual('failed');
    });

    it('keeps the user message sent when a stream fails after receiving content', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new PartialFailingGeneralChatAdapter(), localStore);
      const session = await repository.createSession('流中断状态');
      try {
        await repository.sendMessage(session.id, '保留这条消息');
      } catch (_err) {
      }

      const messages = await repository.messages(session.id);
      expect(messages.length).assertEqual(1);
      expect(messages[0].status).assertEqual('sent');
    });

    it('removes only the latest matching failed user message for retry', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const session = remoteSession('chat-retry-repeat', '重复失败');
      session.agentType = 'chat';
      const first = chatMessage('failed-user-1', 'user', '再试一次', 'failed');
      const second = chatMessage('failed-user-2', 'user', '再试一次', 'failed');
      localStore.sessions = [session];
      localStore.messagesBySession.set(session.id, [
        first,
        chatMessage('assistant-between', 'assistant', '中间回复'),
        second
      ]);
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      await repository.restoreFromLocal();

      await repository.removeFailedUserMessage(session.id, '再试一次');

      const messages = await repository.messages(session.id);
      expect(messages.length).assertEqual(2);
      expect(messages[0].id).assertEqual('failed-user-1');
      expect(messages[1].id).assertEqual('assistant-between');
    });

    it('does not persist assistant retry detail after an interrupted turn', 0, async () => {
      const localStore = new FakeGeneralChatLocalStore();
      const repository = new GeneralChatRepository(new MockGeneralChatAdapter(), localStore);
      const session = await repository.createSession('中断恢复');
      const interrupted = chatMessage('assistant-failed-1', 'assistant', 'Partial reply', 'failed');
      interrupted.detail = 'Retry prompt';

      await repository.recordAssistantMessage(session.id, interrupted);

      const messages = await repository.messages(session.id);
      expect(messages[0].status).assertEqual('failed');
      expect(messages[0].detail || '').assertEqual('');
      expect((await localStore.loadMessages(session.id))[0].detail || '').assertEqual('');
    });
  });

  describe('GeneralChatExportFormatter', () => {
    it('exports visible conversation content as Markdown without hidden error detail', 0, () => {
      const session: RemoteSession = {
        id: 'chat-export',
        title: '发布计划',
        agentType: 'chat',
        status: 'ready',
        updatedAt: '2026-07-20T10:00:00.000Z',
        createdAt: '2026-07-20T09:00:00.000Z',
        messageCount: 2
      };
      const failedAssistant = chatMessage('assistant-1', 'assistant', '先检查发布清单。', 'failed');
      failedAssistant.detail = 'secret retry context';
      const markdown = GeneralChatExportFormatter.markdown(session, [
        chatMessage('user-1', 'user', '帮我整理发布计划'),
        failedAssistant
      ]);

      expect(markdown).assertEqual('# 发布计划\n\n## 用户\n\n帮我整理发布计划\n\n## OpenBitFun\n\n先检查发布清单。\n');
      expect(markdown.indexOf('secret retry context')).assertEqual(-1);
    });

    it('omits a generated heading that repeats the first user message', 0, () => {
      const session: RemoteSession = {
        id: 'chat-duplicate-title',
        title: '你好你好',
        agentType: 'chat',
        status: 'ready',
        updatedAt: '2026-07-20T10:00:00.000Z',
        createdAt: '2026-07-20T09:00:00.000Z',
        messageCount: 2,
        titleGenerated: true
      };
      const markdown = GeneralChatExportFormatter.markdown(session, [
        chatMessage('user-1', 'user', '你好你好。'),
        chatMessage('assistant-1', 'assistant', '你好！有什么我可以帮你的吗？')
      ]);

      expect(markdown).assertEqual('## 用户\n\n你好你好。\n\n## OpenBitFun\n\n你好！有什么我可以帮你的吗？\n');
    });
  });

  describe('GeneralChatStreamCoordinator', () => {
    it('batches deltas into one stable active message and flushes before completion', 0, () => {
      const coordinator = new GeneralChatStreamCoordinator();
      const first = coordinator.begin('chat-1', 'turn-1');
      const flushed: ChatMessage[] = [];
      coordinator.append('chat-1', '第一段\n\n\n', () => true, (message: ChatMessage) => {
        flushed.push(message);
      });
      coordinator.append('chat-1', '第二段', () => true, (message: ChatMessage) => {
        flushed.push(message);
      });
      const terminal = coordinator.flush('chat-1', true);

      expect(first.id).assertEqual('active-turn-1');
      expect(terminal?.id || '').assertEqual(first.id);
      expect(terminal?.text || '').assertEqual('第一段\n\n第二段');
      expect(coordinator.text()).assertEqual('第一段\n\n第二段');
      coordinator.reset();
    });

    it('rejects late deltas after reset or from another session', 0, () => {
      const coordinator = new GeneralChatStreamCoordinator();
      coordinator.begin('chat-1', 'turn-1');
      coordinator.reset();

      expect(coordinator.append('chat-1', 'late', () => true, (_message: ChatMessage) => {}))
        .assertEqual(false);
      expect(coordinator.append('chat-2', 'wrong', () => true, (_message: ChatMessage) => {}))
        .assertEqual(false);
      expect(coordinator.hasActiveStream()).assertEqual(false);
    });
  });

  describe('GeneralChatStreamLifecycleController', () => {
    it('owns stream request lifecycle state around coordinator updates', 0, () => {
      const controller = new GeneralChatStreamLifecycleController();
      const active = controller.begin('chat-1');
      const flushed: ChatMessage[] = [];

      controller.setRequestInFlight(true);
      expect(controller.isRequestInFlight()).assertEqual(true);
      expect(active.id.indexOf('active-')).assertEqual(0);
      expect(controller.append('chat-1', 'hello', () => true, (message: ChatMessage) => {
        flushed.push(message);
      })).assertEqual(true);
      const terminal = controller.flush('chat-1', true);
      expect(terminal?.text || '').assertEqual('hello');
      expect(controller.text()).assertEqual('hello');

      controller.markRequestCancelled();
      expect(controller.takeRequestCancelled()).assertEqual(true);
      expect(controller.takeRequestCancelled()).assertEqual(false);
      controller.setPendingFinalMessage(chatMessage('assistant-final', 'assistant', 'stopped', 'cancelled'));
      expect(controller.takePendingFinalMessage()?.id || '').assertEqual('assistant-final');
      expect(controller.takePendingFinalMessage() === undefined).assertTrue();

      controller.setRequestInFlight(false);
      controller.reset();
      expect(controller.isRequestInFlight()).assertEqual(false);
      expect(controller.currentSessionId()).assertEqual('');
      expect(controller.hasActiveStream()).assertEqual(false);
    });
  });

  describe('GeneralChatServiceStatus', () => {
    it('derives readiness only from complete model configuration', 0, () => {
      expect(GeneralChatServiceStatus.fromConfiguration('https://api.example.com', 'model', true))
        .assertEqual(GeneralChatServiceState.Ready);
      expect(GeneralChatServiceStatus.fromConfiguration('', 'model', true))
        .assertEqual(GeneralChatServiceState.Unconfigured);
    });

    it('classifies authentication, network and provider failures independently from Remote state', 0, () => {
      expect(GeneralChatServiceStatus.fromError(RemoteI18n.t('generalChat.authenticationFailed')))
        .assertEqual(GeneralChatServiceState.AuthExpired);
      expect(GeneralChatServiceStatus.fromError('Network connection timeout.'))
        .assertEqual(GeneralChatServiceState.Offline);
      expect(GeneralChatServiceStatus.fromError(RemoteI18n.t('generalChat.serviceUnavailable')))
        .assertEqual(GeneralChatServiceState.Failed);
    });
  });

  describe('ChatComposerPolicy', () => {
    it('keeps ordinary chat send enabled across every Remote connection state', 0, () => {
      const states = ['idle', 'pairing', 'connected', 'reconnecting', 'failed', 'disconnected'];
      states.forEach((state: string) => {
        expect(ChatComposerPolicy.canSend('普通问题', 0, false, false, state)).assertEqual(true);
      });
    });

    it('still gates Remote chat when the desktop connection is unavailable', 0, () => {
      expect(ChatComposerPolicy.canSend('运行任务', 0, false, true, 'failed')).assertEqual(false);
      expect(ChatComposerPolicy.canSend('运行任务', 0, false, true, 'connected')).assertEqual(true);
      expect(ChatComposerPolicy.canSend('运行任务', 0, false, true, 'reconnecting')).assertEqual(true);
    });

    it('lets a draft outrank a running turn where the message can be handed over', 0, () => {
      expect(ChatComposerPolicy.primaryAction('追加要求', 0, false, false, true, true, true, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Send);
      expect(ChatComposerPolicy.primaryAction('', 0, false, false, true, true, true, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Stop);
    });

    it('keeps a running turn in front of the draft where nothing queues it', 0, () => {
      expect(ChatComposerPolicy.primaryAction('追加要求', 0, true, false, true, false, false, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Stop);
      expect(ChatComposerPolicy.primaryAction('', 0, true, false, true, false, false, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Stop);
    });

    it('keeps dictation in front of the draft it is still writing', 0, () => {
      expect(ChatComposerPolicy.primaryAction('说到一半', 0, false, true, false, true, true, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Stop);
      expect(ChatComposerPolicy.primaryAction('说到一半', 0, false, true, true, true, true, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Stop);
    });

    it('still shows a draft it cannot carry as blocked rather than idle', 0, () => {
      expect(ChatComposerPolicy.primaryAction('断线时写的', 0, false, false, true, true, true, 'failed', true))
        .assertEqual(ComposerPrimaryAction.SendBlocked);
    });

    it('offers dictation only once no turn is running and no draft exists', 0, () => {
      expect(ChatComposerPolicy.primaryAction('', 0, false, false, false, true, true, 'connected', true))
        .assertEqual(ComposerPrimaryAction.Voice);
      expect(ChatComposerPolicy.primaryAction('', 0, false, false, false, true, true, 'connected', false))
        .assertEqual(ComposerPrimaryAction.Idle);
    });
  });

  describe('GeneralChatApiClient', () => {
    it('builds authenticated session and turn requests', 0, async () => {
      const transport = new FakeGeneralChatHttpTransport();
      transport.responses = [{
        statusCode: 200,
        body: '{"session":{"id":"chat-1","title":"计划","status":"ready","created_at":"now","updated_at":"now","message_count":0}}'
      }, {
        statusCode: 202,
        body: '{"turn_id":"turn-1","accepted_at":"now","version":1}'
      }];
      const client = new GeneralChatApiClient(
        'https://chat.example.com/',
        new FakeGeneralChatTokenProvider(),
        transport
      );

      const session = await client.createSession('  计划  ');
      const receipt = await client.sendTurn(session.session.id, '  生成步骤  ', '  chat-model  ');

      expect(session.session.id).assertEqual('chat-1');
      expect(receipt.turn_id).assertEqual('turn-1');
      expect(transport.requests[0].url).assertEqual('https://chat.example.com/api/mobile/v1/chat/sessions');
      expect(transport.requests[0].authorization).assertEqual('Bearer test-token');
      expect(transport.requests[0].body).assertEqual('{"title":"计划"}');
      expect(transport.requests[1].method).assertEqual(GeneralChatHttpMethod.Post);
      expect(transport.requests[1].body).assertEqual('{"content":"生成步骤","model":"chat-model"}');
    });

    it('maps authentication failures without exposing response bodies', 0, async () => {
      const transport = new FakeGeneralChatHttpTransport();
      transport.responses = [{ statusCode: 401, body: '{"token":"must-not-leak"}' }];
      const client = new GeneralChatApiClient(
        'https://chat.example.com',
        new FakeGeneralChatTokenProvider(),
        transport
      );
      let message = '';
      try {
        await client.capabilities();
      } catch (err) {
        message = err instanceof Error ? err.message : `${err}`;
      }

      expect(message).assertEqual('General chat authentication expired.');
      expect(message.indexOf('must-not-leak')).assertEqual(-1);
    });
  });

  describe('GeneralChatConfigValidator', () => {
    it('accepts an existing key when URL and model are valid', 0, () => {
      const error = GeneralChatConfigValidator.validate({
        apiUrl: 'https://chat.example.com/',
        apiKey: '',
        modelName: 'chat-model',
        clearApiKey: false
      }, true);
      expect(error).assertEqual('');
    });

    it('rejects unsafe URLs and incomplete new configurations', 0, () => {
      const urlError = GeneralChatConfigValidator.validate({
        apiUrl: 'file:///tmp/chat',
        apiKey: 'secret',
        modelName: 'chat-model',
        clearApiKey: false
      }, false);
      const keyError = GeneralChatConfigValidator.validate({
        apiUrl: 'https://chat.example.com',
        apiKey: '',
        modelName: 'chat-model',
        clearApiKey: false
      }, false);
      expect(urlError).assertEqual('API URL 必须以 http:// 或 https:// 开头。');
      expect(keyError).assertEqual('请输入 API Key。');
    });
  });

  describe('GitHub account presentation', () => {
    it('rejects unrelated profile identities and keeps legacy records readable', 0, () => {
      const profile = normalizeGitHubProfile('1', { id: 1, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
      expect(readCachedGitHubProfile('1', JSON.stringify(profile))?.login).assertEqual('octocat');
      expect(readCachedGitHubProfile('2', JSON.stringify(profile)) === undefined).assertTrue();
      expect(readCachedGitHubProfile('1', '') === undefined).assertTrue();
      expect(readCachedGitHubProfile('1', '{broken') === undefined).assertTrue();
      expect(readCachedGitHubProfile('1', JSON.stringify({ userId: '1', token: 'legacy', username: '1' })) === undefined).assertTrue();
      expect(normalizeGitHubProfile('1', { id: 1, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com.evil.test/u/1' }).avatarUrl).assertEqual('');
    });

    it('enriches an existing numeric account without changing its authorization or target', 0, async () => {
      const loader = new TestGitHubProfileLoader();
      const harness = new AccountDeviceSwitchHarness(new TestCloudAccountClient(), new ScriptedAccountSessionManager(), false, loader);
      harness.controller.applyCloudAccountSession({ token: 't', userId: '1', masterKey: new Uint8Array(32) }, 'https://relay.example.com', '1');
      harness.remoteState.setControlTarget('account_device', 'desk-a', 'Desktop A');
      await harness.controller.refreshCloudAccountProfile();
      expect(harness.remoteState.accountUserId).assertEqual('1');
      expect(harness.remoteState.accountUsername).assertEqual('octocat');
      expect(harness.remoteState.accountAvatarUrl).assertEqual('https://avatars.githubusercontent.com/u/1');
      expect(harness.remoteState.controlTargetDeviceId).assertEqual('desk-a');
      await harness.controller.refreshCloudAccountProfile();
      expect(loader.calls).assertEqual(1);
      expect(harness.sessionStore.clears).assertEqual(0);
    });

    it('keeps cached presentation and the session when public profile refresh fails', 0, async () => {
      const loader = new TestGitHubProfileLoader();
      loader.fail = true;
      const harness = new AccountDeviceSwitchHarness(new TestCloudAccountClient(), new ScriptedAccountSessionManager(), false, loader);
      harness.controller.applyCloudAccountSession({ token: 't', userId: '1', masterKey: new Uint8Array(32) }, 'https://relay.example.com', '1');
      const cached = normalizeGitHubProfile('1', { id: 1, login: 'cached-name' });
      cached.fetchedAt = 0;
      harness.sessionStore.profile = cached;
      await harness.controller.refreshCloudAccountProfile();
      expect(harness.remoteState.accountUsername).assertEqual('cached-name');
      expect(harness.controller.hasCloudAccountSession()).assertTrue();
      expect(harness.sessionStore.clears).assertEqual(0);
    });

    it('discards a profile response after logout', 0, async () => {
      const loader = new TestGitHubProfileLoader();
      const harness = new AccountDeviceSwitchHarness(new TestCloudAccountClient(), new ScriptedAccountSessionManager(), false, loader);
      harness.controller.applyCloudAccountSession({ token: 't', userId: '1', masterKey: new Uint8Array(32) }, 'https://relay.example.com', '1');
      loader.beforeResponse = async (): Promise<void> => { await harness.controller.logoutCloudAccount(); };
      await harness.controller.refreshCloudAccountProfile();
      expect(harness.remoteState.accountUsername).assertEqual('');
      expect(harness.remoteState.accountAvatarUrl).assertEqual('');
      expect(harness.sessionStore.profile === undefined).assertTrue();
    });
  });

  describe('SettingsController', () => {

    it('keeps an offline account target resumable for the heartbeat', 0, async () => {
      const harness = new AccountDeviceSwitchHarness(new OfflineAccountClient());

      await harness.controller.restoreCloudTarget('desk-a', 'Desktop A', false);

      expect(harness.remoteState.controlTargetDeviceId).assertEqual('desk-a');
      expect(harness.remoteState.connectionState).assertEqual('reconnecting');
      expect(harness.heartbeatStarts).assertEqual(1);
    });

    it('keeps a connected device usable when target persistence fails', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.sessionStore.failSaves = true;

      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);

      expect(harness.remoteState.connectionState).assertEqual('connected');
      expect(harness.controller.preferredCloudTarget()?.deviceId).assertEqual('desk-a');
      expect(harness.heartbeatStarts).assertEqual(1);
    });

    it('does not erase the encrypted account record when restore temporarily fails', 0, async () => {
      const harness = new AccountDeviceSwitchHarness(new TestCloudAccountClient(), new ScriptedAccountSessionManager(), false);
      harness.sessionStore.failLoads = true;

      await harness.controller.initializeCloudAccount({} as Context);

      expect(harness.sessionStore.clears).assertEqual(0);
    });

    it('reports provisioning refusals without falling back to password login', 0, async () => {
      const statuses: number[] = [401, 403, 404, 409];
      for (const expectedStatus of statuses) {
        const harness = new AccountDeviceSwitchHarness(new ProvisioningFailureAccountClient(expectedStatus));
        harness.remoteState.setAccountPairing(false, '');
        let statusCode = 0;
        try {
          await harness.controller.provisionWatchCredential(
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'HarmonyOS Watch',
            '12345678-1234-4234-8234-123456789abc'
          );
        } catch (err) {
          if (err instanceof CloudAccountRequestError) statusCode = err.statusCode;
        }
        expect(statusCode).assertEqual(expectedStatus);
        expect(harness.sessionStore.clears).assertEqual(0);
      }
    });

    it('clears the published device roster when the account token expires', 0, async () => {
      const client = new ExpiringAccountClient();
      const harness = new AccountDeviceSwitchHarness(client);
      await harness.controller.listCloudAccountDevices();

      let reported = '';
      try {
        await harness.controller.listCloudAccountDevices();
      } catch (err) {
        reported = err instanceof Error ? err.message : String(err);
      }

      expect(reported).assertEqual(RemoteI18n.t('remote.settings.accountExpired'));
      expect(harness.accountDeviceSnapshots.length).assertEqual(2);
      expect(harness.accountDeviceSnapshots[0].length).assertEqual(1);
      expect(harness.accountDeviceSnapshots[1].length).assertEqual(0);
      expect(harness.controller.hasCloudAccountSession()).assertFalse();
      expect(harness.sessionStore.clears).assertEqual(0);
      expect(harness.cachedRemoteClears).assertEqual(0);
    });

    it('atomically clears account-owned conversation state on logout', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.remoteState.setControlTarget('account_device', 'desk-a', 'Desktop A');
      harness.remoteState.setConnectionState('connected');
      harness.remoteState.setActiveSession({
        sessionId: 'session-a', title: 'Previous account', workspacePath: '/repo', agentType: 'code'
      });
      harness.remoteState.setStatusText(RemoteI18n.t('status.messagesSynced'));
      harness.remoteState.setBusy(true);
      harness.remoteState.setChatInput('unsent account draft');

      await harness.controller.logoutCloudAccount();

      expect(harness.controller.hasCloudAccountSession()).assertFalse();
      expect(harness.remoteState.accountUserId).assertEqual('');
      expect(harness.remoteState.controlTargetType).assertEqual('none');
      expect(harness.remoteState.connectionState).assertEqual('disconnected');
      expect(harness.remoteState.activeSession.sessionId).assertEqual('');
      expect(harness.remoteState.statusText).assertEqual('');
      expect(harness.remoteState.isBusy).assertFalse();
      expect(harness.remoteState.chatInput).assertEqual('');
      expect(harness.timelineResets).assertEqual(1);
      expect(harness.knownRemoteStateResets).assertEqual(1);
    });

    it('clears an in-flight account switch even after its target was temporarily removed', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.remoteState.clearControlTarget();
      harness.remoteState.setConnectionState('reconnecting');
      harness.remoteState.setLoadingHome(true);
      harness.remoteState.setBusy(true);
      harness.remoteState.setStatusText(RemoteI18n.t('remote.settings.deviceConnecting'));
      harness.remoteState.setActiveSession({
        sessionId: 'stale-session', title: 'Stale', workspacePath: '/stale', agentType: 'code'
      });

      await harness.controller.logoutCloudAccount();

      expect(harness.remoteState.connectionState).assertEqual('disconnected');
      expect(harness.remoteState.isLoadingHome).assertFalse();
      expect(harness.remoteState.isBusy).assertFalse();
      expect(harness.remoteState.statusText).assertEqual('');
      expect(harness.remoteState.activeSession.sessionId).assertEqual('');
      expect(harness.timelineResets).assertEqual(1);
    });

    it('revokes a legacy room projection together with explicit account logout', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.remoteState.setControlTarget('room', 'room-device', 'Paired Desktop');
      harness.remoteState.setConnectionState('connected');
      harness.remoteState.setHostCapabilities(['remote_chat']);
      await harness.controller.logoutCloudAccount();
      expect(harness.remoteState.accountUserId).assertEqual('');
      expect(harness.remoteState.controlTargetType).assertEqual('none');
      expect(harness.remoteState.controlTargetDeviceId).assertEqual('');
      expect(harness.remoteState.connectionState).assertEqual('disconnected');
      expect(harness.remoteState.hostCapabilities.length).assertEqual(0);
      expect(harness.timelineResets).assertEqual(1);
      expect(harness.sessionManager.resets).assertEqual(1);
      expect(harness.sessionStore.clears).assertEqual(1);
    });

    it('expires legacy live authority while retaining encrypted records and caches', 0, async () => {
      const harness = new AccountDeviceSwitchHarness(new ExpiringAccountClient());
      await harness.controller.listCloudAccountDevices();
      harness.remoteState.setControlTarget('room', 'room-device', 'Paired Desktop');
      harness.remoteState.setConnectionState('connected');
      try { await harness.controller.listCloudAccountDevices(); } catch (_err) {}
      expect(harness.controller.hasCloudAccountSession()).assertFalse();
      expect(harness.remoteState.controlTargetType).assertEqual('none');
      expect(harness.remoteState.connectionState).assertEqual('disconnected');
      expect(harness.sessionManager.resets).assertEqual(1);
      expect(harness.sessionStore.clears).assertEqual(0);
      expect(harness.cachedRemoteClears).assertEqual(0);
    });

    it('migrates the same desktop from a QR room to the account transport', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.remoteState.setControlTarget('room', 'desk-a', 'Desktop A');
      harness.remoteState.setConnectionState('connected');

      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);

      expect(harness.sessionManager.dialled.join(',')).assertEqual('desk-a');
      expect(harness.remoteState.controlTargetType).assertEqual('account_device');
      expect(harness.remoteState.controlTargetDeviceId).assertEqual('desk-a');
      expect(harness.remoteState.connectionState).assertEqual('connected');
      expect(harness.sessionStore.saved.length).assertEqual(1);
      expect(harness.sessionStore.saved[0].targetDeviceId).assertEqual('desk-a');
      expect(harness.savedControlTargetTypes.join(',')).assertEqual('account_device');
    });

    it('puts the phone back on the previous desktop when a device switch fails', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      harness.sessionManager.unreachable.add('desk-b');
      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);
      const heartbeatsAfterFirst = harness.heartbeatStarts;

      let reported = '';
      try {
        await harness.controller.selectCloudAccountDevice(harness.device('desk-b'), false);
      } catch (err) {
        reported = err instanceof Error ? err.message : String(err);
      }

      // The failure is still the failure — restoring does not turn a switch
      // that did not happen into a success.
      expect(reported).assertEqual('目标桌面暂时不可用，请刷新设备列表后重试。');
      expect(harness.remoteState.controlTargetDeviceId).assertEqual('desk-a');
      expect(harness.remoteState.controlTargetType).assertEqual('account_device');
      expect(harness.remoteState.connectionState).assertEqual('connected');
      expect(harness.heartbeatStarts).assertEqual(heartbeatsAfterFirst + 1);
      expect(harness.sessionManager.dialled.join(',')).assertEqual('desk-a,desk-b,desk-a');
    });

    it('ends the outgoing workspace catalog before activating another desktop', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);
      harness.remoteState.setRecentWorkspaces([{
        path: '/desk-a-only', name: 'Desk A', lastOpened: '', workspaceKind: 'normal'
      }]);

      await harness.controller.selectCloudAccountDevice(harness.device('desk-b'), false);

      expect(harness.remoteState.recentWorkspaces.length).assertEqual(0);
      expect(harness.loadingCatalogTargets.join(',')).assertEqual('desk-a,desk-b');
      expect(harness.changedWorkspaceSnapshots.length).assertEqual(2);
      expect(harness.changedWorkspaceSnapshots[1].length).assertEqual(0);
    });

    it('gives up rather than looping when the desktop to restore is gone too', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();
      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);
      // Both machines are unreachable by the time the second tap lands.
      harness.sessionManager.unreachable.add('desk-a');
      harness.sessionManager.unreachable.add('desk-b');

      let reported = '';
      try {
        await harness.controller.selectCloudAccountDevice(harness.device('desk-b'), false);
      } catch (err) {
        reported = err instanceof Error ? err.message : String(err);
      }

      expect(reported).assertEqual('目标桌面暂时不可用，请刷新设备列表后重试。');
      expect(harness.remoteState.connectionState).assertEqual('failed');
      // One restore attempt, not a chain of them.
      expect(harness.sessionManager.dialled.join(',')).assertEqual('desk-a,desk-b,desk-a');
    });

    it('leaves the picker open when the switch was not made from one', 0, async () => {
      const harness = new AccountDeviceSwitchHarness();

      await harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);

      expect(harness.settingsClosings).assertEqual(0);
    });

    it('keeps the newest device when an older switch completes late', 0, async () => {
      const manager = new GatedAccountSessionManager();
      const harness = new AccountDeviceSwitchHarness(new TestCloudAccountClient(), manager);

      const older = harness.controller.selectCloudAccountDevice(harness.device('desk-a'), false);
      await manager.heldSwitchStarted;
      await harness.controller.selectCloudAccountDevice(harness.device('desk-b'), false);
      manager.release();
      await older;

      expect(harness.remoteState.controlTargetDeviceId).assertEqual('desk-b');
      expect(harness.remoteState.workspacePath).assertEqual('/w/desk-b');
      expect(harness.remoteState.connectionState).assertEqual('connected');
      expect(harness.sessionStore.saved.length).assertEqual(1);
      expect(harness.sessionStore.saved[0].targetDeviceId).assertEqual('desk-b');
      expect(manager.dialled.join(',')).assertEqual('desk-a,desk-b');
    });
  });

  describe('GeneralChatModelSelectionPolicy', () => {
    it('keeps an existing cloud selection when a local model is saved', 0, () => {
      const shouldActivateLocal = GeneralChatModelSelectionPolicy.shouldActivateSavedLocalModel({
        version: 4,
        models: [{
          id: 'cloud:account-model',
          name: 'Account model',
          provider: 'openai',
          base_url: 'https://chat.example.com/v1',
          model_name: 'account-model',
          enabled: true,
          capabilities: []
        }],
        default_models: { primary: 'cloud:account-model' },
        session_model_id: 'cloud:account-model'
      });

      expect(shouldActivateLocal).assertFalse();
    });

    it('activates the first saved local model when no model was previously available', 0, () => {
      const shouldActivateLocal = GeneralChatModelSelectionPolicy.shouldActivateSavedLocalModel({
        version: 1,
        models: [],
        default_models: {}
      });

      expect(shouldActivateLocal).assertTrue();
    });
  });

  describe('GeneralChatCloudConfigPolicy', () => {
    it('orders the primary model first while retaining other compatible account models', 0, () => {
      const payload = '{"config":{"ai":{"default_models":{"primary":"primary-model"},"models":[' +
        '{"id":"fallback-model","provider":"openai","model_name":"fallback","base_url":"https://fallback.example.com/v1","api_key":"fallback-key","enabled":true,"category":"general_chat"},' +
        '{"id":"primary-model","provider":"openai","model_name":"primary","base_url":"https://primary.example.com/v1/","api_key":"primary-key","enabled":true,"category":"code_specialized"}' +
        ']}}}';

      const models = GeneralChatCloudConfigPolicy.models(payload);

      expect(models.length).assertEqual(2);
      expect(models[0].modelId).assertEqual('cloud:primary-model');
      expect(models[0].apiUrl).assertEqual('https://primary.example.com/v1');
      expect(models[0].modelName).assertEqual('primary');
      expect(models[0].apiKey).assertEqual('primary-key');
      expect(models[1].modelId).assertEqual('cloud:fallback-model');
    });

    it('skips subscription models and adapts an Anthropic general-chat endpoint', 0, () => {
      const payload = '{"ai":{"default_models":{"primary":"subscription-model"},"models":[' +
        '{"id":"subscription-model","provider":"openai","model_name":"codex","base_url":"https://subscription.example.com","api_key":"unused","enabled":true,"category":"general_chat","auth":{"type":"subscription"}},' +
        '{"id":"anthropic-model","provider":"anthropic","model_name":"claude","base_url":"https://api.anthropic.com/","api_key":"anthropic-key","enabled":true,"category":"general_chat"}' +
        ']}}';

      const selected = GeneralChatCloudConfigPolicy.selectModel(payload);

      expect(selected?.modelId).assertEqual('cloud:anthropic-model');
      expect(selected?.apiUrl).assertEqual('https://api.anthropic.com/v1/messages');
    });

    it('returns no model for malformed or unusable cloud settings', 0, () => {
      const unusable = '{"ai":{"models":[{"id":"disabled","enabled":false,"base_url":"https://api.example.com","model_name":"model","api_key":"key"}]}}';
      expect(GeneralChatCloudConfigPolicy.models('{not-json').length).assertEqual(0);
      expect(GeneralChatCloudConfigPolicy.models(unusable).length).assertEqual(0);
    });
  });

  describe('ModelProviderGeneralChatAdapter', () => {
    it('infers provider protocol and request URL without a protocol setting', 0, () => {
      const openBitFunProtocol = ModelProviderGeneralChatAdapter.resolveProtocol('https://api.openbitfun.com');
      const customProtocol = ModelProviderGeneralChatAdapter.resolveProtocol('https://llm.example.com/v1');

      expect(openBitFunProtocol).assertEqual(ModelProviderProtocol.Anthropic);
      expect(customProtocol).assertEqual(ModelProviderProtocol.OpenAi);
      expect(ModelProviderGeneralChatAdapter.resolveRequestUrl(
        'https://api.openbitfun.com/',
        openBitFunProtocol
      )).assertEqual('https://api.openbitfun.com/v1/messages');
      expect(ModelProviderGeneralChatAdapter.resolveRequestUrl(
        'https://llm.example.com/v1',
        customProtocol
      )).assertEqual('https://llm.example.com/v1/chat/completions');
    });

    it('probes Anthropic-compatible endpoints with a minimal streaming request', 0, async () => {
      const transport = new FakeModelProviderHttpTransport();
      transport.responses.push(modelProviderRecordedResponse(
        200,
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'
      ));

      await ModelProviderGeneralChatAdapter.probeConfiguration(
        'https://api.openbitfun.com/',
        'sk-test-token',
        'deepseek-v4-flash',
        transport
      );

      expect(transport.requests.length).assertEqual(1);
      expect(transport.requests[0].url).assertEqual('https://api.openbitfun.com/v1/messages');
      expect(transport.requests[0].apiKey).assertEqual('sk-test-token');
      expect(transport.requests[0].protocol).assertEqual(ModelProviderProtocol.Anthropic);
      expect(transport.requests[0].body.indexOf('"max_tokens":1')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('Reply with one short word.')).assertLarger(-1);
    });

    it('rejects probe responses that never produce visible text', 0, async () => {
      const transport = new FakeModelProviderHttpTransport();
      transport.responses.push(modelProviderRecordedResponse(200, 'data: [DONE]\n\n'));

      let message = '';
      try {
        await ModelProviderGeneralChatAdapter.probeConfiguration(
          'https://api.openbitfun.com',
          'sk-test-token',
          'deepseek-v4-flash',
          transport
        );
      } catch (err) {
        message = err instanceof Error ? err.message : `${err}`;
      }

      expect(message).assertEqual('模型没有返回文字内容。');
    });

    it('extracts text from Anthropic and OpenAI compatible responses', 0, () => {
      const anthropicText = ModelProviderGeneralChatAdapter.responseText(
        '{"content":[{"type":"text","text":"你好"}]}',
        ModelProviderProtocol.Anthropic
      );
      const openAiText = ModelProviderGeneralChatAdapter.responseText(
        '{"choices":[{"message":{"content":"Hello"}}]}',
        ModelProviderProtocol.OpenAi
      );

      expect(anthropicText).assertEqual('你好');
      expect(openAiText).assertEqual('Hello');
    });

    it('places the OpenBitFun system prompt in both request formats', 0, () => {
      const messages: ModelProviderMessage[] = [{ role: 'user', content: 'OpenBitFun 是什么？' }];
      const anthropicBody = ModelProviderGeneralChatAdapter.buildRequestBody(
        'model-a',
        messages,
        ModelProviderProtocol.Anthropic
      );
      const openAiBody = ModelProviderGeneralChatAdapter.buildRequestBody(
        'model-b',
        messages,
        ModelProviderProtocol.OpenAi
      );

      expect(anthropicBody.indexOf('local AI workbench')).assertLarger(-1);
      expect(anthropicBody.indexOf('"system"')).assertLarger(-1);
      expect(openAiBody.indexOf('"role":"system"')).assertLarger(-1);
      expect(openAiBody.indexOf('blockchain')).assertLarger(-1);
    });

    it('sends attached images on the Anthropic-compatible local chat path', 0, async () => {
      const config = new InMemorySettingsConfigStore();
      config.snapshotResult = {
        apiUrl: 'https://api.openbitfun.com',
        modelName: 'vision-model',
        hasApiKey: true
      };
      config.accessTokenResult = 'sk-test-token';
      const transport = new FakeModelProviderHttpTransport();
      transport.responses.push(modelProviderRecordedResponse(
        200,
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"图里是一只猫"}}\n\n'
      ));
      const adapter = new ModelProviderGeneralChatAdapter(config, transport);
      const image = imageAttachment('cat.png', 'data:image/png;base64,aGVsbG8=');

      const result = await adapter.sendMessage('chat-1', '这是什么', [image]);

      expect(transport.requests.length).assertEqual(1);
      expect(transport.requests[0].body.indexOf('"type":"image"')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('"media_type":"image/png"')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('"data":"aGVsbG8="')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('data:image/png;base64,aGVsbG8=')).assertEqual(-1);
      expect(transport.requests[0].body.indexOf('这是什么')).assertLarger(-1);
      expect((result.userMessage.images || []).length).assertEqual(1);
      expect(result.assistantMessage.text).assertEqual('图里是一只猫');
    });

    it('sends attached images on the OpenAI-compatible local chat path', 0, async () => {
      const config = new InMemorySettingsConfigStore();
      config.snapshotResult = {
        apiUrl: 'https://llm.example.com/v1',
        modelName: 'gpt-vision',
        hasApiKey: true
      };
      config.accessTokenResult = 'sk-openai';
      const transport = new FakeModelProviderHttpTransport();
      transport.responses.push(modelProviderRecordedResponse(
        200,
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"A screenshot"}}]}\n\n'
      ));
      const adapter = new ModelProviderGeneralChatAdapter(config, transport);

      await adapter.sendMessage(
        'chat-1',
        'describe this',
        [imageAttachment('ui.jpg', 'data:image/jpeg;base64,dGVzdA==')]
      );

      expect(transport.requests[0].protocol).assertEqual(ModelProviderProtocol.OpenAi);
      expect(transport.requests[0].body.indexOf('"type":"image_url"')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('data:image/jpeg;base64,dGVzdA==')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('describe this')).assertLarger(-1);
    });

    it('replays prior local-chat images when continuing a conversation', 0, async () => {
      const config = new InMemorySettingsConfigStore();
      config.snapshotResult = {
        apiUrl: 'https://api.openbitfun.com',
        modelName: 'vision-model',
        hasApiKey: true
      };
      config.accessTokenResult = 'sk-test-token';
      const transport = new FakeModelProviderHttpTransport();
      transport.responses.push(modelProviderRecordedResponse(
        200,
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"还是同一只猫"}}\n\n'
      ));
      const adapter = new ModelProviderGeneralChatAdapter(config, transport);
      const history: ChatMessage[] = [
        chatMessageWithImage(
          'user-1',
          'user',
          '这是什么',
          'cat.png',
          'data:image/png;base64,aGVsbG8='
        ),
        chatMessage('assistant-1', 'assistant', '图里是一只猫', 'completed')
      ];

      await adapter.sendMessage('chat-1', '再看一眼颜色', [], history);

      expect(transport.requests[0].body.indexOf('"data":"aGVsbG8="')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('再看一眼颜色')).assertLarger(-1);
      expect(transport.requests[0].body.indexOf('图里是一只猫')).assertLarger(-1);
    });
  });

  describe('ModelProviderSseParser', () => {
    it('parses Anthropic deltas split across network chunks', 0, () => {
      const parser = new ModelProviderSseParser(ModelProviderProtocol.Anthropic);
      const first = parser.feed(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_'
      );
      const second = parser.feed('delta","text":"你好"}}\n\n');
      const third = parser.feed(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"！"}}\n\n'
      );

      expect(first.length).assertEqual(0);
      expect(second.join('')).assertEqual('你好');
      expect(third.join('')).assertEqual('！');
      expect(parser.responseId()).assertEqual('msg-1');
    });

    it('parses OpenAI CRLF events and ignores the done marker', 0, () => {
      const parser = new ModelProviderSseParser(ModelProviderProtocol.OpenAi);
      const deltas = parser.feed(
        'data: {"id":"chat-1","choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n' +
        'data: {"id":"chat-1","choices":[{"delta":{"content":" world"}}]}\r\n\r\n' +
        'data: [DONE]\r\n\r\n'
      );

      expect(deltas.join('')).assertEqual('Hello world');
      expect(parser.responseId()).assertEqual('chat-1');
      expect(parser.finish().length).assertEqual(0);
    });
  });

  describe('GeneralChatEventMapper', () => {
    it('projects ordered stream deltas and ignores duplicate versions', 0, () => {
      let projection = GeneralChatEventMapper.emptyProjection('chat-1', 'turn-1');
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'event-1',
        version: 1,
        session_id: 'chat-1',
        turn_id: 'turn-1',
        type: 'message.delta',
        delta: '你好'
      });
      const duplicate = GeneralChatEventMapper.apply(projection, {
        event_id: 'event-1',
        version: 1,
        session_id: 'chat-1',
        turn_id: 'turn-1',
        type: 'message.delta',
        delta: '不应重复'
      });
      projection = GeneralChatEventMapper.apply(duplicate, {
        event_id: 'event-2',
        version: 2,
        session_id: 'chat-1',
        turn_id: 'turn-1',
        type: 'turn.completed'
      });

      expect(projection.text).assertEqual('你好');
      expect(projection.status).assertEqual('completed');
      expect(projection.version).assertEqual(2);
    });

    it('rejects stream version gaps so callers can reload a snapshot', 0, () => {
      const projection = GeneralChatEventMapper.emptyProjection('chat-1', 'turn-1', 3);
      let didThrow = false;
      try {
        GeneralChatEventMapper.apply(projection, {
          event_id: 'event-5',
          version: 5,
          session_id: 'chat-1',
          turn_id: 'turn-1',
          type: 'message.delta',
          delta: '缺少版本 4'
        });
      } catch (_err) {
        didThrow = true;
      }
      expect(didThrow).assertEqual(true);
    });

    it('preserves text and tool event order while updating a stable tool item', 0, () => {
      let projection = GeneralChatEventMapper.emptyProjection('chat-1', 'turn-1');
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'text-1', version: 1, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'message.delta', delta: 'before'
      });
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'tool-event-1', version: 2, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'tool.started', tool: { id: 'tool-1', name: 'WebSearch', status: 'running' }
      });
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'tool-event-2', version: 3, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'tool.completed', tool: { id: 'tool-1', name: 'WebSearch', status: 'completed' }
      });
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'text-2', version: 4, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'message.delta', delta: 'after'
      });

      expect(projection.items.length).assertEqual(3);
      expect(projection.items[0].content).assertEqual('before');
      expect(projection.items[1].tool?.id || '').assertEqual('tool-1');
      expect(projection.items[1].tool?.status || '').assertEqual('completed');
      expect(projection.items[2].content).assertEqual('after');
      expect(projection.tools.length).assertEqual(1);
    });

    it('keeps Task input metadata when a completion event only carries the result', 0, () => {
      let projection = GeneralChatEventMapper.emptyProjection('chat-1', 'turn-1');
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'task-started', version: 1, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'tool.started',
        tool: {
          id: 'task-1', name: 'Task', status: 'running',
          input_preview: '{"description":"Inspect the workspace"}'
        }
      });
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'task-completed', version: 2, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'tool.completed',
        tool: { id: 'task-1', name: 'Task', status: 'completed', result_preview: 'Done' }
      });

      expect(projection.tools[0].input_preview || '')
        .assertEqual('{"description":"Inspect the workspace"}');
      expect(projection.items[0].tool?.input_preview || '')
        .assertEqual('{"description":"Inspect the workspace"}');
      expect(projection.items[0].tool?.result_preview || '').assertEqual('Done');
    });

    it('projects permission and capability states and ignores late terminal events', 0, () => {
      let projection = GeneralChatEventMapper.emptyProjection('chat-1', 'turn-1');
      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'permission-1', version: 1, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'permission.required',
        tool: { id: 'tool-1', name: 'Write', status: 'waiting' }
      });
      expect(projection.status).assertEqual('pending_confirmation');
      expect(projection.tools[0].status || '').assertEqual('pending_confirmation');

      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'capability-1', version: 2, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'capability.required', capability: 'remote_workspace'
      });
      expect(projection.status).assertEqual('capability_required');
      expect(projection.capabilityRequired).assertEqual('remote_workspace');

      projection = GeneralChatEventMapper.apply(projection, {
        event_id: 'cancel-1', version: 3, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'turn.cancelled'
      });
      const terminal = GeneralChatEventMapper.apply(projection, {
        event_id: 'late-1', version: 4, session_id: 'chat-1', turn_id: 'turn-1',
        type: 'message.delta', delta: 'late'
      });
      expect(terminal.status).assertEqual('cancelled');
      expect(terminal.version).assertEqual(3);
      expect(terminal.text).assertEqual('');
    });
  });

  describe('RemoteCommandFactory', () => {
    it('builds workspace and assistant commands', 0, () => {
      expectCommandJson(RemoteCommandFactory.getWorkspaceInfo(), '{"cmd":"get_workspace_info"}');
      expectCommandJson(RemoteCommandFactory.listRecentWorkspaces(), '{"cmd":"list_recent_workspaces"}');
      expectCommandJson(RemoteCommandFactory.setWorkspace('/repo'), '{"cmd":"set_workspace","path":"/repo"}');
      expectCommandJson(RemoteCommandFactory.listAssistants(), '{"cmd":"list_assistants"}');
      expectCommandJson(RemoteCommandFactory.setAssistant('/assistant'), '{"cmd":"set_assistant","path":"/assistant"}');
    });

    it('builds session list and creation commands without unsupported fields', 0, () => {
      const listCommand = RemoteCommandFactory.listSessions('/repo', 8, 16, '  auth  ');
      expectCommandJson(listCommand, '{"cmd":"list_sessions","workspace_path":"/repo","limit":8,"offset":16,"query":"auth"}');
      expect(JSON.stringify(listCommand).indexOf('agent_type')).assertEqual(-1);

      const createCommand = RemoteCommandFactory.createSession({
        agentType: 'cowork',
        title: '',
        instruction: 'hello'
      }, '/repo');
      expectCommandJson(createCommand, '{"cmd":"create_session","agent_type":"cowork","session_name":"Remote Cowork Session","workspace_path":"/repo","remote_connection_id":""}');
      expect(JSON.stringify(createCommand).indexOf('run_mode')).assertEqual(-1);

      const minimal = RemoteCommandFactory.createSession({
        agentType: 'minimal', title: '', instruction: 'lean'
      }, '/repo');
      const ultimate = RemoteCommandFactory.createSession({
        agentType: 'Ultra', title: '', instruction: 'deep'
      }, '/repo');
      expect(minimal.agent_type || '').assertEqual('minimal');
      expect(ultimate.agent_type || '').assertEqual('Ultra');
    });

    it('builds message and polling commands', 0, () => {
      expectCommandJson(RemoteCommandFactory.sendMessage('s1', 'hello', 'code'), '{"cmd":"send_message","session_id":"s1","content":"hello","agent_type":"code"}');
      expectCommandJson(
        RemoteCommandFactory.sendMessage('s1', 'hello', 'code', undefined, 'harmony-turn-1'),
        '{"cmd":"send_message","session_id":"s1","content":"hello","agent_type":"code","turn_id":"harmony-turn-1"}'
      );
      expectCommandJson(RemoteCommandFactory.sendMessage('s1', 'look', 'code', [{
        id: 'img1',
        data_url: 'data:image/png;base64,abc',
        mime_type: 'image/png'
      }]), '{"cmd":"send_message","session_id":"s1","content":"look","agent_type":"code","image_contexts":[{"id":"img1","data_url":"data:image/png;base64,abc","mime_type":"image/png"}]}');
      expectCommandJson(RemoteCommandFactory.steerTurn('s1', 'turn-1', 'continue', 'continue', [{
        id: 'img1',
        data_url: 'data:image/png;base64,abc',
        mime_type: 'image/png'
      }]), '{"cmd":"steer_turn","session_id":"s1","turn_id":"turn-1","content":"continue","display_content":"continue","image_contexts":[{"id":"img1","data_url":"data:image/png;base64,abc","mime_type":"image/png"}]}');
      expectCommandJson(
        RemoteCommandFactory.buildPlan('s1', '/repo/.openbitfun/plans/mobile.plan.md', 'Mobile plan', 'code'),
        '{"cmd":"build_plan","session_id":"s1","plan_file_path":"/repo/.openbitfun/plans/mobile.plan.md","plan_name":"Mobile plan","agent_type":"code"}'
      );
      expectCommandJson(RemoteCommandFactory.getSessionMessages('s1'), '{"cmd":"get_session_messages","session_id":"s1"}');
      expectCommandJson(RemoteCommandFactory.pollSession('s1', 7, 3, 2), '{"cmd":"poll_session","session_id":"s1","since_version":7,"known_msg_count":3,"known_model_catalog_version":2}');
    });

    it('builds model and session lifecycle commands', 0, () => {
      expectCommandJson(RemoteCommandFactory.getModelCatalog('s1'), '{"cmd":"get_model_catalog","session_id":"s1"}');
      expectCommandJson(RemoteCommandFactory.setSessionModel('s1', 'model-a'), '{"cmd":"set_session_model","session_id":"s1","model_id":"model-a"}');
      expectCommandJson(RemoteCommandFactory.cancelTask('s1'), '{"cmd":"cancel_task","session_id":"s1"}');
      expectCommandJson(RemoteCommandFactory.cancelTask('s1', 'turn-9'), '{"cmd":"cancel_task","session_id":"s1","turn_id":"turn-9"}');
      expectCommandJson(RemoteCommandFactory.renameSession('s1', 'Next'), '{"cmd":"update_session_title","session_id":"s1","title":"Next"}');
      expectCommandJson(RemoteCommandFactory.deleteSession('s1'), '{"cmd":"delete_session","session_id":"s1"}');
      expectCommandJson(RemoteCommandFactory.ping(), '{"cmd":"ping"}');
    });

    it('builds tool and file commands', 0, () => {
      const answers: RemoteQuestionAnswerPayload = { answer: 'yes', '0': 'yes' };
      const multipleAnswers: RemoteQuestionAnswerPayload = { '0': 'yes', '1': ['tests', 'docs'] };

      expectCommandJson(RemoteCommandFactory.confirmTool('tool-1'), '{"cmd":"confirm_tool","tool_id":"tool-1"}');
      expectCommandJson(RemoteCommandFactory.rejectTool('tool-1', 'no'), '{"cmd":"reject_tool","tool_id":"tool-1","reason":"no"}');
      expectCommandJson(RemoteCommandFactory.cancelTool('tool-1', 'stop'), '{"cmd":"cancel_tool","tool_id":"tool-1","reason":"stop"}');
      expectCommandJson(RemoteCommandFactory.answerQuestion('tool-2', answers), '{"cmd":"answer_question","tool_id":"tool-2","answers":{"0":"yes","answer":"yes"}}');
      expectCommandJson(RemoteCommandFactory.answerQuestion('tool-3', multipleAnswers), '{"cmd":"answer_question","tool_id":"tool-3","answers":{"0":"yes","1":["tests","docs"]}}');
      expectCommandJson(RemoteCommandFactory.getFileInfo('/tmp/a.txt', 's1'), '{"cmd":"get_file_info","path":"/tmp/a.txt","session_id":"s1"}');
      expectCommandJson(RemoteCommandFactory.readFileChunk('/tmp/a.txt', 12, 64, 's1'), '{"cmd":"read_file_chunk","path":"/tmp/a.txt","offset":12,"limit":64,"session_id":"s1"}');
    });

    it('preserves indexed question answers when dispatching from the UI', 0, () => {
      const answers = toRemoteQuestionAnswer({ '0': 'tests', '1': ['docs', 'src'] });

      expectCommandJson(
        RemoteCommandFactory.answerQuestion('tool-4', answers),
        '{"cmd":"answer_question","tool_id":"tool-4","answers":{"0":"tests","1":["docs","src"]}}'
      );
    });
  });

  describe('RemoteResponseMapper', () => {
    it('maps session response items', 0, () => {
      const sessions = RemoteResponseMapper.sessions([{
        session_id: 'session-abcdef',
        name: 'Fallback title',
        agent_type: 'agentic',
        status: 'running',
        updated_at: '2026-06-10T12:00:00.000Z',
        created_at: '2026-06-09T12:00:00.000Z',
        message_count: 4,
        workspace_path: '/repo',
        workspace_name: 'Repo'
      }]);
      expect(sessions.length).assertEqual(1);
      expect(sessions[0].id).assertEqual('session-abcdef');
      expect(sessions[0].title).assertEqual('Fallback title');
      expect(sessions[0].agentType).assertEqual('agentic');
      expect(sessions[0].messageCount).assertEqual(4);
      expect(sessions[0].workspaceName).assertEqual('Repo');
    });

    it('hides ACP sessions while preserving raw pages for pagination', 0, () => {
      const items: SessionItemResponse[] = [{
        session_id: 'native-session',
        name: 'Native',
        agent_type: 'agentic'
      }, {
        session_id: 'acp-session',
        name: 'ACP',
        agent_type: 'acp:codex'
      }, {
        session_id: 'future-acp-session',
        name: 'Future ACP',
        agent_type: ' ACP:gemini '
      }];

      const visible = RemoteResponseMapper.sessions(items);
      const raw = RemoteResponseMapper.allSessions(items);

      expect(visible.length).assertEqual(1);
      expect(visible[0].id).assertEqual('native-session');
      expect(raw.length).assertEqual(3);
    });

    it('hides child sessions so Desktop side questions are not standalone rows', 0, () => {
      const items: SessionItemResponse[] = [{
        session_id: 'parent-session',
        name: 'iOS sidebar spacing'
      }, {
        session_id: 'btw-session',
        name: 'why did it grep with bash',
        parent_session_id: 'parent-session',
        relationship_kind: 'btw'
      }];

      const visible = RemoteResponseMapper.sessions(items);
      const raw = RemoteResponseMapper.allSessions(items);

      expect(visible.length).assertEqual(1);
      expect(visible[0].id).assertEqual('parent-session');
      expect(raw.length).assertEqual(2);
      expect(raw[1].parentSessionId).assertEqual('parent-session');
      expect(raw[1].relationshipKind).assertEqual('btw');
    });

    it('maps alternate session time fields', 0, () => {
      const sessions = RemoteResponseMapper.sessions([{
        session_id: 'session-time',
        title: 'Alternate time fields',
        last_message_at: 1781092800000,
        createdAt: '2026-06-09 12:00:00',
        message_count: 1
      }]);
      expect(sessions.length).assertEqual(1);
      expect(sessions[0].updatedAt).assertEqual('1781092800000');
      expect(sessions[0].createdAt).assertEqual('2026-06-09 12:00:00');
    });

    it('maps assistant messages and nested tools', 0, () => {
      const message = RemoteResponseMapper.chatMessage({
        id: 'm1',
        role: 'assistant',
        content: '',
        thinking: 'Thinking out loud',
        timestamp: '2026-06-10T12:00:00.000Z',
        items: [{
          type: 'tool',
          tool: {
            id: 'tool-1',
            name: 'shell',
            status: 'pending'
          },
          subItems: [{
            type: 'tool',
            tool: {
              id: 'tool-2',
              name: 'edit',
              status: 'done'
            }
          }]
        }]
      });
      expect(message.id).assertEqual('m1');
      expect(message.text).assertEqual('');
      expect(message.thinking || '').assertEqual('Thinking out loud');
      expect(message.status).assertEqual('done');
      expect(message.detail).assertEqual('shell · pending\nedit · done');
      expect(message.tools ? message.tools.length : 0).assertEqual(2);
    });

    it('maps persisted remote turn failures', 0, () => {
      const message = RemoteResponseMapper.chatMessage({
        id: 'turn-failed-1_assistant',
        turn_id: 'turn-failed-1',
        role: 'assistant',
        content: '',
        status: 'failed',
        error: 'AI client could not reach the configured proxy'
      });

      expect(message.turnId || '').assertEqual('turn-failed-1');
      expect(message.status).assertEqual('failed');
      expect(message.error || '').assertEqual('AI client could not reach the configured proxy');
    });

    it('maps live remote turn failures before history persistence', 0, () => {
      const message = RemoteResponseMapper.activeTurnToMessage({
        turn_id: 'turn-failed-live',
        status: 'failed',
        error: 'AI client could not reach the configured proxy'
      });

      expect(message.status).assertEqual('failed');
      expect(message.error || '').assertEqual('AI client could not reach the configured proxy');
    });

    it('uses fallback ids for message rendering keys', 0, () => {
      const fromMessageId = RemoteResponseMapper.chatMessage({
        message_id: 'desktop-message-1',
        role: 'assistant',
        content: 'Mapped from alternate id',
        timestamp: '2026-06-10T12:00:00.000Z'
      });
      const generated = RemoteResponseMapper.chatMessage({
        role: 'user',
        content: 'No id in response',
        timestamp: '2026-06-10T12:01:00.000Z'
      });

      expect(fromMessageId.id).assertEqual('desktop-message-1');
      expect(generated.id.length > 0).assertTrue();
      expect(generated.id.indexOf('user-2026-06-10T12:01:00.000Z-')).assertEqual(0);
    });

    it('maps active turns with item fallback text and tool detail', 0, () => {
      const message = RemoteResponseMapper.activeTurnToMessage({
        turn_id: 'turn-1',
        status: 'active',
        items: [{
          type: 'text',
          content: 'Working on it'
        }],
        tools: [{
          id: 'tool-3',
          name: 'read_file',
          status: 'running'
        }]
      });
      expect(message.id).assertEqual('active-turn-1');
      expect(message.turnId || '').assertEqual('turn-1');
      expect(message.role).assertEqual('assistant');
      expect(message.text).assertEqual('Working on it');
      expect(message.status).assertEqual('active');
      expect(message.detail).assertEqual('read_file · running');
    });

    it('does not promote subagent progress to active turn text', 0, () => {
      const message = RemoteResponseMapper.activeTurnToMessage({
        turn_id: 'turn-structured',
        status: 'active',
        items: [{
          type: 'subagent',
          is_subagent: true,
          content: 'Subagent check',
          subItems: [{
            type: 'text',
            content: 'Nested progress'
          }, {
            type: 'tool',
            tool: {
              id: 'tool-nested-1',
              name: 'inspect',
              status: 'running'
            }
          }]
        }]
      });

      expect(message.text).assertEqual('');
      expect(message.tools ? message.tools.length : 0).assertEqual(1);
      expect(message.detail).assertEqual('inspect · running');
    });

    it('does not use thinking as active turn final text', 0, () => {
      const message = RemoteResponseMapper.activeTurnToMessage({
        turn_id: 'turn-thinking-only',
        status: 'completed',
        thinking: 'Still reasoning',
        items: [{
          type: 'thinking',
          content: 'Still reasoning'
        }]
      });

      expect(message.text).assertEqual('');
      expect(message.thinking || '').assertEqual('Still reasoning');
      expect(message.status).assertEqual('completed');
    });
  });
}
