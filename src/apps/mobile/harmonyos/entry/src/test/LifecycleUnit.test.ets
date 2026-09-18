import { FakeHostSessionManager, hostRecord } from './LocalTestFixtures';
import { describe, it, expect } from '@ohos/hypium';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { RemoteControlSettingsPagePolicy } from '../main/ets/pages/policy/RemoteControlSettingsPagePolicy';
import { ChatSessionController, ChatSessionSnapshot } from '../main/ets/services/ChatSessionController';
import { ChatComposerPolicy } from '../main/ets/services/ChatComposerPolicy';
import { ChatTimelineItem, ChatTimelineProjector } from '../main/ets/services/ChatTimelineProjector';
import { ChatTimelineStore } from '../main/ets/services/ChatTimelineStore';
import { ConversationEvent } from '../main/ets/services/ConversationEvent';
import { AsyncLifecycleGate } from '../main/ets/services/AsyncLifecycleGate';
import { DeferredLoadingGate } from '../main/ets/services/DeferredLoadingGate';
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
  GeneralChatConfigValidator
} from '../main/ets/services/general-chat/GeneralChatConfigStore';
import { GeneralChatDraftController, GeneralChatDraftScheduler } from '../main/ets/services/general-chat/GeneralChatDraftController';
import { GeneralChatDraftLifecycleController } from '../main/ets/services/general-chat/GeneralChatDraftLifecycleController';
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
  ModelProviderProtocol
} from '../main/ets/services/general-chat/ModelProviderGeneralChatAdapter';
import { ModelProviderSseParser } from '../main/ets/services/general-chat/ModelProviderSseParser';
import { MockGeneralChatAdapter } from '../main/ets/services/general-chat/MockGeneralChatAdapter';
import { MarkdownParser } from '../main/ets/services/MarkdownParser';
import { RemoteCommandFactory } from '../main/ets/services/RemoteCommandFactory';
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
import {
  TaskCompletionNotificationController,
  TaskCompletionNotificationPort,
  TaskCompletionObservation
} from '../main/ets/services/TaskCompletionNotificationController';
import { X25519 } from '../main/ets/services/X25519';
import {
  ChatMessage,
  FileInfo,
  ImageAttachment,
  PollSessionResult,
  RecentWorkspaceEntry,
  AssistantEntry,
  CreateSessionOptions,
  RemoteImageContext,
  RemoteQuestionAnswerPayload,
  RemoteModelCatalog,
  ReadFileResult,
  RemoteSession,
  SelectedImageAttachment,
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

class FakeTaskCompletionNotificationPort implements TaskCompletionNotificationPort {
  prepareCount: number = 0;
  keepAliveCount: number = 0;
  releaseCount: number = 0;
  canKeepAlive: boolean = true;
  published: TaskCompletionObservation[] = [];
  expiration?: () => void;

  async prepare(): Promise<void> {
    this.prepareCount += 1;
  }

  keepAlive(onExpired: () => void): boolean {
    this.keepAliveCount += 1;
    this.expiration = onExpired;
    return this.canKeepAlive;
  }

  releaseKeepAlive(): void {
    this.releaseCount += 1;
  }

  async publish(observation: TaskCompletionObservation): Promise<void> {
    this.published.push(observation);
  }

  expire(): void {
    if (this.expiration) {
      this.expiration();
    }
  }
}

export default function lifecycleUnitTest() {
  describe('TaskCompletionNotificationController', () => {
    it('does not request permission when tracking a task', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const controller = new TaskCompletionNotificationController(port);
      controller.track({ source: 'remote', sessionId: 'session-1', turnId: 'turn-1' });
      expect(port.prepareCount).assertEqual(0);
    });

    it('publishes once only after the exact background task finishes', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const controller = new TaskCompletionNotificationController(port);

      controller.track({ source: 'remote', sessionId: 'session-1', turnId: 'turn-1' });
      expect(controller.onBackground()).assertTrue();
      expect(controller.complete('remote', 'session-1', 'turn-other')).assertFalse();
      expect(controller.complete('remote', 'session-1', 'turn-1')).assertTrue();
      expect(controller.complete('remote', 'session-1', 'turn-1')).assertFalse();

      expect(port.keepAliveCount).assertEqual(1);
      expect(port.releaseCount).assertEqual(1);
      expect(port.published.length).assertEqual(1);
      expect(port.published[0].turnId).assertEqual('turn-1');
    });

    it('clears a foreground completion without publishing later', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const controller = new TaskCompletionNotificationController(port);
      controller.track({ source: 'general', sessionId: 'session-1', turnId: 'turn-1' });

      expect(controller.complete('general', 'session-1', 'turn-1')).assertFalse();

      expect(controller.onBackground()).assertFalse();
      expect(port.published.length).assertEqual(0);
    });

    it('clears a failed background task without publishing', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const controller = new TaskCompletionNotificationController(port);
      controller.track({ source: 'remote', sessionId: 'session-1', turnId: 'turn-1' });
      expect(controller.onBackground()).assertTrue();

      expect(controller.cancel('remote', 'session-1', 'turn-1')).assertTrue();

      expect(controller.isWatchingInBackground()).assertFalse();
      expect(port.published.length).assertEqual(0);
    });

    it('does not arm an observation without an exact turn id', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const controller = new TaskCompletionNotificationController(port);

      controller.track({ source: 'general', sessionId: 'session-1', turnId: '' });

      expect(controller.onBackground()).assertFalse();
      expect(port.keepAliveCount).assertEqual(0);
    });

    it('stops observation when HarmonyOS cannot grant background time', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      port.canKeepAlive = false;
      const expired: TaskCompletionObservation[] = [];
      const controller = new TaskCompletionNotificationController(
        port,
        (observation: TaskCompletionObservation): void => {
          expired.push(observation);
        }
      );

      controller.track({ source: 'remote', sessionId: 'session-1', turnId: 'turn-1' });

      expect(controller.onBackground()).assertFalse();
      expect(controller.isWatchingInBackground()).assertFalse();
      expect(expired.length).assertEqual(1);
    });

    it('expires a running background observation without publishing', 0, () => {
      const port = new FakeTaskCompletionNotificationPort();
      const expired: TaskCompletionObservation[] = [];
      const controller = new TaskCompletionNotificationController(
        port,
        (observation: TaskCompletionObservation): void => {
          expired.push(observation);
        }
      );
      controller.track({ source: 'general', sessionId: 'session-2', turnId: 'turn-2' });
      expect(controller.onBackground()).assertTrue();

      port.expire();

      expect(controller.isWatchingInBackground()).assertFalse();
      expect(expired.length).assertEqual(1);
      expect(port.published.length).assertEqual(0);
    });
  });

  describe('RemoteControlSettingsPagePolicy', () => {
    it('opens account mode directly on the signed-out login page', 0, () => {
      expect(RemoteControlSettingsPagePolicy.resolve(true, false, false, false)).assertEqual('login');
      expect(RemoteControlSettingsPagePolicy.resolve(true, false, false, true)).assertEqual('profile');
    });

    it('does not expose the remote page while account navigation is active', 0, () => {
      expect(RemoteControlSettingsPagePolicy.resolve(false, true, false, false)).assertEqual('login');
      expect(RemoteControlSettingsPagePolicy.resolve(false, false, true, false)).assertEqual('login');
      expect(RemoteControlSettingsPagePolicy.resolve(false, false, false, false)).assertEqual('remote');
    });
  });

  describe('AppShellState', () => {
    it('owns global sidebar and sheet visibility', 0, () => {
      const state = new AppShellState();

      state.setSidebarVisible(true);
      state.setSettingsVisible(true);
      state.setConnectSheetVisible(true);

      expect(state.showSidebar).assertTrue();
      expect(state.showSettings).assertTrue();
      expect(state.showConnectSheet).assertTrue();

      state.openSettings('account');
      expect(state.showSettings).assertTrue();
      expect(state.settingsMode).assertEqual('account');
      state.leaveSettings();
      expect(state.showSettings).assertTrue();
      expect(state.settingsMode).assertEqual('general');

      state.closeGlobalSurfaces();
      expect(state.showSidebar).assertFalse();
      expect(state.showSettings).assertFalse();
      expect(state.showConnectSheet).assertFalse();
    });

    it('keeps settings page and editor drafts until the sheet is closed', 0, () => {
      const state = new AppShellState();
      state.settingsSheet.hydrateEditorDraft('https://api.example.com', 'chat-model');
      state.settingsSheet.syncSaved('https://api.example.com', 'chat-model', true);
      state.settingsSheet.setPage('local');
      expect(state.settingsSheet.draftApiUrl).assertEqual('https://api.example.com');
      expect(state.settingsSheet.savedGeneralChatHasApiKey).assertTrue();
      state.settingsSheet.hydrateEditorDraft('https://other.example', 'other');
      expect(state.settingsSheet.draftApiUrl).assertEqual('https://api.example.com');
      state.setSettingsVisible(true);
      expect(state.settingsSheet.page).assertEqual('local');
      state.setSettingsVisible(false);
      expect(state.settingsSheet.page).assertEqual('main');
      expect(state.settingsSheet.draftApiUrl).assertEqual('');
      expect(state.settingsSheet.editorDraftHydrated).assertFalse();
      state.settingsSheet.setPage('overview');
      state.openSettings('general');
      expect(state.settingsSheet.page).assertEqual('main');
      state.settingsSheet.setPage('overview');
      state.openSettings('general');
      expect(state.settingsSheet.page).assertEqual('overview');
      state.closeGlobalSurfaces();
      expect(state.settingsSheet.page).assertEqual('main');
    });

    it('mirrors the resolved layout mode for runtime branching', 0, () => {
      const state = new AppShellState();

      expect(state.wideLayout).assertFalse();
      state.setWideLayout(true);
      expect(state.wideLayout).assertTrue();

      state.setSidebarVisible(true);
      state.closeGlobalSurfaces();
      expect(state.wideLayout).assertTrue();
    });
  });

  describe('AsyncLifecycleGate', () => {
    it('invalidates earlier asynchronous generations', 0, () => {
      const gate = new AsyncLifecycleGate();
      const first = gate.begin();
      expect(gate.isCurrent(first)).assertTrue();

      const second = gate.begin();
      expect(gate.isCurrent(first)).assertFalse();
      expect(gate.isCurrent(second)).assertTrue();

      gate.invalidate();
      expect(gate.isCurrent(second)).assertFalse();
    });
  });

  const settleAfter = (delayMs: number): Promise<void> =>
    new Promise<void>((resolve: () => void) => setTimeout(resolve, delayMs));

  describe('DeferredLoadingGate', () => {
    it('announces a wait the content has not ended and caps one nothing ever ends', 0, async () => {
      const seen: boolean[] = [];
      const gate = new DeferredLoadingGate(10, (visible: boolean): void => { seen.push(visible); }, 60);

      // A wait the content ends: the command that started it returning is not
      // what closes the gate, so the skeleton stands until `settle` says the
      // transcript arrived.
      gate.arm();
      await settleAfter(30);
      expect(seen.length).assertEqual(1);
      expect(seen[0]).assertTrue();
      gate.settle();
      expect(seen.length).assertEqual(2);
      expect(seen[1]).assertFalse();

      // A wait nothing ends: the cap takes the skeleton down rather than
      // leaving a placeholder standing over content that never came.
      gate.arm();
      await settleAfter(30);
      expect(seen.length).assertEqual(3);
      expect(seen[2]).assertTrue();
      await settleAfter(90);
      expect(seen.length).assertEqual(4);
      expect(seen[3]).assertFalse();

      // A superseded wait never announces itself, so a second tap during the
      // first open cannot be described by the first one's timers.
      gate.arm();
      gate.arm();
      gate.settle();
      await settleAfter(40);
      expect(seen.length).assertEqual(5);
      expect(seen[4]).assertFalse();
    });
  });

  describe('RemoteHeartbeatController', () => {
    it('owns heartbeat timer restart, stop, and tick dispatch', 0, () => {
      const scheduler = new FakeRemoteHeartbeatScheduler();
      let tickCount = 0;
      const controller = new RemoteHeartbeatController(async () => {
        tickCount += 1;
      }, 15000, scheduler);

      controller.start();
      expect(controller.isRunning()).assertTrue();
      expect(scheduler.intervals.get(1)).assertEqual(15000);
      scheduler.tick(1);
      expect(tickCount).assertEqual(1);

      controller.start();
      expect(scheduler.clearedIds.length).assertEqual(1);
      expect(scheduler.clearedIds[0]).assertEqual(1);
      expect(scheduler.callbacks.has(1)).assertFalse();
      expect(scheduler.callbacks.has(2)).assertTrue();

      controller.stop();
      controller.stop();
      expect(controller.isRunning()).assertFalse();
      expect(scheduler.clearedIds.length).assertEqual(2);
      expect(scheduler.clearedIds[1]).assertEqual(2);
    });

    it('drops ticks that arrive while the previous one is unanswered', 0, async () => {
      const scheduler = new FakeRemoteHeartbeatScheduler();
      let started = 0;
      let answer: () => void = () => {};
      const controller = new RemoteHeartbeatController((): Promise<void> => {
        started += 1;
        return new Promise<void>((resolve: () => void) => {
          answer = resolve;
        });
      }, 15000, scheduler);

      controller.start();
      scheduler.tick(1);
      scheduler.tick(1);
      scheduler.tick(1);
      // Three intervals have elapsed against a desktop that answered none of
      // them, and exactly one request is out.
      expect(started).assertEqual(1);

      answer();
      await Promise.resolve();
      await Promise.resolve();
      scheduler.tick(1);
      expect(started).assertEqual(2);
    });
  });

  describe('RemoteActivityLifecycleController', () => {
    it('owns remote heartbeat lifecycle while preserving tick dispatch', 0, () => {
      const scheduler = new FakeRemoteHeartbeatScheduler();
      let tickCount = 0;
      const controller = new RemoteActivityLifecycleController(async () => {
        tickCount += 1;
      }, 15000, scheduler);

      controller.startHeartbeat();
      expect(controller.isHeartbeatRunning()).assertTrue();
      expect(scheduler.intervals.get(1)).assertEqual(15000);
      scheduler.tick(1);
      expect(tickCount).assertEqual(1);

      controller.startHeartbeat();
      expect(scheduler.clearedIds[0]).assertEqual(1);
      expect(scheduler.callbacks.has(1)).assertFalse();
      expect(scheduler.callbacks.has(2)).assertTrue();

      controller.stopHeartbeat();
      controller.stopHeartbeat();
      expect(controller.isHeartbeatRunning()).assertFalse();
      expect(scheduler.clearedIds.length).assertEqual(2);
      expect(scheduler.clearedIds[1]).assertEqual(2);
    });
  });

  describe('RemoteChatPollingLifecycleController', () => {
    it('starts the active durable session subscription and forwards records', 0, async () => {
      const manager = new FakeHostSessionManager();
      const snapshots: ChatSessionSnapshot[] = [];
      const controller = new RemoteChatPollingLifecycleController(manager, {
        onSnapshot: (snapshot: ChatSessionSnapshot) => { snapshots.push(snapshot); },
        onError: (_error: Object) => {}, canPoll: () => true
      });
      controller.startActiveSession({ sessionId: 'session-1', cursor: { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 } });
      await manager.emit(hostRecord('session-1', 1, 'Done', 'completed'));
      controller.stop();
      expect(snapshots.length).assertEqual(1);
      expect(snapshots[0].messageSnapshot?.[1].text).assertEqual('Done');
    });

    it('ignores empty active session starts', 0, async () => {
      const manager = new FakePollSessionManager();
      const snapshots: ChatSessionSnapshot[] = [];
      manager.results = [pollResult({
        version: 1,
        changed: false,
        sessionState: 'idle',
        title: 'Ignored',
        newMessages: [],
        totalMessageCount: 0
      })];
      const controller = new RemoteChatPollingLifecycleController(manager, {
        onSnapshot: (snapshot: ChatSessionSnapshot) => {
          snapshots.push(snapshot);
        },
        onError: (_error: Object) => {},
        canPoll: (_sessionId: string) => true
      });

      controller.startActiveSession({
        sessionId: '',
        cursor: {
          pollVersion: 0,
          knownMessageCount: 0,
          knownModelCatalogVersion: 0
        }
      });
      await delay(20);

      expect(snapshots.length).assertEqual(0);
      expect(manager.results.length).assertEqual(1);
    });
  });

  describe('VoiceInputLifecycleController', () => {
    it('owns start stop guard and callback routing for visible voice input', 0, async () => {
      const service = new FakeVoiceInputLifecycleService();
      let inputText = '';
      let statusText = '';
      let clearAllCount = 0;
      const inputEvents: string[] = [];
      const listeningEvents: string[] = [];
      const statuses: string[] = [];
      const errors: string[] = [];
      const callbacks: VoiceInputLifecycleCallbacks = {
        currentInputText: (): string => inputText,
        currentStatusText: (): string => statusText,
        onInputText: (routeId: string, text: string): void => {
          inputText = text;
          inputEvents.push(`${routeId}:${text}`);
        },
        onListening: (routeId: string, isListening: boolean): void => {
          listeningEvents.push(`${routeId}:${isListening ? '1' : '0'}`);
        },
        onStatusText: (nextStatusText: string): void => {
          statusText = nextStatusText;
          statuses.push(nextStatusText);
        },
        onError: (message: string): void => {
          statusText = message;
          errors.push(message);
        }
      };
      const controller = new VoiceInputLifecycleController(service, callbacks);
      const snapshot: VoiceInputRouteSnapshot = {
        routeId: 'GeneralChat',
        isListening: false,
        isBusy: false,
        inputText: '',
        selectedImageCount: 0
      };

      expect(await controller.toggle({} as Context, snapshot)).assertTrue();
      service.emitText('recognized text', true);
      expect(service.startRequests).assertEqual(1);
      expect(inputEvents[0]).assertEqual('GeneralChat:recognized text');
      expect(listeningEvents[0]).assertEqual('GeneralChat:1');
      expect(statuses.indexOf(RemoteI18n.t('status.voiceStarting')) >= 0).assertTrue();
      expect(statuses.indexOf(RemoteI18n.t('status.voiceListening')) >= 0).assertTrue();
      expect(statuses.indexOf(RemoteI18n.t('status.voiceRecognized')) >= 0).assertTrue();

      expect(await controller.stop({
        routeId: 'GeneralChat',
        isListening: true,
        isBusy: false,
        inputText,
        selectedImageCount: 0
      }, true)).assertTrue();
      expect(service.stopRequests).assertEqual(1);
      expect(listeningEvents[listeningEvents.length - 1]).assertEqual('GeneralChat:0');

      expect(await controller.toggle({} as Context, {
        routeId: 'GeneralChat',
        isListening: false,
        isBusy: true,
        inputText: '',
        selectedImageCount: 0
      })).assertFalse();
      expect(service.startRequests).assertEqual(1);

      service.shouldFailStart = true;
      inputText = '';
      expect(await controller.toggle({} as Context, snapshot)).assertFalse();
      expect(errors[0]).assertEqual('Expected voice start failure.');

      await controller.cancel('GeneralChat', () => {
        clearAllCount += 1;
      });
      expect(service.cancelRequests).assertEqual(1);
      expect(clearAllCount).assertEqual(1);
    });

    it('continues an existing draft by voice without duplicating partial results', 0, async () => {
      const service = new FakeVoiceInputLifecycleService();
      let inputText = 'Review this';
      const inputEvents: string[] = [];
      const controller = new VoiceInputLifecycleController(service, {
        currentInputText: (): string => inputText,
        currentStatusText: (): string => '',
        onInputText: (_routeId: string, text: string): void => {
          inputText = text;
          inputEvents.push(text);
        },
        onListening: (_routeId: string, _isListening: boolean): void => {},
        onStatusText: (_statusText: string): void => {},
        onError: (_message: string): void => {}
      });

      expect(await controller.toggle({} as Context, {
        routeId: 'GeneralChat',
        isListening: false,
        isBusy: false,
        inputText,
        selectedImageCount: 1
      })).assertTrue();

      service.emitText('implementation', false);
      service.emitText('implementation carefully', true);

      expect(inputEvents[0]).assertEqual('Review this implementation');
      expect(inputEvents[1]).assertEqual('Review this implementation carefully');
    });
  });

  describe('GeneralChatDraftController', () => {
    it('owns debounced draft save timer and immediate persistence paths', 0, async () => {
      const store = new FakeGeneralChatLocalStore();
      const scheduler = new FakeGeneralChatDraftScheduler();
      const controller = new GeneralChatDraftController(store, 250, (_err: Error) => {}, scheduler);

      controller.scheduleSave('draft-1', 'first');
      expect(controller.isPending()).assertTrue();
      expect(scheduler.delays.get(1)).assertEqual(250);
      scheduler.tick(1);
      await Promise.resolve();
      expect(controller.isPending()).assertFalse();
      expect(await store.loadDraft('draft-1')).assertEqual('first');

      controller.scheduleSave('draft-1', 'old');
      controller.scheduleSave('draft-1', 'new');
      expect(scheduler.clearedIds[0]).assertEqual(2);
      scheduler.tick(2);
      await Promise.resolve();
      expect(await store.loadDraft('draft-1')).assertEqual('first');
      scheduler.tick(3);
      await Promise.resolve();
      expect(await store.loadDraft('draft-1')).assertEqual('new');

      controller.scheduleSave('draft-1', 'pending');
      controller.persistNow('draft-1', 'now');
      await Promise.resolve();
      expect(scheduler.clearedIds[1]).assertEqual(4);
      expect(await store.loadDraft('draft-1')).assertEqual('now');

      await controller.clearNow('draft-1');
      expect(await store.loadDraft('draft-1')).assertEqual('');
      await store.saveDraft('draft-1', 'restored');
      expect(await controller.restore('draft-1')).assertEqual('restored');
    });
  });

  describe('GeneralChatDraftLifecycleController', () => {
    it('routes home and visible draft lifecycle operations through the draft controller', 0, async () => {
      const store = new FakeGeneralChatLocalStore();
      const scheduler = new FakeGeneralChatDraftScheduler();
      const draftController = new GeneralChatDraftController(store, 250, (_err: Error) => {}, scheduler);
      let visibleDraftId = '';
      const lifecycle = new GeneralChatDraftLifecycleController(
        draftController,
        'home-draft',
        (): string => visibleDraftId
      );

      lifecycle.scheduleVisible('ignored');
      expect(draftController.isPending()).assertFalse();

      visibleDraftId = 'chat-1';
      lifecycle.scheduleVisible('draft text');
      expect(draftController.isPending()).assertTrue();
      scheduler.tick(1);
      await Promise.resolve();
      expect(await lifecycle.restore('chat-1')).assertEqual('draft text');

      lifecycle.persistVisible('persisted text');
      await Promise.resolve();
      expect(await lifecycle.restore('chat-1')).assertEqual('persisted text');

      await store.saveDraft('home-draft', 'home text');
      expect(await lifecycle.restoreHome()).assertEqual('home text');
      await lifecycle.clearHomeNow();
      expect(await lifecycle.restoreHome()).assertEqual('');

      lifecycle.scheduleVisible('pending');
      lifecycle.cancel();
      expect(draftController.isPending()).assertFalse();
    });
  });

  describe('GeneralChatBootstrapController', () => {
    it('restores configuration sessions and home draft through lifecycle collaborators', 0, async () => {
      const configStore = new FakeGeneralChatConfigStore();
      const client = new FakeGeneralChatCommandClient();
      const localStore = new FakeGeneralChatLocalStore();
      const draftController = new GeneralChatDraftController(localStore);
      const draftLifecycle = new GeneralChatDraftLifecycleController(
        draftController,
        'home-draft',
        (): string => 'home-draft'
      );
      const restoredConfigs: GeneralChatConfigSnapshot[] = [];
      const restoredDrafts: string[] = [];
      const statuses: string[] = [];
      await localStore.saveDraft('home-draft', 'saved home draft');
      const commandController = new GeneralChatCommandController(client, {
        onSessions: (_sessions: RemoteSession[]) => {},
        onSessionPrepared: (_sessionId: string) => {},
        onActiveSession: (_session: SessionSummary) => {},
        onMessagesLoaded: (_messages: ChatMessage[]) => {},
        onClearComposer: () => {},
        onChatInput: (_text: string) => {},
        onStatusText: (_statusText: string) => {},
        onBusy: (_isBusy: boolean) => {},
        onToast: (_statusText: string) => {}
      });
      const bootstrap = new GeneralChatBootstrapController(
        configStore,
        commandController,
        draftLifecycle,
        {
          onConfigRestored: (snapshot: GeneralChatConfigSnapshot) => {
            restoredConfigs.push(snapshot);
          },
          onHomeDraftRestored: (text: string) => {
            restoredDrafts.push(text);
          },
          onStatusText: (statusText: string) => {
            statuses.push(statusText);
          }
        }
      );

      await bootstrap.restore({} as Context);

      expect(configStore.initRequests).assertEqual(1);
      expect(client.initRequests).assertEqual(1);
      expect(restoredConfigs[0].modelName).assertEqual('model-a');
      expect(restoredDrafts[0]).assertEqual('saved home draft');
      expect(statuses.length).assertEqual(0);

      client.shouldFail = true;
      await bootstrap.restore({} as Context);
      expect(statuses[0]).assertEqual(RemoteI18n.t('generalChat.localRestoreFailed'));
    });
  });

  describe('GeneralChatCommandController', () => {
    it('opens and creates general chat sessions through page callbacks', 0, async () => {
      const client = new FakeGeneralChatCommandClient();
      const activeSessions: SessionSummary[] = [];
      const preparedSessions: string[] = [];
      const openedRoutes: string[] = [];
      const loadedMessages: ChatMessage[][] = [];
      const chatInputs: string[] = [];
      let clearComposerCount = 0;
      const session = remoteSession('chat-1', 'Chat 1');
      session.agentType = 'chat';
      client.currentSessions = [session];
      client.messagesBySession.set('chat-1', [chatMessage('message-1', 'assistant', 'Welcome')]);
      const controller = new GeneralChatCommandController(client, {
        onSessions: (_items: RemoteSession[]) => {},
        onSessionPrepared: (sessionId: string) => {
          preparedSessions.push(sessionId);
        },
        onActiveSession: (activeSession: SessionSummary) => {
          activeSessions.push(activeSession);
        },
        onMessagesLoaded: (messages: ChatMessage[]) => {
          loadedMessages.push(messages);
        },
        onClearComposer: () => {
          clearComposerCount += 1;
        },
        onChatInput: (text: string) => {
          chatInputs.push(text);
        },
        onStatusText: (_statusText: string) => {},
        onBusy: (_isBusy: boolean) => {},
        onToast: (_statusText: string) => {}
      });

      const opened = await controller.openSession(session, false, async (_sessionId: string): Promise<string> => {
        return 'draft text';
      }, (sessionId: string): void => {
        openedRoutes.push(`open:${sessionId}`);
      });
      const created = await controller.createSession(' new prompt ', false, async (): Promise<void> => {
        openedRoutes.push('draft-cleared');
      }, (sessionId: string): void => {
        openedRoutes.push(`create:${sessionId}`);
      });

      expect(opened).assertTrue();
      expect(created).assertTrue();
      expect(preparedSessions[0]).assertEqual('chat-1');
      expect(preparedSessions[1]).assertEqual('chat-created');
      expect(activeSessions[0].sessionId).assertEqual('chat-1');
      expect(activeSessions[1].sessionId).assertEqual('chat-created');
      expect(loadedMessages[0][0].id).assertEqual('message-1');
      expect(clearComposerCount).assertEqual(1);
      expect(chatInputs[0]).assertEqual('draft text');
      expect(client.createRequests[0]).assertEqual('new prompt');
      expect(openedRoutes[0]).assertEqual('open:chat-1');
      expect(openedRoutes[1]).assertEqual('create:chat-created');
      expect(openedRoutes[2]).assertEqual('draft-cleared');
    });

    it('handles delete archive and export session commands', 0, async () => {
      const client = new FakeGeneralChatCommandClient();
      const sessions: RemoteSession[][] = [];
      const statuses: string[] = [];
      const busyEvents: boolean[] = [];
      const toasts: string[] = [];
      const exportedText: string[] = [];
      const session = remoteSession('chat-1', 'Chat 1');
      session.agentType = 'chat';
      client.currentSessions = [session];
      client.messagesBySession.set('chat-1', [chatMessage('message-1', 'user', 'Hello')]);
      const controller = new GeneralChatCommandController(client, {
        onSessions: (items: RemoteSession[]) => {
          sessions.push(items);
        },
        onSessionPrepared: (_sessionId: string) => {},
        onActiveSession: (_activeSession: SessionSummary) => {},
        onMessagesLoaded: (_messages: ChatMessage[]) => {},
        onClearComposer: () => {},
        onChatInput: (_text: string) => {},
        onStatusText: (statusText: string) => {
          statuses.push(statusText);
        },
        onBusy: (isBusy: boolean) => {
          busyEvents.push(isBusy);
        },
        onToast: (statusText: string) => {
          toasts.push(statusText);
        }
      });

      await controller.archiveSession(session, true, false);
      await controller.exportSession(session, false, async (text: string): Promise<void> => {
        exportedText.push(text);
      });
      await controller.deleteSession(session, false);

      expect(client.archiveRequests[0]).assertEqual('chat-1:1');
      expect(client.messageRequests[0]).assertEqual('chat-1');
      expect(exportedText[0].indexOf('Hello') >= 0).assertTrue();
      expect(client.deleteRequests[0]).assertEqual('chat-1');
      expect(sessions.length).assertEqual(2);
      expect(sessions[sessions.length - 1].length).assertEqual(0);
      expect(statuses.indexOf(RemoteI18n.t('status.sessionArchived')) >= 0).assertTrue();
      expect(statuses.indexOf(RemoteI18n.t('status.sessionExported')) >= 0).assertTrue();
      expect(statuses[statuses.length - 1]).assertEqual(RemoteI18n.t('status.sessionDeleted'));
      expect(toasts.length).assertEqual(2);
      expect(busyEvents[0]).assertTrue();
      expect(busyEvents[busyEvents.length - 1]).assertFalse();
    });

    it('proxies send cancel and assistant persistence through the command boundary', 0, async () => {
      const client = new FakeGeneralChatCommandClient();
      const sessions: RemoteSession[][] = [];
      const userMessages: ChatMessage[] = [];
      const deltas: string[] = [];
      const controller = new GeneralChatCommandController(client, {
        onSessions: (items: RemoteSession[]) => {
          sessions.push(items);
        },
        onSessionPrepared: (_sessionId: string) => {},
        onActiveSession: (_activeSession: SessionSummary) => {},
        onMessagesLoaded: (_messages: ChatMessage[]) => {},
        onClearComposer: () => {},
        onChatInput: (_text: string) => {},
        onStatusText: (_statusText: string) => {},
        onBusy: (_isBusy: boolean) => {},
        onToast: (_statusText: string) => {}
      });

      const result = await controller.sendMessage('chat-1', 'Hello', [selectedImage('image-1')],
        new GeneralChatStreamCallbacks(
          async (message: ChatMessage): Promise<void> => {
            userMessages.push(message);
          },
          (delta: string): void => {
            deltas.push(delta);
          }
        ));
      const recorded = await controller.recordAssistantMessage('chat-1', result.assistantMessage);
      controller.cancelCurrentRequest();

      expect(client.sendRequests[0]).assertEqual('chat-1:Hello:1');
      expect(userMessages[0].id).assertEqual('sent-user');
      expect(deltas.join('')).assertEqual('Echo: Hello');
      expect(recorded).assertTrue();
      expect(client.recordedAssistantMessages[0]).assertEqual('chat-1:sent-assistant');
      expect(sessions.length).assertEqual(1);
      expect(client.cancelCount).assertEqual(1);
    });

    it('renames active sessions and prepares retry message state', 0, async () => {
      const client = new FakeGeneralChatCommandClient();
      const activeSessions: SessionSummary[] = [];
      const loadedMessages: ChatMessage[][] = [];
      const chatInputs: string[] = [];
      const statuses: string[] = [];
      const session = remoteSession('chat-1', 'Old title');
      session.agentType = 'chat';
      client.currentSessions = [session];
      client.messagesBySession.set('chat-1', [chatMessage('assistant-1', 'assistant', 'Recovered')]);
      const controller = new GeneralChatCommandController(client, {
        onSessions: (_items: RemoteSession[]) => {},
        onSessionPrepared: (_sessionId: string) => {},
        onActiveSession: (activeSession: SessionSummary) => {
          activeSessions.push(activeSession);
        },
        onMessagesLoaded: (messages: ChatMessage[]) => {
          loadedMessages.push(messages);
        },
        onClearComposer: () => {},
        onChatInput: (text: string) => {
          chatInputs.push(text);
        },
        onStatusText: (statusText: string) => {
          statuses.push(statusText);
        },
        onBusy: (_isBusy: boolean) => {},
        onToast: (_statusText: string) => {}
      });

      const renamed = await controller.renameActiveSession({
        sessionId: 'chat-1',
        title: 'Old title',
        workspacePath: '',
        agentType: 'chat',
        initialTurnId: 'turn-0'
      }, ' New title ');
      const prepared = await controller.retryMessage('chat-1', 'Retry text', false);

      expect(renamed).assertTrue();
      expect(client.renameRequests[0]).assertEqual('chat-1:New title');
      expect(activeSessions[0].title).assertEqual('New title');
      expect(activeSessions[0].initialTurnId || '').assertEqual('turn-0');
      expect(statuses[0]).assertEqual(RemoteI18n.t('status.titleUpdated'));
      expect(prepared).assertTrue();
      expect(client.removeFailedRequests[0]).assertEqual('chat-1:Retry text');
      expect(loadedMessages[0][0].id).assertEqual('assistant-1');
      expect(chatInputs[0]).assertEqual('Retry text');
    });
  });
}
