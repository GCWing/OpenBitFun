import { describe, it, expect } from '@ohos/hypium';
import { DurableSessionReducer, SessionRecord } from '../main/ets/services/DurableSessionReducer';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { ChatSessionController, ChatSessionSnapshot } from '../main/ets/services/ChatSessionController';
import { ChatComposerPolicy } from '../main/ets/services/ChatComposerPolicy';
import { ChatTimelineItem, ChatTimelineProjector } from '../main/ets/services/ChatTimelineProjector';
import { ChatTimelineRevisionTracker, ChatTimelineRowStore } from '../main/ets/model/ChatTimelineModels';
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
import { TranscriptIntegrityPolicy } from '../main/ets/services/TranscriptIntegrityPolicy';
import {
  VoiceInputLifecycleCallbacks,
  VoiceInputLifecycleController,
  VoiceInputRouteSnapshot
} from '../main/ets/services/VoiceInputLifecycleController';
import { VoiceInputCallbacks, VoiceInputService } from '../main/ets/services/VoiceInputService';
import { AppShellState } from '../main/ets/pages/state/AppShellState';
import { ConversationCoreState } from '../main/ets/pages/state/ConversationCoreState';
import { GeneralChatPageState } from '../main/ets/pages/state/GeneralChatPageState';
import { RemotePageState } from '../main/ets/pages/state/RemotePageState';
import { ConversationViewState } from '../main/ets/pages/state/ConversationViewState';
import { ConversationController } from '../main/ets/pages/viewmodel/ConversationController';
import { RemoteWorkspaceViewModel } from '../main/ets/pages/viewmodel/RemoteWorkspaceViewModel';
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
  RemoteWorkspaceIdentity,
  SelectedImageAttachment,
  SessionListResult,
  SessionMessagesResult,
  SessionSummary,
  WorkspaceInfo
} from '../main/ets/model/RemoteModels';

import {
  durableRecord,
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

interface DurableUserMetadata { images: ImageAttachment[]; }

export default function conversationStateUnitTest() {
  describe('ChatTimelineProjector', () => {
    it('filters seed messages and returns empty state for empty real history', 0, () => {
      const items = ChatTimelineProjector.project([
        chatMessage('system-seed', 'assistant', 'Welcome')
      ], [], chatMessage('', 'assistant', ''), false);

      expect(items.length).assertEqual(1);
      expect(items[0].type).assertEqual('empty_state');
    });

    it('deduplicates optimistic user messages confirmed with the same id', 0, () => {
      const items = ChatTimelineProjector.project([
        chatMessage('message-user-1', 'user', 'Explain this file')
      ], [
        chatMessage('message-user-1', 'user', ' Explain this file ')
      ], chatMessage('', 'assistant', ''), false);

      expect(items.length).assertEqual(1);
      expect(items[0].id).assertEqual('message-message-user-1');
      expect(items[0].type).assertEqual('user_message');
    });

    it('keeps repeated user text when optimistic and historical ids differ', 0, () => {
      const items = ChatTimelineProjector.project([
        chatMessage('historical-user-1', 'user', '你是谁')
      ], [
        chatMessage('optimistic-user-2', 'user', '你是谁')
      ], chatMessage('', 'assistant', ''), false);

      expect(items.length).assertEqual(2);
      expect(items[0].id).assertEqual('message-historical-user-1');
      expect(items[1].id).assertEqual('pending-optimistic-user-2');
    });

    it('keeps optimistic image messages when persisted image payload differs', 0, () => {
      const items = ChatTimelineProjector.project([
        chatMessageWithImage('remote-user-1', 'user', 'Analyze image', 'remote.png', 'data:image/png;base64,remote')
      ], [
        chatMessageWithImage('msg-local-1', 'user', 'Analyze image', 'local.png', 'data:image/png;base64,local')
      ], chatMessage('', 'assistant', ''), false);

      expect(items.length).assertEqual(2);
      expect(items[0].id).assertEqual('message-remote-user-1');
      expect(items[1].id).assertEqual('pending-msg-local-1');
      expect(items[1].type).assertEqual('optimistic_user_message');
    });

    it('keeps active turn until matching assistant message is persisted', 0, () => {
      const activeTurn = activeChatMessage('turn-1', 'Done with the edit', 'completed');
      const beforeFinal = ChatTimelineProjector.project([
        chatMessage('remote-user-1', 'user', 'Please edit')
      ], [], activeTurn, false);
      const afterFinal = ChatTimelineProjector.project([
        chatMessage('remote-user-1', 'user', 'Please edit'),
        chatMessage('turn-1_assistant', 'assistant', 'Done with the edit')
      ], [], activeTurn, false);

      expect(beforeFinal.length).assertEqual(2);
      expect(beforeFinal[1].type).assertEqual('assistant_live_turn');
      expect(beforeFinal[1].isFinalizing).assertEqual(true);
      expect(afterFinal.length).assertEqual(2);
      expect(afterFinal[1].id).assertEqual('message-turn-1_assistant');
      expect(afterFinal[1].type).assertEqual('assistant_message');
    });

    it('keeps active turn identity stable when visible content changes', 0, () => {
      const first = activeChatMessage('turn-stable-1', 'abc', 'active', 1);
      const second = activeChatMessage('turn-stable-1', 'abcdef', 'active', 2);
      const firstItems = ChatTimelineProjector.project([], [], first, false);
      const secondItems = ChatTimelineProjector.project([], [], second, false);

      expect(firstItems.length).assertEqual(1);
      expect(secondItems.length).assertEqual(1);
      expect(firstItems[0].id).assertEqual('active-turn-stable-1');
      expect(secondItems[0].id).assertEqual('active-turn-stable-1');
      expect(ChatTimelineRevisionTracker.itemKey(firstItems[0]))
        .assertEqual(ChatTimelineRevisionTracker.itemKey(secondItems[0]));
      expect(ChatTimelineRevisionTracker.itemSignature(firstItems[0]) ===
        ChatTimelineRevisionTracker.itemSignature(secondItems[0])).assertFalse();
    });

    it('keeps assistant row identity stable from live turn to persisted completion', 0, () => {
      const activeTurn = activeChatMessage('turn-row-1', 'Streaming', 'active', 1);
      const finalMessage = chatMessage('assistant-random-id', 'assistant', 'Completed');
      finalMessage.turnId = 'turn-row-1';
      finalMessage.status = 'completed';
      const activeItems = ChatTimelineProjector.project([], [], activeTurn, false);
      const finalItems = ChatTimelineProjector.project([finalMessage], [], activeTurn, false);

      expect(activeItems.length).assertEqual(1);
      expect(finalItems.length).assertEqual(1);
      expect(ChatTimelineRevisionTracker.itemKey(activeItems[0]))
        .assertEqual(ChatTimelineRevisionTracker.itemKey(finalItems[0]));
    });

    it('hides active turn when final assistant id matches turn id', 0, () => {
      const activeTurn = activeChatMessage('turn-final-1', 'partial active text', 'completed');
      const items = ChatTimelineProjector.project([
        chatMessage('turn-final-1_assistant', 'assistant', 'rewritten final text')
      ], [], activeTurn, false);

      expect(items.length).assertEqual(1);
      expect(items[0].id).assertEqual('message-turn-final-1_assistant');
      expect(items[0].type).assertEqual('assistant_message');
    });

    it('uses one active row when matching persisted assistant has no final text yet', 0, () => {
      const activeTurn = activeChatMessage('turn-final-wait-1', 'final answer', 'completed');
      const pendingFinal = chatMessage('turn-final-wait-1_assistant', 'assistant', '');
      pendingFinal.text = 'Still reasoning';
      pendingFinal.thinking = 'Still reasoning';
      const items = ChatTimelineProjector.project([pendingFinal], [], activeTurn, false);

      expect(items.length).assertEqual(1);
      expect(items[0].type).assertEqual('assistant_live_turn');
      expect(items[0].isFinalizing).assertEqual(true);
      expect(ChatTimelineRevisionTracker.itemKey(items[0])).assertEqual('assistant_turn:turn-final-wait-1');
    });

    it('defensively reconciles duplicate assistant turn keys to one row', 0, () => {
      const activeTurn = activeChatMessage('turn-row-duplicate-1', '', 'active');
      const pendingFinal = chatMessage('turn-row-duplicate-1_assistant', 'assistant', 'Still reasoning');
      pendingFinal.turnId = 'turn-row-duplicate-1';
      pendingFinal.thinking = 'Still reasoning';
      const persistedItems = ChatTimelineProjector.project([
        pendingFinal
      ], [], chatMessage('', 'assistant', ''), false);
      const activeItems = ChatTimelineProjector.project([], [], activeTurn, false);
      const rows = new ChatTimelineRowStore().reconcile([persistedItems[0], activeItems[0]]);

      expect(rows.length).assertEqual(1);
      expect(rows[0].type).assertEqual('assistant_live_turn');
      expect(ChatTimelineRevisionTracker.itemKey(rows[0])).assertEqual('assistant_turn:turn-row-duplicate-1');
    });

    it('offers retry only for the latest unresolved failed message', 0, () => {
      const interrupted = chatMessage('assistant-failed-1', 'assistant', 'Partial reply', 'failed');
      interrupted.error = 'Model request failed';
      const unresolved = ChatTimelineProjector.project([
        chatMessage('user-1', 'user', 'Retry prompt'),
        interrupted
      ], [], chatMessage('', 'assistant', ''), false);
      const continued = ChatTimelineProjector.project([
        chatMessage('user-1', 'user', 'Retry prompt'),
        interrupted,
        chatMessage('user-2', 'user', 'Continue')
      ], [], chatMessage('', 'assistant', ''), false);

      expect(unresolved[1].showRetryAction).assertTrue();
      expect(unresolved[1].message ? unresolved[1].message!.detail : '').assertEqual('Retry prompt');
      expect(unresolved[1].message ? unresolved[1].message!.error : '').assertEqual('Model request failed');
      expect(continued[1].showRetryAction).assertFalse();
      expect(continued[2].showRetryAction).assertFalse();
    });
  });

  describe('ChatTimelineStore', () => {
    it('keeps accepted steering inline when the active turn becomes persisted', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-steering');
      const active = activeChatMessage('turn-steering', 'Before steering');
      active.items = [{ type: 'text', content: 'Before steering' }];
      store.setActiveTurn(active);

      const appended = store.appendSteeringItem(
        'turn-steering',
        'steering-1',
        'Use the second approach',
        [{ name: 'reference.png', data_url: 'data:image/png;base64,AA==', mime_type: 'image/png' }]
      );
      expect(appended).assertTrue();
      expect(store.snapshot().activeTurn!.items![1].type || '').assertEqual('user-steering');

      const finalMessage = chatMessage('assistant-final', 'assistant', 'After steering');
      finalMessage.turnId = 'turn-steering';
      finalMessage.items = [
        { type: 'text', content: 'Before steering' },
        { type: 'user-steering', steering_id: 'steering-1', content: 'Use the second approach' },
        { type: 'text', content: 'After steering' }
      ];
      store.mergePersistedMessages([finalMessage]);

      const state = store.snapshot();
      expect(state.activeTurn === undefined).assertTrue();
      expect(state.persistedMessages[0].items![1].steering_id || '').assertEqual('steering-1');
      expect((state.persistedMessages[0].items![1].images || []).length).assertEqual(1);
    });

    it('keeps persisted messages with different ids even when their text matches', 0, () => {
      const merged = RemoteUiState.mergeMessages([
        chatMessage('msg-historical-1', 'user', '你是谁')
      ], [
        chatMessage('msg-current-2', 'user', '你是谁')
      ]);

      expect(merged.length).assertEqual(2);
      expect(merged[0].id).assertEqual('msg-historical-1');
      expect(merged[1].id).assertEqual('msg-current-2');
    });

    it('appends a repeated user message and reconciles only its new acknowledgement', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-repeat');
      store.setPersistedMessages([
        chatMessage('msg-historical-user', 'user', '你是谁'),
        chatMessage('assistant-historical', 'assistant', '旧回复')
      ]);
      store.appendOptimisticMessage(chatMessage('optimistic-user-current', 'user', '你是谁'));

      let items = store.project(false);
      expect(items.length).assertEqual(3);
      expect(items[2].id).assertEqual('pending-optimistic-user-current');

      store.mergePersistedMessages([
        chatMessage('msg-current-user', 'user', '你是谁')
      ]);
      const state = store.snapshot();
      items = store.project(false);
      expect(state.persistedMessages.length).assertEqual(3);
      expect(state.optimisticMessages.length).assertEqual(0);
      expect(items.length).assertEqual(3);
      expect(items[0].id).assertEqual('message-msg-historical-user');
      expect(items[2].id).assertEqual('message-msg-current-user');
    });

    it('reconciles identical queued user messages one acknowledgement at a time', 0, () => {
      const remaining = ChatTimelineStore.optimisticMessagesNotPersisted([
        chatMessage('optimistic-user-1', 'user', '继续'),
        chatMessage('optimistic-user-2', 'user', '继续')
      ], [
        chatMessage('persisted-user-1', 'user', '继续')
      ]);

      expect(remaining.length).assertEqual(1);
      expect(remaining[0].id).assertEqual('optimistic-user-2');
    });

    it('keeps one identical local message when one remote acknowledgement arrives', 0, () => {
      const merged = RemoteUiState.mergeRemoteWithLocalOptimistic([
        chatMessage('persisted-user-1', 'user', '继续')
      ], [
        chatMessage('optimistic-user-1', 'user', '继续'),
        chatMessage('optimistic-user-2', 'user', '继续')
      ]);

      expect(merged.length).assertEqual(2);
      expect(merged[0].id).assertEqual('persisted-user-1');
      expect(merged[1].id).assertEqual('optimistic-user-2');
    });

    it('does not reconcile identical remote text when image payloads differ', 0, () => {
      const merged = RemoteUiState.mergeRemoteWithLocalOptimistic([
        chatMessageWithImage(
          'persisted-user-image', 'user', '分析图片', 'remote.png', 'data:image/png;base64,remote'
        )
      ], [
        chatMessageWithImage(
          'optimistic-user-image', 'user', '分析图片', 'local.png', 'data:image/png;base64,local'
        )
      ]);

      expect(merged.length).assertEqual(2);
      expect(merged[1].id).assertEqual('optimistic-user-image');
    });

    it('reconciles a transformed image by stable turn identity', 0, () => {
      const optimistic = chatMessageWithImage(
        'optimistic-user-image', 'user', '分析图片', 'capture.png', 'data:image/png;base64,original'
      );
      optimistic.turnId = 'harmony-turn-image';
      const persisted = chatMessageWithImage(
        'persisted-user-image', 'user', '分析图片', 'capture.png', 'data:image/jpeg;base64,thumbnail'
      );
      persisted.turnId = 'harmony-turn-image';

      const remaining = ChatTimelineStore.optimisticMessagesNotPersisted([optimistic], [persisted]);

      expect(remaining.length).assertEqual(0);

      const merged = RemoteUiState.mergeRemoteWithLocalOptimistic([persisted], [optimistic]);
      expect(merged.length).assertEqual(1);
      expect(merged[0].id).assertEqual('persisted-user-image');
    });

    it('removes an optimistic image when an older host acknowledgement arrives after polling', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-image-race');
      const optimistic = chatMessageWithImage(
        'optimistic-user-image', 'user', '分析图片', 'capture.png', 'data:image/png;base64,original'
      );
      optimistic.turnId = 'harmony-client-turn';
      store.appendOptimisticMessage(optimistic);
      const persisted = chatMessageWithImage(
        'persisted-user-image', 'user', '分析图片', 'capture.png', 'data:image/jpeg;base64,thumbnail'
      );
      persisted.turnId = 'legacy-host-turn';
      store.setPersistedMessages([persisted]);
      expect(store.snapshot().optimisticMessages.length).assertEqual(1);

      store.acknowledgeOptimisticTurn('optimistic-user-image', 'legacy-host-turn');

      expect(store.snapshot().optimisticMessages.length).assertEqual(0);
    });

    it('does not hide an active reply that matches historical assistant text', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-repeat-assistant');
      store.setPersistedMessages([
        chatMessage('assistant-historical', 'assistant', '相同回复')
      ]);
      store.setActiveTurn(activeChatMessage('turn-current', '相同回复'));

      let state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-current');
      expect(store.project(false).length).assertEqual(2);

      store.mergePersistedMessages([
        chatMessage('assistant-current', 'assistant', '相同回复')
      ]);
      state = store.snapshot();
      expect(state.persistedMessages.length).assertEqual(2);
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('');
    });

    it('updates same-id persisted messages when final content arrives later', 0, () => {
      const pendingFinal = chatMessage('assistant-final-same-id', 'assistant', '');
      pendingFinal.text = 'Still reasoning';
      pendingFinal.thinking = 'Still reasoning';
      const merged = RemoteUiState.mergeMessages([pendingFinal], [
        chatMessage('assistant-final-same-id', 'assistant', 'Final answer')
      ]);

      expect(merged.length).assertEqual(1);
      expect(merged[0].text).assertEqual('Final answer');
      expect(merged[0].thinking || '').assertEqual('');
    });

    it('does not let an empty poll stub wipe a richer assistant body', 0, () => {
      const rich = chatMessage('assistant-rich-1', 'assistant', 'Done with the edit');
      rich.thinking = 'Plan the change first';
      rich.tools = [{ id: 'tool-1', name: 'Grep', status: 'completed' }];
      rich.items = [{
        type: 'thinking',
        content: 'Plan the change first'
      }, {
        type: 'tool',
        tool: { id: 'tool-1', name: 'Grep', status: 'completed' }
      }];
      const stub = chatMessage('assistant-rich-1', 'assistant', '');
      stub.thinking = '';
      stub.tools = [];
      stub.items = [];
      const merged = RemoteUiState.mergeMessages([rich], [stub]);

      expect(TranscriptIntegrityPolicy.isHollowAssistant(stub)).assertTrue();
      expect(TranscriptIntegrityPolicy.hasDisplayableBody(merged[0])).assertTrue();
      expect(merged[0].text).assertEqual('Done with the edit');
      expect(merged[0].thinking).assertEqual('Plan the change first');
      expect(merged[0].tools ? merged[0].tools.length : 0).assertEqual(1);
      expect(merged[0].items ? merged[0].items.length : 0).assertEqual(2);
    });

    it('keeps structured items when later text arrives without them', 0, () => {
      const rich = chatMessage('assistant-rich-2', 'assistant', '');
      rich.thinking = 'Still reasoning';
      rich.items = [{ type: 'thinking', content: 'Still reasoning' }];
      rich.tools = [{ id: 'tool-2', name: 'Read', status: 'completed' }];
      const merged = RemoteUiState.mergeMessages([rich], [
        chatMessage('assistant-rich-2', 'assistant', 'Final answer')
      ]);

      expect(merged[0].text).assertEqual('Final answer');
      expect(merged[0].thinking || '').assertEqual('');
      expect(merged[0].items ? merged[0].items.length : 0).assertEqual(1);
      expect(merged[0].tools ? merged[0].tools.length : 0).assertEqual(1);
    });

    it('owns optimistic merge and active turn cleanup rules', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      store.appendOptimisticMessage(chatMessage('msg-local-1', 'user', 'Please edit'));
      store.setActiveTurn(chatMessage('active-turn-1', 'assistant', 'Final text', 'completed'));
      store.mergePersistedMessages([
        chatMessage('remote-user-1', 'user', 'Please edit')
      ]);

      let state = store.snapshot();
      expect(state.persistedMessages.length).assertEqual(1);
      expect(state.optimisticMessages.length).assertEqual(0);
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-1');
      expect(state.syncPhase).assertEqual('finalizing');

      store.mergePersistedMessages([
        chatMessage('assistant-final-1', 'assistant', 'Final text')
      ]);
      state = store.snapshot();
      expect(state.persistedMessages.length).assertEqual(2);
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('');
    });

    it('never offers a placeholder id as the turn to cancel', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-stop');
      store.appendOptimisticMessage(chatMessage('local-1', 'user', 'Run it'));
      const pendingActiveId = store.setPendingActiveTurn('local-1');
      const pendingTurn = store.snapshot().activeTurn;

      // The placeholder is what the user sees while the desktop has not yet
      // reported a turn — asking to cancel `pending-local-1` would be refused
      // as stale, so this window must resolve to "cancel whatever is running".
      expect(pendingActiveId).assertEqual('active-pending-local-1');
      expect(ChatTimelineStore.cancelableTurnId(pendingTurn!)).assertEqual('');

      store.setLocalActiveTurn('turn-9');
      expect(ChatTimelineStore.cancelableTurnId(store.snapshot().activeTurn!)).assertEqual('turn-9');
    });

    it('keeps a message sent mid-run below the reply it is waiting on', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-queue');
      // The turn the desktop is already running: its own user message came back
      // persisted, which is what leaves nothing for the turn to sit behind.
      store.mergePersistedMessages([chatMessage('user-1', 'user', 'First')]);
      store.setLocalActiveTurn('turn-1');
      store.appendOptimisticMessage(chatMessage('local-2', 'user', 'Second'));

      const items = store.project(false);
      expect(items.length).assertEqual(3);
      expect(items[0].type).assertEqual('user_message');
      expect(items[1].type).assertEqual('assistant_live_turn');
      expect(items[2].type).assertEqual('optimistic_user_message');
      expect(items[2].message ? items[2].message!.id : '').assertEqual('local-2');
    });

    it('still draws the first reply under the message that started it', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-first');
      store.appendOptimisticMessage(chatMessage('local-1', 'user', 'First'));
      store.setPendingActiveTurn('local-1');

      // Nothing has been persisted yet, so without the anchor the placeholder
      // would render above the message the user just sent.
      expect(store.activeTurnAnchorId()).assertEqual('local-1');
      const pending = store.project(false);
      expect(pending[0].type).assertEqual('optimistic_user_message');
      expect(pending[1].type).assertEqual('assistant_live_turn');

      // Promoting the placeholder to the real turn must not lose the anchor.
      store.setLocalActiveTurn('turn-1');
      expect(store.activeTurnAnchorId()).assertEqual('local-1');
      const promoted = store.project(false);
      expect(promoted[0].type).assertEqual('optimistic_user_message');
      expect(promoted[1].type).assertEqual('assistant_live_turn');
    });

    it('projects empty state through the store', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-empty');
      const items = store.project(false);

      expect(items.length).assertEqual(1);
      expect(items[0].type).assertEqual('empty_state');
    });

    it('applies transport-neutral turn events to the shared timeline', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-events');
      const started: ConversationEvent = {
        type: 'turn_started', sessionId: 'session-events', turnId: 'turn-1'
      };
      const firstDelta: ConversationEvent = {
        type: 'assistant_delta',
        sessionId: 'session-events',
        turnId: 'turn-1',
        delta: 'Hello'
      };
      const secondDelta: ConversationEvent = {
        type: 'assistant_delta',
        sessionId: 'session-events',
        turnId: 'turn-1',
        delta: ' world'
      };
      store.applyEvent(started);
      store.applyEvent(firstDelta);
      store.applyEvent(secondDelta);

      const state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.text : '').assertEqual('Hello world');
      expect(state.activeTurn ? (state.activeTurn.turnId || '') : '').assertEqual('turn-1');
      expect(state.syncPhase).assertEqual('streaming');
    });

    it('ignores events from a different session', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-current');
      const started: ConversationEvent = {
        type: 'turn_started', sessionId: 'session-other', turnId: 'turn-other'
      };
      const staleDelta: ConversationEvent = {
        type: 'assistant_delta',
        sessionId: 'session-other',
        turnId: 'turn-other',
        delta: 'stale'
      };
      store.applyEvent(started);
      store.applyEvent(staleDelta);

      const state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('');
    });

    it('applies full active turn snapshots through the shared event reducer', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-current');
      const active = activeChatMessage('turn-shared-1', 'streamed answer', 'active', 4);
      const update: ConversationEvent = {
        type: 'active_turn_updated',
        sessionId: 'session-current',
        message: active
      };
      store.applyEvent(update);

      const state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.text : '').assertEqual('streamed answer');
      expect(state.activeTurn ? (state.activeTurn.renderVersion || 0) : 0).assertEqual(4);
      expect(state.syncPhase).assertEqual('streaming');
    });

    it('creates a local active turn from send response turn ids', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      store.setLocalActiveTurn(' turn-preview-1 ');

      let state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-preview-1');
      expect(state.activeTurn ? (state.activeTurn.turnId || '') : '').assertEqual('turn-preview-1');
      expect(state.activeTurn ? state.activeTurn.status : '').assertEqual('active');
      expect(state.syncPhase).assertEqual('streaming');

      store.setLocalActiveTurn('turn-preview-2');
      state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-preview-1');
    });

    it('replaces pending active turns with remote turn ids', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      const pendingId = store.setPendingActiveTurn('msg-local-1');

      let state = store.snapshot();
      expect(pendingId).assertEqual('active-pending-msg-local-1');
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-pending-msg-local-1');
      expect(state.syncPhase).assertEqual('streaming');

      store.setLocalActiveTurn('turn-remote-1');
      state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-remote-1');
      expect(state.activeTurn ? (state.activeTurn.turnId || '') : '').assertEqual('turn-remote-1');
    });

    it('keeps streamed active turn text when send response arrives later', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      const active = chatMessage('active-turn-remote-1', 'assistant', 'partial text', 'active');
      active.turnId = 'turn-remote-1';
      store.setActiveTurn(active);

      store.setLocalActiveTurn('turn-remote-1');

      const state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-remote-1');
      expect(state.activeTurn ? state.activeTurn.text : '').assertEqual('partial text');
      expect(state.activeTurn ? (state.activeTurn.turnId || '') : '').assertEqual('turn-remote-1');
    });

    it('keeps active turn text from going backwards for the same turn id', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      store.setActiveTurn(activeChatMessage('turn-stream-1', 'abcdef'));
      store.setActiveTurn(activeChatMessage('turn-stream-1', 'abc', 'active', 2));

      const state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.text : '').assertEqual('abcdef');
      expect(state.activeTurn ? (state.activeTurn.turnId || '') : '').assertEqual('turn-stream-1');
      expect(state.activeTurn ? (state.activeTurn.renderVersion || 0) : 0).assertEqual(2);
    });

    it('monotonically merges structured text items for active turns', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      const first = activeChatMessage('turn-items-1', '');
      first.items = [{
        type: 'text',
        content: 'abcdef'
      }];
      const second = activeChatMessage('turn-items-1', '', 'active', 2);
      second.items = [{
        type: 'text',
        content: 'abc'
      }];

      store.setActiveTurn(first);
      store.setActiveTurn(second);

      const state = store.snapshot();
      const items = state.activeTurn && state.activeTurn.items ? state.activeTurn.items : [];
      expect(items.length).assertEqual(1);
      expect(items[0].content || '').assertEqual('abcdef');
    });

    it('updates active tool status from latest structured item snapshot', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      const first = activeChatMessage('turn-tool-1', '');
      first.items = [{
        type: 'tool',
        tool: {
          id: 'tool-1',
          name: 'read_file',
          status: 'running'
        }
      }];
      const second = activeChatMessage('turn-tool-1', '', 'active', 2);
      second.items = [{
        type: 'tool',
        tool: {
          id: 'tool-1',
          name: 'read_file',
          status: 'completed',
          duration_ms: 50
        }
      }];

      store.setActiveTurn(first);
      store.setActiveTurn(second);

      const state = store.snapshot();
      const items = state.activeTurn && state.activeTurn.items ? state.activeTurn.items : [];
      expect(items.length).assertEqual(1);
      expect(items[0].tool ? (items[0].tool.status || '') : '').assertEqual('completed');
      expect(items[0].tool ? (items[0].tool.duration_ms || 0) : 0).assertEqual(50);
    });

    it('preserves Task invocation metadata when a completion snapshot omits it', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      const first = activeChatMessage('turn-task-title-1', '');
      first.items = [{
        type: 'tool',
        tool: {
          id: 'task-1',
          name: 'Task',
          status: 'running',
          input_preview: '{"description":"Read the README introduction"}'
        }
      }];
      const second = activeChatMessage('turn-task-title-1', '', 'active', 2);
      second.items = [{
        type: 'tool',
        tool: {
          id: 'task-1',
          name: 'Task',
          status: 'completed',
          result_preview: 'Done'
        }
      }];

      store.setActiveTurn(first);
      store.setActiveTurn(second);

      const state = store.snapshot();
      const items = state.activeTurn && state.activeTurn.items ? state.activeTurn.items : [];
      const tool = items.length > 0 ? items[0].tool : undefined;
      expect(tool ? (tool.status || '') : '').assertEqual('completed');
      expect(tool ? (tool.input_preview || '') : '')
        .assertEqual('{"description":"Read the README introduction"}');
      expect(tool ? (tool.result_preview || '') : '').assertEqual('Done');
    });

    it('clears active turn when persisted assistant id matches turn id', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      store.setActiveTurn(activeChatMessage('turn-final-store-1', 'partial active text', 'completed'));
      store.mergePersistedMessages([
        chatMessage('turn-final-store-1_assistant', 'assistant', 'rewritten final text')
      ]);

      const state = store.snapshot();
      expect(state.persistedMessages.length).assertEqual(1);
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('');
    });

    it('holds completed active turn until persisted assistant has final content', 0, () => {
      const store = new ChatTimelineStore();
      store.reset('session-1');
      store.setActiveTurn(activeChatMessage('turn-final-store-wait-1', 'final answer', 'completed'));

      const pendingFinal = chatMessage('turn-final-store-wait-1_assistant', 'assistant', '');
      pendingFinal.text = 'Still reasoning';
      pendingFinal.thinking = 'Still reasoning';
      store.mergePersistedMessages([pendingFinal]);
      store.setActiveTurn(undefined);

      let state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('active-turn-final-store-wait-1');
      expect(state.syncPhase).assertEqual('finalizing');

      store.mergePersistedMessages([
        chatMessage('turn-final-store-wait-1_assistant', 'assistant', 'final answer')
      ]);
      state = store.snapshot();
      expect(state.activeTurn ? state.activeTurn.id : '').assertEqual('');
    });
  });

  describe('MarkdownParser', () => {
    it('parses document-leading YAML frontmatter without rendering its markers as dividers', 0, () => {
      const blocks = MarkdownParser.parse(
        '---\nname: OpenBitFun\nvibe: calm\n---\n\n# Identity\n\nBody\n\n---\n\nTail'
      );

      expect(blocks.length).assertEqual(5);
      expect(blocks[0].type).assertEqual('frontmatter');
      expect(blocks[0].text).assertEqual('name: OpenBitFun\nvibe: calm');
      expect(blocks[1].type).assertEqual('heading');
      expect(blocks[2].type).assertEqual('paragraph');
      expect(blocks[3].type).assertEqual('divider');
      expect(blocks[4].type).assertEqual('paragraph');
    });

    it('parses common markdown blocks into stable block types', 0, () => {
      const blocks = MarkdownParser.parse('# Title\n\n- first\n- **second**\n\n> quote\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');

      expect(blocks.length).assertEqual(5);
      expect(blocks[0].type).assertEqual('heading');
      expect(blocks[0].level).assertEqual(1);
      expect(blocks[1].type).assertEqual('list');
      expect(blocks[1].items.length).assertEqual(2);
      expect(blocks[1].items[1].text).assertEqual('second');
      expect(blocks[2].type).assertEqual('quote');
      expect(blocks[3].type).assertEqual('code');
      expect(blocks[3].language).assertEqual('ts');
      expect(blocks[4].type).assertEqual('table');
      expect(blocks[4].tableRows.length).assertEqual(2);
      expect(blocks[4].tableRows[0].header).assertTrue();
      expect(blocks[4].tableRows[0].cells.length).assertEqual(2);
      expect(blocks[4].tableRows[1].cells[1].text).assertEqual('2');
    });

    it('formats inline code, emphasis, and links without markdown control text', 0, () => {
      const blocks = MarkdownParser.parse('Use `pnpm test`, **bold text**, and [docs](https://example.test).');

      expect(blocks.length).assertEqual(1);
      expect(blocks[0].type).assertEqual('paragraph');
      expect(blocks[0].text).assertEqual('Use pnpm test, bold text, and docs (https://example.test).');
      expect(blocks[0].inlines.length).assertEqual(7);
      expect(blocks[0].inlines[1].type).assertEqual('code');
      expect(blocks[0].inlines[3].type).assertEqual('strong');
      expect(blocks[0].inlines[5].type).assertEqual('link');
      expect(blocks[0].inlines[5].url).assertEqual('https://example.test');
    });

    it('parses GFM table cells, alignment, escaped pipes, and inline formatting', 0, () => {
      const blocks = MarkdownParser.parse(
        '**Name** | Status | Note\n:--- | :---: | ---:\nOpenBitFun | ~~old~~ | a \\| b'
      );

      expect(blocks.length).assertEqual(1);
      expect(blocks[0].type).assertEqual('table');
      expect(blocks[0].tableRows.length).assertEqual(2);
      expect(blocks[0].tableRows[0].cells[0].inlines[0].type).assertEqual('strong');
      expect(blocks[0].tableRows[0].cells[0].text).assertEqual('Name');
      expect(blocks[0].tableRows[1].cells[1].inlines[0].type).assertEqual('delete');
      expect(blocks[0].tableRows[1].cells[1].inlines[0].text).assertEqual('old');
      expect(blocks[0].tableRows[1].cells[2].text).assertEqual('a | b');
      expect(blocks[0].tableRows[0].cells[0].alignment).assertEqual('left');
      expect(blocks[0].tableRows[0].cells[1].alignment).assertEqual('center');
      expect(blocks[0].tableRows[0].cells[2].alignment).assertEqual('right');
    });

    it('parses task state, nested list depth, extended headings, fences, and autolinks', 0, () => {
      const blocks = MarkdownParser.parse(
        '##### Detail\n\nSetext title\n---\n\n- [x] done\n  - [ ] child\n\n~~~rust extra\nlet value = 1;\n~~~\n\nSee https://example.test/docs.'
      );

      expect(blocks[0].type).assertEqual('heading');
      expect(blocks[0].level).assertEqual(5);
      expect(blocks[1].type).assertEqual('heading');
      expect(blocks[1].level).assertEqual(2);
      expect(blocks[2].items[0].checked).assertEqual(1);
      expect(blocks[2].items[1].checked).assertEqual(0);
      expect(blocks[2].items[1].depth).assertEqual(1);
      expect(blocks[3].type).assertEqual('code');
      expect(blocks[3].language).assertEqual('rust');
      expect(blocks[4].inlines[1].type).assertEqual('link');
      expect(blocks[4].inlines[1].url).assertEqual('https://example.test/docs');
    });

    it('renders angle-bracket autolinks without their delimiters', 0, () => {
      const blocks = MarkdownParser.parse('Open <https://example.test/docs> now.');

      expect(blocks[0].text).assertEqual('Open https://example.test/docs now.');
      expect(blocks[0].inlines.length).assertEqual(3);
      expect(blocks[0].inlines[1].type).assertEqual('link');
      expect(blocks[0].inlines[1].text).assertEqual('https://example.test/docs');
      expect(blocks[0].inlines[1].url).assertEqual('https://example.test/docs');
    });

    it('handles soft and hard line breaks, escapes, and multi-backtick code spans', 0, () => {
      const blocks = MarkdownParser.parse(
        'soft\nline\n\nhard  \nbreak\n\nescaped \\*literal\\* and ``code ` span``'
      );

      expect(blocks[0].text).assertEqual('soft line');
      expect(blocks[1].text).assertEqual('hard\nbreak');
      expect(blocks[2].inlines[0].text).assertEqual('escaped *literal* and ');
      expect(blocks[2].inlines[1].type).assertEqual('code');
      expect(blocks[2].inlines[1].text).assertEqual('code ` span');
    });

    it('preserves nested quote and list presentation levels plus list continuation text', 0, () => {
      const blocks = MarkdownParser.parse(
        '> outer\n>> nested\n> outer again\n\n- first\n  continuation\n    - nested item'
      );

      expect(blocks[0].type).assertEqual('quote');
      expect(blocks[0].level).assertEqual(1);
      expect(blocks[1].level).assertEqual(2);
      expect(blocks[1].text).assertEqual('nested');
      expect(blocks[2].level).assertEqual(1);
      expect(blocks[3].items[0].text).assertEqual('first continuation');
      expect(blocks[3].items[1].depth).assertEqual(1);
    });

    it('changes the render key when a streaming markdown block grows', 0, () => {
      const firstCode = MarkdownParser.parse('```text\nline 1');
      const secondCode = MarkdownParser.parse('```text\nline 1\nline 2');
      const firstParagraph = MarkdownParser.parse('streaming');
      const secondParagraph = MarkdownParser.parse('streaming content');

      expect(firstCode[0].id).assertEqual(secondCode[0].id);
      expect(firstCode[0].renderKey === secondCode[0].renderKey).assertFalse();
      expect(firstParagraph[0].id).assertEqual(secondParagraph[0].id);
      expect(firstParagraph[0].renderKey === secondParagraph[0].renderKey).assertFalse();
    });

    it('keeps completed markdown block render keys stable while the active block grows', 0, () => {
      const first = MarkdownParser.parse('Completed paragraph.\n\n```text\nline 1');
      const second = MarkdownParser.parse('Completed paragraph.\n\n```text\nline 1\nline 2');

      expect(first.length).assertEqual(2);
      expect(second.length).assertEqual(2);
      expect(first[0].renderKey).assertEqual(second[0].renderKey);
      expect(first[1].id).assertEqual(second[1].id);
      expect(first[1].renderKey === second[1].renderKey).assertFalse();
    });
  });

  describe('ConversationController', () => {
    it('routes legacy and current composer destinations to the remote controller', 0, () => {
      const general = new GeneralChatPageState();
      const remote = new RemotePageState();
      let route = AppRoute.ChatHome;
      const controller = new ConversationController(
        general,
        remote,
        { currentRoute: (): AppRoute => route }
      );

      controller.setChatInput(AppRoute.ChatHome, 'general draft');
      controller.setChatInput(AppRoute.RemoteChat, 'remote draft');

      expect(controller.visibleChatInput()).assertEqual('remote draft');
      route = AppRoute.RemoteChat;
      expect(controller.visibleChatInput()).assertEqual('remote draft');
      expect(general.chatInput).assertEqual('');
      expect(remote.chatInput).assertEqual('remote draft');
    });

    it('clears voice state for every conversation surface on teardown', 0, () => {
      const general = new GeneralChatPageState();
      const remote = new RemotePageState();
      const controller = new ConversationController(
        general,
        remote,
        { currentRoute: (): AppRoute => AppRoute.RemoteChat }
      );
      controller.setVoiceListening(AppRoute.ChatHome, true);
      controller.setVoiceListening(AppRoute.RemoteChat, true);

      controller.clearAllVoiceListening();

      expect(general.isVoiceListening).assertFalse();
      expect(remote.isVoiceListening).assertFalse();
    });
  });

  describe('ConversationCoreState', () => {
    it('owns shared conversation data while keeping product surfaces isolated', 0, () => {
      const general = new ConversationCoreState('chat');
      const remote = new ConversationCoreState('code');
      general.setActiveSession({
        sessionId: 'general-core', title: 'General', workspacePath: '', agentType: 'code'
      });
      remote.setActiveSession({
        sessionId: 'remote-core', title: 'Remote', workspacePath: '/workspace', agentType: 'code'
      });
      general.setChatInput('general draft');
      remote.setChatInput('remote draft');
      general.setBusy(true);

      expect(general.activeSession.agentType).assertEqual('chat');
      expect(remote.activeSession.agentType).assertEqual('code');
      expect(general.chatInput).assertEqual('general draft');
      expect(remote.chatInput).assertEqual('remote draft');
      expect(remote.isBusy).assertFalse();

      general.clearActiveSession();
      expect(general.activeSession.sessionId).assertEqual('');
      expect(remote.activeSession.sessionId).assertEqual('remote-core');
      expect(remote.chatInput).assertEqual('remote draft');
    });
  });

  describe('GeneralChatPageState', () => {
    it('projects configuration, busy state, and status text', 0, () => {
      const state = new GeneralChatPageState();
      state.setConfiguration(
        'https://api.openbitfun.com',
        'deepseek-v4-flash',
        true,
        GeneralChatServiceState.Ready
      );
      state.setBusy(true);
      state.setStatus('Generating');

      expect(state.apiUrl).assertEqual('https://api.openbitfun.com');
      expect(state.modelName).assertEqual('deepseek-v4-flash');
      expect(state.hasApiKey).assertTrue();
      expect(state.serviceState).assertEqual(GeneralChatServiceState.Ready);
      expect(state.isBusy).assertTrue();
      expect(state.statusText).assertEqual('Generating');
    });

    it('owns a copied session list and returns it in recent order', 0, () => {
      const state = new GeneralChatPageState();
      const older = remoteSession('chat-older', 'Older chat');
      const newer = remoteSession('chat-newer', 'Newer chat');
      older.updatedAt = '2026-07-20T00:00:00.000Z';
      newer.updatedAt = '2026-07-21T00:00:00.000Z';
      const sessions = [older, newer];

      state.setSessions(sessions);
      sessions.length = 0;

      const recent = state.recentSessions();
      expect(state.sessions.length).assertEqual(2);
      expect(recent[0].id).assertEqual('chat-newer');
      expect(recent[1].id).assertEqual('chat-older');
    });

    it('owns active session and timeline projection copies', 0, () => {
      const state = new GeneralChatPageState();
      const userMessage = chatMessage('user-1', 'user', 'Plan the refactor');
      const pendingMessage = chatMessage('pending-1', 'user', 'Retry this');
      const activeTurn = activeChatMessage('turn-1', 'Working');
      const timelineItems: ChatTimelineItem[] = [{
        id: 'message-user-1',
        type: 'user_message',
        message: userMessage,
        isStreaming: false,
        isFinalizing: false
      }];

      state.setActiveSession({
        sessionId: 'chat-1',
        title: 'Architecture',
        workspacePath: '',
        agentType: 'chat'
      });
      state.setTimelineProjection([userMessage], [pendingMessage], activeTurn, true, timelineItems);
      timelineItems.length = 0;

      expect(state.activeSession.sessionId).assertEqual('chat-1');
      expect(state.activeSession.agentType).assertEqual('chat');
      expect(state.persistedMessages.length).assertEqual(1);
      expect(state.optimisticMessages.length).assertEqual(1);
      expect(state.timelineItems.length).assertEqual(1);
      expect(state.hasMoreMessages).assertTrue();
      expect(state.hasRunningActiveTurn()).assertTrue();
      expect(state.latestUserMessageText()).assertEqual('Retry this');
    });

    it('copies nested session projection and replaces streaming turn snapshots', 0, () => {
      const state = new GeneralChatPageState();
      const session: SessionSummary = {
        sessionId: 'chat-nested-1',
        title: 'Original title',
        workspacePath: '/must-not-leak',
        agentType: 'code',
        initialTurnId: 'turn-initial'
      };
      const firstTurn = activeChatMessage('turn-stream-1', 'Hel', 'active', 1);
      const secondTurn = activeChatMessage('turn-stream-1', 'Hello', 'active', 2);

      state.setActiveSession(session);
      session.sessionId = 'mutated-session';
      session.title = 'Mutated title';

      state.setTimelineProjection([], [], firstTurn, false, []);
      firstTurn.text = 'mutated first turn';
      state.setTimelineProjection([], [], secondTurn, false, []);

      expect(state.activeSession.sessionId).assertEqual('chat-nested-1');
      expect(state.activeSession.title).assertEqual('Original title');
      expect(state.activeSession.agentType).assertEqual('chat');
      expect(state.activeSession.workspacePath).assertEqual('/must-not-leak');
      expect(state.activeTurnMessage.text).assertEqual('Hello');
      expect(state.activeTurnMessage.renderVersion || 0).assertEqual(2);
      expect(state.hasRunningActiveTurn()).assertTrue();
    });

    it('retains observable timeline rows while streaming content changes', 0, () => {
      const state = new GeneralChatPageState();
      const firstMessage = activeChatMessage('turn-observable-1', '', 'active', 1);
      const firstItems: ChatTimelineItem[] = [{
        id: 'active-turn-observable-1',
        type: 'assistant_live_turn',
        message: firstMessage,
        isStreaming: true,
        isFinalizing: false
      }];

      state.setTimelineProjection([], [], firstMessage, false, firstItems);
      const retainedRow = state.timelineItems[0];
      const retainedMessage = retainedRow.message;

      state.setTimelineProjection([], [], firstMessage, false, firstItems);
      expect(state.timelineItems[0] === retainedRow).assertTrue();
      expect(state.timelineItems[0].message === retainedMessage).assertTrue();

      const completedMessage = activeChatMessage('turn-observable-1', 'UI NOW WORKS', 'completed', 2);
      const completedItems: ChatTimelineItem[] = [{
        id: 'active-turn-observable-1',
        type: 'assistant_live_turn',
        message: completedMessage,
        isStreaming: false,
        isFinalizing: true
      }];

      state.setTimelineProjection([], [], completedMessage, false, completedItems);

      expect(state.timelineItems[0] === retainedRow).assertTrue();
      expect(state.timelineItems[0].message?.text || '').assertEqual('UI NOW WORKS');
      expect(state.timelineItems[0].message?.status || '').assertEqual('completed');
      expect(state.timelineItems[0].isStreaming).assertFalse();
      expect(state.timelineItems[0].isFinalizing).assertTrue();
    });

    it('owns ordinary chat composer projection', 0, () => {
      const state = new GeneralChatPageState();
      const images = [selectedImage('general-image-1')];

      state.setChatInput('Draft text');
      state.setSelectedImages(images);
      state.setVoiceListening(true);
      images.length = 0;

      expect(state.chatInput).assertEqual('Draft text');
      expect(state.selectedImages.length).assertEqual(1);
      expect(state.isVoiceListening).assertTrue();

      state.removeSelectedImage('general-image-1');
      expect(state.selectedImages.length).assertEqual(0);

      state.clearComposer();
      state.setVoiceListening(false);
      expect(state.chatInput).assertEqual('');
      expect(state.selectedImages.length).assertEqual(0);
      expect(state.isVoiceListening).assertFalse();
    });
  });

  describe('RemotePageState', () => {
    it('does not invent a desktop identity before pairing', 0, () => {
      const state = new RemotePageState();

      expect(state.desktopName).assertEqual('');
      expect(state.desktopId).assertEqual('');
      expect(RemoteUiState.desktopNameFromRemoteUrl('openbitfun://pair?room=room-1')).assertEqual('');
      expect(RemoteUiState.desktopNameFromRemoteUrl('openbitfun://pair?room=room-1&dn=Developer%20Mac'))
        .assertEqual('Developer Mac');
    });

    it('projects connection summary and filters visible sessions', 0, () => {
      const state = new RemotePageState();
      state.setDesktopIdentity('Developer Mac', 'desktop-1');
      state.setPairingInput('https://relay.example.com/#/pair?room=abc', 'harmony-device', true);
      state.setAuthenticatedUserId('desktop-user');
      state.setStatusText('Connected');
      state.setConnectionState('connected');
      state.setConnectionFailureKind('');
      state.setBusy(true);
      state.setLoadingHome(true);
      state.setWorkspace('OpenBitFun', '/workspace/OpenBitFun', 'default', 'main', 'normal');
      state.setSessions([
        remoteSession('session-1', '/canvas draw architecture'),
        remoteSession('session-2', 'Write release notes'),
        remoteSession('session-3', '/canvas archived', 'archived'),
        remoteSession('', '/canvas invalid')
      ], true);
      state.setQuery('CANVAS');

      const visible = state.visibleSessions();
      expect(state.desktopName).assertEqual('Developer Mac');
      expect(state.desktopId).assertEqual('desktop-1');
      expect(state.remoteUrl).assertEqual('https://relay.example.com/#/pair?room=abc');
      expect(state.userId).assertEqual('harmony-device');
      expect(state.authenticatedUserId).assertEqual('desktop-user');
      expect(state.statusText).assertEqual('Connected');
      expect(state.connectionState).assertEqual('connected');
      expect(state.connectionFailureKind).assertEqual('');
      expect(state.isBusy).assertTrue();
      expect(state.isLoadingHome).assertTrue();
      expect(state.showRemoteUrlInput).assertTrue();
      expect(state.workspacePath).assertEqual('/workspace/OpenBitFun');
      expect(state.workspaceBranch).assertEqual('main');
      expect(state.workspaceKind).assertEqual('normal');
      expect(state.assistantId).assertEqual('default');
      expect(state.sessions.length).assertEqual(4);
      expect(state.hasMoreSessions).assertTrue();
      expect(visible.length).assertEqual(1);
      expect(visible[0].id).assertEqual('session-1');
    });

    it('clears loading errors on success and clears only list state on reset', 0, () => {
      const state = new RemotePageState();
      state.setDesktopName('Developer Mac');
      state.setWorkspace('OpenBitFun', '/workspace/OpenBitFun', 'default');
      state.setQuery('canvas');
      state.setLoading(true);
      state.setLoadingHome(true);
      state.setError('network failed');

      expect(state.isLoadingSessions).assertFalse();
      expect(state.sessionErrorText).assertEqual('network failed');

      state.setSessions([remoteSession('session-1', '/canvas')], false);
      expect(state.sessionErrorText).assertEqual('');
      state.clear();

      expect(state.sessions.length).assertEqual(0);
      expect(state.hasMoreSessions).assertFalse();
      expect(state.isLoadingSessions).assertFalse();
      expect(state.isLoadingHome).assertFalse();
      expect(state.sessionQuery).assertEqual('canvas');
      expect(state.desktopName).assertEqual('Developer Mac');
      expect(state.workspaceName).assertEqual('OpenBitFun');
    });

    it('owns active remote session, timeline projection, and model catalog', 0, () => {
      const state = new RemotePageState();
      const userMessage = chatMessage('remote-user-1', 'user', 'Run tests');
      const activeTurn = activeChatMessage('remote-turn-1', 'Running cargo test');
      const timelineItems: ChatTimelineItem[] = [{
        id: 'active-remote-turn-1-0',
        type: 'assistant_live_turn',
        message: activeTurn,
        isStreaming: true,
        isFinalizing: false
      }];
      const modelCatalog: RemoteModelCatalog = {
        version: 2,
        models: [{
          id: 'model-a',
          name: 'Model A',
          provider: 'local',
          base_url: 'https://model.example.com',
          model_name: 'model-a',
          enabled: true,
          capabilities: ['code']
        }],
        default_models: { primary: 'model-a' },
        session_model_id: 'model-a'
      };

      state.setActiveSession({
        sessionId: 'remote-1',
        title: 'Remote task',
        workspacePath: '/workspace/OpenBitFun',
        agentType: 'code'
      });
      state.setTimelineProjection([userMessage], [], activeTurn, false, timelineItems);
      state.setModelCatalog(modelCatalog, 'model-a');
      state.setConversationLoading(true);
      state.setPendingSessionId('remote-2');
      state.setConversationDismissed(true);
      timelineItems.length = 0;

      expect(state.activeSession.sessionId).assertEqual('remote-1');
      expect(state.activeSession.workspacePath).assertEqual('/workspace/OpenBitFun');
      expect(state.timelineItems.length).assertEqual(1);
      expect(state.hasRunningActiveTurn()).assertTrue();
      expect(state.modelCatalog.version).assertEqual(2);
      expect(state.selectedModelId).assertEqual('model-a');
      expect(state.isLoadingConversation).assertTrue();
      expect(state.pendingSessionId).assertEqual('remote-2');
      expect(state.isConversationDismissed).assertTrue();

      state.clearActiveSession();
      expect(state.pendingSessionId).assertEqual('');
      expect(state.isLoadingConversation).assertFalse();
      expect(state.isConversationDismissed).assertFalse();
    });

    it('copies nested remote session projection and replaces streaming turn snapshots', 0, () => {
      const state = new RemotePageState();
      const session: SessionSummary = {
        sessionId: 'remote-nested-1',
        title: 'Remote original',
        workspacePath: '/workspace/OpenBitFun',
        agentType: 'code',
        initialTurnId: 'remote-turn-initial'
      };
      const firstTurn = activeChatMessage('remote-stream-1', 'Run', 'active', 1);
      const secondTurn = activeChatMessage('remote-stream-1', 'Run tests', 'active', 2);
      const catalog = remoteModelCatalog('model-a');

      state.setActiveSession(session);
      session.sessionId = 'mutated-remote';
      session.workspacePath = '/mutated';

      state.setTimelineProjection([], [], firstTurn, false, []);
      firstTurn.text = 'mutated remote turn';
      state.setTimelineProjection([], [], secondTurn, false, []);
      state.setModelCatalog(catalog, 'model-a');
      catalog.models.length = 0;
      catalog.session_model_id = 'model-b';

      expect(state.activeSession.sessionId).assertEqual('remote-nested-1');
      expect(state.activeSession.workspacePath).assertEqual('/workspace/OpenBitFun');
      expect(state.activeSession.agentType).assertEqual('code');
      expect(state.activeTurnMessage.text).assertEqual('Run tests');
      expect(state.activeTurnMessage.renderVersion || 0).assertEqual(2);
      expect(state.modelCatalog.models.length).assertEqual(2);
      expect(state.modelCatalog.session_model_id || '').assertEqual('model-a');
      expect(state.selectedModelId).assertEqual('model-a');
      expect(state.hasRunningActiveTurn()).assertTrue();
    });

    it('owns remote download status projection', 0, () => {
      const state = new RemotePageState();

      state.setDownloadStatus('/workspace/OpenBitFun/README.md', '', '10 B / 20 B');
      expect(state.downloadingFilePath).assertEqual('/workspace/OpenBitFun/README.md');
      expect(state.downloadedFilePath).assertEqual('');
      expect(state.fileDownloadStatus).assertEqual('10 B / 20 B');

      state.setDownloadStatus('/workspace/OpenBitFun/README.md', '/workspace/OpenBitFun/README.md', '下载完成 README.md · 20 B');
      state.clearDownloadingFilePath();
      expect(state.downloadingFilePath).assertEqual('');
      expect(state.downloadedFilePath).assertEqual('/workspace/OpenBitFun/README.md');
      expect(state.fileDownloadStatus).assertEqual('下载完成 README.md · 20 B');

      state.clearDownloadStatus();
      expect(state.downloadingFilePath).assertEqual('');
      expect(state.downloadedFilePath).assertEqual('');
      expect(state.fileDownloadStatus).assertEqual('');
    });

    it('owns remote composer attachments and voice projection', 0, () => {
      const state = new RemotePageState();
      const first = selectedImage('remote-image-1');
      const second = selectedImage('remote-image-2');
      const images = [first];

      state.setChatInput('/canvas draw');
      state.setSelectedImages(images);
      state.addSelectedImages([second]);
      state.setVoiceListening(true);
      images.length = 0;

      expect(state.chatInput).assertEqual('/canvas draw');
      expect(state.selectedImages.length).assertEqual(2);
      expect(state.selectedImages[1].id).assertEqual('remote-image-2');
      expect(state.isVoiceListening).assertTrue();

      state.removeSelectedImage('remote-image-1');
      expect(state.selectedImages.length).assertEqual(1);
      expect(state.selectedImages[0].id).assertEqual('remote-image-2');

      state.clearComposer();
      state.setVoiceListening(false);
      expect(state.chatInput).assertEqual('');
      expect(state.selectedImages.length).assertEqual(0);
      expect(state.isVoiceListening).assertFalse();
    });

    it('owns copied workspace and assistant picker projections', 0, () => {
      const state = new RemotePageState();
      const workspaces: RecentWorkspaceEntry[] = [{
        path: '/workspace/OpenBitFun',
        name: 'OpenBitFun',
        lastOpened: '2026-07-21T00:00:00.000Z',
        workspaceKind: 'normal'
      }];
      const assistants: AssistantEntry[] = [{
        path: '/workspace/OpenBitFun/.openbitfun/assistants/default.md',
        name: 'Default',
        assistant_id: 'default'
      }];

      state.setRecentWorkspaces(workspaces);
      state.setAssistants(assistants);
      state.setWorkspacePickerVisible(true);
      state.setAssistantPickerVisible(true);
      workspaces.length = 0;
      assistants.length = 0;

      expect(state.recentWorkspaces.length).assertEqual(1);
      expect(state.assistants.length).assertEqual(1);
      expect(state.showWorkspacePicker).assertTrue();
      expect(state.showAssistantPicker).assertTrue();

      state.clearWorkspaceActions();
      expect(state.recentWorkspaces.length).assertEqual(0);
      expect(state.assistants.length).assertEqual(0);
      expect(state.showWorkspacePicker).assertFalse();
      expect(state.showAssistantPicker).assertFalse();
    });
  });

  describe('ConversationViewState', () => {
    it('projects remote and general state without page-level branching', 0, () => {
      const remote = new RemotePageState();
      remote.setConnectionState('connected');
      remote.setChatInput('remote draft');
      remote.setActiveSession({
        sessionId: 'remote-session', title: 'Remote', workspacePath: '/repo', agentType: 'code'
      });
      remote.setConversationLoading(true);
      const general = new GeneralChatPageState();
      general.setChatInput('general draft');
      general.setActiveSession({
        sessionId: 'general-session', title: 'General', workspacePath: '', agentType: 'chat'
      });

      const remoteProjection = ConversationViewState.project(AppRoute.RemoteChat, remote, general, '');
      expect(remoteProjection.surface).assertEqual(ChatSurface.Remote);
      expect(remoteProjection.chatInput).assertEqual('remote draft');
      expect(remoteProjection.activeSession.sessionId).assertEqual('');
      expect(remote.activeSession.sessionId).assertEqual('remote-session');
      expect(remoteProjection.isLoadingConversation).assertTrue();

      // A transcript still crossing the relay keeps the header: the pane knows
      // which conversation it is showing, only not yet what is in it. The
      // identity-unknown flag above is the one that blanks the title.
      remote.setConversationLoading(false);
      remote.setTranscriptLoading(true);
      const loadingTranscript = ConversationViewState.project(AppRoute.RemoteChat, remote, general, '');
      expect(loadingTranscript.isLoadingConversation).assertFalse();
      expect(loadingTranscript.isLoadingTranscript).assertTrue();
      expect(loadingTranscript.activeSession.sessionId).assertEqual('remote-session');

      // A pane with no session left is not waiting for one.
      remote.clearActiveSession();
      remote.setTranscriptLoading(true);
      expect(ConversationViewState.project(AppRoute.RemoteChat, remote, general, '').isLoadingTranscript).assertFalse();
      remote.setTranscriptLoading(false);
      remote.setActiveSession({
        sessionId: 'remote-session', title: 'Remote', workspacePath: '/workspace/OpenBitFun', agentType: 'code'
      });
      remote.setConversationLoading(true);

      const generalProjection = ConversationViewState.project(AppRoute.ChatHome, remote, general, 'Configure model');
      expect(generalProjection.surface).assertEqual(ChatSurface.General);
      expect(generalProjection.chatInput).assertEqual('general draft');
      expect(generalProjection.inlineStatusText).assertEqual('Configure model');
      expect(generalProjection.showSuggestionsWhenEmpty).assertFalse();
      expect(generalProjection.composerCapabilities.supportsAttachments).assertTrue();
      expect(generalProjection.composerCapabilities.showAddButton).assertTrue();
    });
  });

  describe('RemoteWorkspaceCoordinator', () => {
    it('does not publish a workspace catalog after its target changes', 0, async () => {
      const source = new FakeRemoteWorkspaceDataSource();
      source.recent = [{
        path: '/desk-a', name: 'Desk A', lastOpened: '', workspaceKind: 'normal'
      }];
      const state = new RemotePageState();
      let targetId = 'desk-a';
      const viewModel = new RemoteWorkspaceViewModel(
        state,
        new RemoteWorkspaceCoordinator(source),
        {
          isRemoteAvailable: (): boolean => true,
          remoteTargetId: (): string => targetId,
          isBusy: (): boolean => false,
          onBusy: (_busy: boolean): void => {},
          onStatus: (_status: string): void => {},
          onWorkspaceSelected: (_workspace: WorkspaceInfo): void => {},
          onCatalogLoading: (_targetId: string): void => {},
          onCatalogLoaded: (_targetId: string, _workspaces: RecentWorkspaceEntry[]): void => {},
          onCatalogFailed: (_targetId: string): void => {},
          onRefreshSessions: async (): Promise<void> => {},
          onConnectionFailure: (_error: Object): void => {}
        }
      );

      const loading = viewModel.loadRecentWorkspacesInBackground();
      targetId = 'desk-b';
      await loading;

      expect(state.recentWorkspaces.length).assertEqual(0);
    });

    it('deduplicates sessions discovered across recent workspaces', 0, async () => {
      const source = new FakeRemoteWorkspaceDataSource();
      source.sessionsByPath.set('/one', [
        remoteSession('shared-session', 'Shared'),
        remoteSession('one-session', 'One')
      ]);
      source.sessionsByPath.set('/two', [
        remoteSession('shared-session', 'Shared again'),
        remoteSession('two-session', 'Two')
      ]);
      const coordinator = new RemoteWorkspaceCoordinator(source);

      const sessions = await coordinator.sessionsForWorkspaces([{ path: '/one' }, { path: '/two' }]);
      expect(sessions.length).assertEqual(3);
      expect(sessions[0].id).assertEqual('shared-session');
      expect(sessions[1].id).assertEqual('one-session');
      expect(sessions[2].id).assertEqual('two-session');
    });

    // Listings run several at a time, so the result can no longer be read off
    // the order they happened to finish in.
    it('keeps results in path order across concurrency batches', 0, async () => {
      const source = new FakeRemoteWorkspaceDataSource();
      const workspaces: RemoteWorkspaceIdentity[] = [];
      for (let index = 0; index < 9; index++) {
        const path = `/workspace-${index}`;
        workspaces.push({ path });
        source.sessionsByPath.set(path, [remoteSession(`session-${index}`, `Session ${index}`)]);
      }
      const coordinator = new RemoteWorkspaceCoordinator(source);

      const sessions = await coordinator.sessionsForWorkspaces(workspaces);
      expect(sessions.length).assertEqual(9);
      expect(sessions[0].id).assertEqual('session-0');
      expect(sessions[4].id).assertEqual('session-4');
      expect(sessions[8].id).assertEqual('session-8');
      expect(source.listedPaths.length).assertEqual(9);
    });

    it('keeps the other workspaces when one of them cannot be listed', 0, async () => {
      const source = new FakeRemoteWorkspaceDataSource();
      source.sessionsByPath.set('/one', [remoteSession('one-session', 'One')]);
      source.sessionsByPath.set('/three', [remoteSession('three-session', 'Three')]);
      source.failingPaths = ['/two'];
      const coordinator = new RemoteWorkspaceCoordinator(source);

      const sessions = await coordinator.sessionsForWorkspaces([{ path: '/one' }, { path: '/two' }, { path: '/three' }]);
      expect(sessions.length).assertEqual(2);
      expect(sessions[0].id).assertEqual('one-session');
      expect(sessions[1].id).assertEqual('three-session');
    });

    it('lists identified workspaces by their ID rather than their display path', 0, async () => {
      const source = new FakeRemoteWorkspaceDataSource();
      source.sessionsByPath.set('ws-1', [remoteSession('by-id', 'By ID')]);
      source.sessionsByPath.set('/renamed', [remoteSession('by-path', 'By path')]);
      const coordinator = new RemoteWorkspaceCoordinator(source);

      const sessions = await coordinator.sessionsForWorkspaces([{ workspaceId: 'ws-1', path: '/renamed' }]);
      expect(sessions.length).assertEqual(1);
      expect(sessions[0].id).assertEqual('by-id');
      expect(source.listedPaths.join(',')).assertEqual('ws-1');
      await coordinator.switchAssistant('', 'ws-2');
      expect(source.lastSetAssistantId || '').assertEqual('ws-2');
    });
  });

  describe('ProductSurfaceIsolation', () => {
    it('keeps ordinary chat and remote chat page state isolated', 0, () => {
      const general = new GeneralChatPageState();
      const remote = new RemotePageState();
      const generalMessage = chatMessage('general-user-1', 'user', 'Local chat only');
      const remoteMessage = chatMessage('remote-user-1', 'user', 'Remote task only');

      general.setActiveSession({
        sessionId: 'general-1',
        title: 'General chat',
        workspacePath: '/should-not-leak',
        agentType: 'code'
      });
      remote.setActiveSession({
        sessionId: 'remote-1',
        title: 'Remote chat',
        workspacePath: '/workspace/OpenBitFun',
        agentType: 'code'
      });
      general.setTimelineProjection([generalMessage], [], RemoteUiState.emptyActiveTurn(), false, [{
        id: 'general-item-1',
        type: 'user_message',
        message: generalMessage,
        isStreaming: false,
        isFinalizing: false
      }]);
      remote.setTimelineProjection([remoteMessage], [], RemoteUiState.emptyActiveTurn(), false, [{
        id: 'remote-item-1',
        type: 'user_message',
        message: remoteMessage,
        isStreaming: false,
        isFinalizing: false
      }]);

      expect(general.activeSession.agentType).assertEqual('chat');
      expect(remote.activeSession.agentType).assertEqual('code');
      expect(general.persistedMessages[0].id).assertEqual('general-user-1');
      expect(remote.persistedMessages[0].id).assertEqual('remote-user-1');

      general.clearActiveSession();

      expect(general.activeSession.sessionId).assertEqual('');
      expect(general.persistedMessages.length).assertEqual(0);
      expect(remote.activeSession.sessionId).assertEqual('remote-1');
      expect(remote.activeSession.workspacePath).assertEqual('/workspace/OpenBitFun');
      expect(remote.persistedMessages.length).assertEqual(1);
    });

    it('keeps streaming turn projections isolated across product surfaces', 0, () => {
      const general = new GeneralChatPageState();
      const remote = new RemotePageState();
      const generalTurn = activeChatMessage('general-live-1', 'General partial', 'active', 1);
      const remoteTurn = activeChatMessage('remote-live-1', 'Remote partial', 'active', 1);

      general.setTimelineProjection([], [], generalTurn, false, [{
        id: 'general-live-item',
        type: 'assistant_live_turn',
        message: generalTurn,
        isStreaming: true,
        isFinalizing: false
      }]);
      remote.setTimelineProjection([], [], remoteTurn, false, [{
        id: 'remote-live-item',
        type: 'assistant_live_turn',
        message: remoteTurn,
        isStreaming: true,
        isFinalizing: false
      }]);

      expect(general.activeTurnMessage.id).assertEqual('active-general-live-1');
      expect(remote.activeTurnMessage.id).assertEqual('active-remote-live-1');
      expect(general.timelineItems[0].id).assertEqual('general-live-item');
      expect(remote.timelineItems[0].id).assertEqual('remote-live-item');

      general.clearTimeline();

      expect(general.hasRunningActiveTurn()).assertFalse();
      expect(general.timelineItems.length).assertEqual(0);
      expect(remote.hasRunningActiveTurn()).assertTrue();
      expect(remote.activeTurnMessage.text).assertEqual('Remote partial');
      expect(remote.timelineItems.length).assertEqual(1);
    });
  });

  describe('DurableSessionRecordReduction', () => {
    it('keeps the turn record user message when a child repeats it as a header', 0, () => {
      const reducer = new DurableSessionReducer();
      const metadata: DurableUserMetadata = {
        images: [{ name: 'shot.png', data_url: 'data:image/png;base64,AA' } as ImageAttachment]
      };
      const turnRecord: SessionRecord = {
        sessionId: 'session', id: 'turn/turn', revision: 1,
        turn: {
          sessionId: 'session', turnId: 'turn', turnIndex: 0, timestamp: 1, status: 'inprogress',
          userMessage: { id: 'user', content: 'look at this', timestamp: 1, metadata: metadata }
        }
      };
      reducer.apply({ session_id: 'session', event: 'session-record', payload: turnRecord });
      expect((reducer.messages()[0].images || []).length).assertEqual(1);

      // The round and item records repeat the turn only as a parent header, and
      // that copy carries the attachment as it was recorded rather than the
      // pixels the turn record was given. It must not replace the turn.
      reducer.apply(durableRecord('session', 5, 'on it'));
      const reduced = reducer.messages();
      expect(reduced[0].text).assertEqual('look at this');
      expect((reduced[0].images || []).length).assertEqual(1);
      expect((reduced[0].images || [])[0].data_url).assertEqual('data:image/png;base64,AA');
      expect(reduced[1].text).assertEqual('on it');
    });
  });
}
