import { WorkspaceCatalog, mergeLegacyWorkspaces } from '../main/ets/services/WorkspaceCatalog';
import { HostSessionStream, HostSessionCallbacks, HostSessionEvent, HostSessionSource, HostStreamPage } from '../main/ets/services/HostSessionStream';
import { SessionRecord } from '../main/ets/services/DurableSessionReducer';
import { SavedRuntimeConnection } from '../main/ets/model/RemoteModels';
import { describe, it, expect } from '@ohos/hypium';
import { RemoteI18n } from '../main/ets/i18n/RemoteI18n';
import { ChatSessionController, ChatSessionSnapshot } from '../main/ets/services/ChatSessionController';
import { ChatComposerPolicy } from '../main/ets/services/ChatComposerPolicy';
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
import {
  RemoteChatCache,
  RemoteChatCacheSlice,
  RemoteChatCacheStore
} from '../main/ets/services/RemoteChatCache';
import { RemoteChatCommandClient, RemoteChatCommandController } from '../main/ets/services/RemoteChatCommandController';
import {
  RemoteSessionListCache,
  RemoteSessionListSlice,
  RemoteSessionListStore
} from '../main/ets/services/RemoteSessionListCache';
import { RemoteChatPollingLifecycleController } from '../main/ets/services/RemoteChatPollingLifecycleController';
import {
  RemoteFileDownloadClient,
  RemoteFileDownloadController,
  RemoteFileDownloadScheduler,
  RemoteFileSaver
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
  ReadFileChunkResult,
  ReadFileResult,
  RemoteSession,
  RemoteWorkspaceIdentity,
  SelectedImageAttachment,
  SteerTurnResult,
  SessionListResult,
  SessionMessagesResult,
  SessionSummary,
  WorkspaceInfo
} from '../main/ets/model/RemoteModels';

export interface ToolInputFixture {
  safe: boolean;
}

export interface CryptoImageFixture {
  id: string;
  data_url: string;
  mime_type: string;
}

export interface CryptoCommandFixture {
  cmd: string;
  session_id: string;
  content: string;
  agent_type: string;
  image_contexts: CryptoImageFixture[];
}

export interface CryptoSimpleCommandFixture {
  cmd: string;
}

export interface GeneralChatRecordedRequest {
  url: string;
  method: GeneralChatHttpMethod;
  authorization: string;
  body: string;
}

export class FakeRemoteWorkspaceDataSource implements RemoteWorkspaceDataSource {
  async savedConnections(): Promise<SavedRuntimeConnection[]> { return []; }
  recent: RecentWorkspaceEntry[] = [];
  sessionsByPath: Map<string, RemoteSession[]> = new Map<string, RemoteSession[]>();
  /** Paths whose listing rejects, for the workspace a desktop cannot read. */
  failingPaths: string[] = [];
  /** Every path listed, in the order the listings were started. */
  listedPaths: string[] = [];

  async listWorkspaceCatalog(): Promise<WorkspaceCatalog> {
    const recent = await this.listRecentWorkspaces();
    return { workspaces: mergeLegacyWorkspaces(recent, await this.listAssistants()), recentWorkspaces: recent, source: 'recent' };
  }

  async listRecentWorkspaces(): Promise<RecentWorkspaceEntry[]> {
    return this.recent;
  }

  /** The last identified selection, so tests can assert IDs reach the data source. */
  lastSetWorkspaceId: string | undefined = undefined;
  lastSetAssistantId: string | undefined = undefined;

  async setWorkspace(_path: string, _connectionId?: string, _sshHost?: string, workspaceId?: string): Promise<WorkspaceInfo> {
    this.lastSetWorkspaceId = workspaceId;
    return {
      workspaceId: workspaceId,
      name: 'workspace', path: '/workspace', hasWorkspace: true,
      gitBranch: 'main', workspaceKind: 'normal', assistantId: ''
    };
  }

  async listAssistants(): Promise<AssistantEntry[]> {
    return [];
  }

  async setAssistant(_path: string, workspaceId?: string): Promise<WorkspaceInfo> {
    this.lastSetAssistantId = workspaceId;
    return {
      workspaceId: workspaceId,
      name: 'assistant', path: '/assistant', hasWorkspace: true,
      gitBranch: '', workspaceKind: 'assistant', assistantId: 'assistant'
    };
  }

  /** Rows with an ID are looked up by ID; pre-ID rows by their path. */
  async listSessionsForWorkspace(workspace: RemoteWorkspaceIdentity, _limit: number): Promise<RemoteSession[]> {
    const key = workspace.workspaceId ? workspace.workspaceId : workspace.path;
    this.listedPaths.push(key);
    if (this.failingPaths.includes(key)) {
      throw new Error(`workspace unavailable: ${key}`);
    }
    return this.sessionsByPath.get(key) || [];
  }

  async ping(): Promise<void> {
  }

  reset(): void {
  }
}

export class FakeRemoteCryptoCipher implements RemoteCryptoCipher {
  async encrypt(plainBytes: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(plainBytes.length + 16);
    for (let index = 0; index < plainBytes.length; index++) {
      out[index] = plainBytes[index] ^ key[index % key.length] ^ nonce[index % nonce.length];
    }
    for (let index = 0; index < 16; index++) {
      out[plainBytes.length + index] = key[index] ^ nonce[index % nonce.length] ^ 165;
    }
    return out;
  }

  async decrypt(encryptedBytes: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
    if (encryptedBytes.length < 16) {
      throw new Error('Encrypted payload is too short.');
    }
    const plainLength = encryptedBytes.length - 16;
    const out = new Uint8Array(plainLength);
    for (let index = 0; index < plainLength; index++) {
      out[index] = encryptedBytes[index] ^ key[index % key.length] ^ nonce[index % nonce.length];
    }
    return out;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  const alphabet = '0123456789abcdef';
  let text = '';
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index];
    text += alphabet.charAt((value >> 4) & 15) + alphabet.charAt(value & 15);
  }
  return text;
}

export function fixedRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    bytes[index] = (index * 17 + 29) & 255;
  }
  return bytes;
}

export function expectCommandJson(command: Object, expected: string): void {
  expect(JSON.stringify(command)).assertEqual(expected);
}

export function connectedPeers(): RemoteCrypto[] {
  const cipher = new FakeRemoteCryptoCipher();
  const alicePrivate = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bobPrivate = hexToBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  const alice = new RemoteCrypto({
    cipher,
    keyPair: {
      privateKey: alicePrivate,
      publicKey: X25519.scalarMultBase(alicePrivate)
    },
    randomBytes: fixedRandomBytes
  });
  const bob = new RemoteCrypto({
    cipher,
    keyPair: {
      privateKey: bobPrivate,
      publicKey: X25519.scalarMultBase(bobPrivate)
    },
    randomBytes: fixedRandomBytes
  });
  alice.deriveSharedKey(bob.getPublicKeyBase64());
  bob.deriveSharedKey(alice.getPublicKeyBase64());
  return [alice, bob];
}

export function chatMessage(id: string, role: string, text: string, status: string = 'completed'): ChatMessage {
  return {
    id,
    role,
    text,
    status,
    detail: ''
  };
}

export function remoteSession(id: string, title: string, status: string = 'active'): RemoteSession {
  return {
    id,
    title,
    agentType: 'code',
    status,
    updatedAt: '2026-07-21T00:00:00.000Z',
    createdAt: '2026-07-21T00:00:00.000Z',
    messageCount: 1
  };
}

export function selectedImage(id: string): SelectedImageAttachment {
  return {
    id,
    uri: `file:///tmp/${id}.png`,
    name: `${id}.png`,
    data_url: 'data:image/png;base64,AA==',
    mime_type: 'image/png',
    size: 2,
    original_size: 2,
    compressed: false
  };
}

export function remoteModelCatalog(sessionModelId: string = ''): RemoteModelCatalog {
  return {
    version: 2,
    models: [{
      id: 'model-a',
      name: 'Model A',
      provider: 'local',
      base_url: 'https://model.example.com',
      model_name: 'model-a',
      enabled: true,
      capabilities: ['code']
    }, {
      id: 'model-b',
      name: 'Model B',
      provider: 'local',
      base_url: 'https://model.example.com',
      model_name: 'model-b',
      enabled: true,
      capabilities: ['code']
    }],
    default_models: { primary: 'model-a' },
    session_model_id: sessionModelId
  };
}

export function activeChatMessage(turnId: string, text: string, status: string = 'active', renderVersion: number = 0): ChatMessage {
  const message = chatMessage(`active-${turnId}`, 'assistant', text, status);
  message.turnId = turnId;
  message.renderVersion = renderVersion;
  return message;
}

export function chatMessageWithImage(id: string, role: string, text: string, imageName: string, imageDataUrl: string): ChatMessage {
  return {
    id,
    role,
    text,
    status: 'completed',
    detail: '',
    images: [imageAttachment(imageName, imageDataUrl)]
  };
}

export function imageAttachment(name: string, dataUrl: string): ImageAttachment {
  return {
    name,
    data_url: dataUrl
  };
}

export function pollResult(options: PollSessionResult): PollSessionResult {
  return options;
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export class FakePollSessionManager extends RemoteSessionManager {
  results: PollSessionResult[] = [];

  async pollSession(
    _sessionId: string,
    _sinceVersion: number,
    _knownMessageCount: number,
    _knownModelCatalogVersion: number
  ): Promise<PollSessionResult> {
    const next = this.results.shift();
    if (!next) {
      throw new Error('Missing fake poll result.');
    }
    return next;
  }
}

export class BlockingPollSessionManager extends RemoteSessionManager {
  private resolver?: (result: PollSessionResult) => void;

  async pollSession(
    _sessionId: string,
    _sinceVersion: number,
    _knownMessageCount: number,
    _knownModelCatalogVersion: number
  ): Promise<PollSessionResult> {
    return new Promise<PollSessionResult>((resolve: (result: PollSessionResult) => void) => {
      this.resolver = resolve;
    });
  }

  resolve(result: PollSessionResult): void {
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve(result);
    }
  }
}

export class FakeGeneralChatLocalStore implements GeneralChatLocalStore, GeneralChatDraftStore {
  sessions: RemoteSession[] = [];
  messagesBySession: Map<string, ChatMessage[]> = new Map<string, ChatMessage[]>();
  drafts: Map<string, string> = new Map<string, string>();

  async init(_context: Context): Promise<void> {}

  async listSessions(): Promise<RemoteSession[]> {
    return this.sessions.slice();
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    return (this.messagesBySession.get(sessionId) || []).slice();
  }

  async upsertSession(session: RemoteSession): Promise<void> {
    this.sessions = [session].concat(this.sessions.filter((item: RemoteSession) => item.id !== session.id));
  }

  async replaceMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    this.messagesBySession.set(sessionId, messages.slice());
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions = this.sessions.filter((item: RemoteSession) => item.id !== sessionId);
    this.messagesBySession.delete(sessionId);
    this.drafts.delete(sessionId);
  }

  async loadDraft(draftId: string): Promise<string> {
    return this.drafts.get(draftId) || '';
  }

  async draft(draftId: string): Promise<string> {
    return this.loadDraft(draftId);
  }

  async saveDraft(draftId: string, text: string): Promise<void> {
    this.drafts.set(draftId, text);
  }

  async deleteDraft(draftId: string): Promise<void> {
    this.drafts.delete(draftId);
  }

  async clearDraft(draftId: string): Promise<void> {
    await this.deleteDraft(draftId);
  }
}

export class FailingGeneralChatAdapter extends MockGeneralChatAdapter {
  async sendMessage(
    _sessionId: string,
    text: string,
    _images: ImageAttachment[] = [],
    _history: ChatMessage[] = [],
    observer?: GeneralChatStreamObserver
  ): Promise<GeneralChatSendResult> {
    const userMessage = chatMessage('failed-user', 'user', text, 'pending');
    if (observer) {
      await observer.onUserMessage(userMessage);
    }
    throw new Error('Expected test failure.');
  }
}

export class PartialFailingGeneralChatAdapter extends MockGeneralChatAdapter {
  async sendMessage(
    _sessionId: string,
    text: string,
    _images: ImageAttachment[] = [],
    _history: ChatMessage[] = [],
    observer?: GeneralChatStreamObserver
  ): Promise<GeneralChatSendResult> {
    const userMessage = chatMessage('partial-user', 'user', text, 'pending');
    if (observer) {
      await observer.onUserMessage(userMessage);
      observer.onDelta('partial');
    }
    throw new Error('Expected interrupted stream.');
  }
}

export class FakeGeneralChatTokenProvider implements GeneralChatTokenProvider {
  token: string = 'test-token';

  async accessToken(): Promise<string> {
    return this.token;
  }
}

export class FakeGeneralChatHttpTransport implements GeneralChatHttpTransport {
  responses: GeneralChatHttpResponse[] = [];
  requests: GeneralChatRecordedRequest[] = [];

  async request(
    url: string,
    method: GeneralChatHttpMethod,
    headers: GeneralChatHttpHeaders,
    body?: string
  ): Promise<GeneralChatHttpResponse> {
    this.requests.push({
      url,
      method,
      authorization: headers.authorization,
      body: body || ''
    });
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Missing fake general chat HTTP response.');
    }
    return response;
  }
}

export class FakeRemoteHeartbeatScheduler implements RemoteHeartbeatScheduler {
  callbacks: Map<number, () => void> = new Map<number, () => void>();
  intervals: Map<number, number> = new Map<number, number>();
  clearedIds: number[] = [];
  nextId: number = 1;

  setInterval(callback: () => void, intervalMs: number): number {
    const timerId = this.nextId;
    this.nextId += 1;
    this.callbacks.set(timerId, callback);
    this.intervals.set(timerId, intervalMs);
    return timerId;
  }

  clearInterval(timerId: number): void {
    this.clearedIds.push(timerId);
    this.callbacks.delete(timerId);
    this.intervals.delete(timerId);
  }

  tick(timerId: number): void {
    const callback = this.callbacks.get(timerId);
    if (callback) {
      callback();
    }
  }
}

export class FakeGeneralChatDraftScheduler implements GeneralChatDraftScheduler {
  callbacks: Map<number, () => void> = new Map<number, () => void>();
  delays: Map<number, number> = new Map<number, number>();
  clearedIds: number[] = [];
  nextId: number = 1;

  setTimeout(callback: () => void, delayMs: number): number {
    const timerId = this.nextId;
    this.nextId += 1;
    this.callbacks.set(timerId, callback);
    this.delays.set(timerId, delayMs);
    return timerId;
  }

  clearTimeout(timerId: number): void {
    this.clearedIds.push(timerId);
    this.callbacks.delete(timerId);
    this.delays.delete(timerId);
  }

  tick(timerId: number): void {
    const callback = this.callbacks.get(timerId);
    if (callback) {
      callback();
      this.callbacks.delete(timerId);
      this.delays.delete(timerId);
    }
  }
}

export class FakeVoiceInputLifecycleService extends VoiceInputService {
  startRequests: number = 0;
  stopRequests: number = 0;
  cancelRequests: number = 0;
  shouldFailStart: boolean = false;
  shouldFailStop: boolean = false;
  fakeListening: boolean = false;
  fakeCallbacks?: VoiceInputCallbacks;

  isListening(): boolean {
    return this.fakeListening;
  }

  async start(_context: Context, callbacks: VoiceInputCallbacks): Promise<void> {
    this.startRequests += 1;
    if (this.shouldFailStart) {
      throw new Error('Expected voice start failure.');
    }
    this.fakeCallbacks = callbacks;
    this.fakeListening = true;
    callbacks.onState?.('listening');
  }

  async stop(): Promise<void> {
    this.stopRequests += 1;
    if (this.shouldFailStop) {
      throw new Error('Expected voice stop failure.');
    }
    this.fakeListening = false;
    this.fakeCallbacks?.onState?.('idle');
  }

  async cancel(): Promise<void> {
    this.cancelRequests += 1;
    this.fakeListening = false;
    this.fakeCallbacks?.onState?.('idle');
  }

  emitText(text: string, isFinal: boolean): void {
    this.fakeCallbacks?.onText(text, isFinal);
  }

  emitError(message: string): void {
    this.fakeCallbacks?.onError?.(message);
  }
}

export class FakeRemoteFileDownloadScheduler implements RemoteFileDownloadScheduler {
  callbacks: Map<number, () => void> = new Map<number, () => void>();
  delays: Map<number, number> = new Map<number, number>();
  clearedIds: number[] = [];
  nextId: number = 1;

  setTimeout(callback: () => void, delayMs: number): number {
    const timerId = this.nextId;
    this.nextId += 1;
    this.callbacks.set(timerId, callback);
    this.delays.set(timerId, delayMs);
    return timerId;
  }

  clearTimeout(timerId: number): void {
    this.clearedIds.push(timerId);
    this.callbacks.delete(timerId);
    this.delays.delete(timerId);
  }

  tick(timerId: number): void {
    const callback = this.callbacks.get(timerId);
    if (callback) {
      callback();
      this.callbacks.delete(timerId);
      this.delays.delete(timerId);
    }
  }
}

export class FakeRemoteFileDownloadClient implements RemoteFileDownloadClient {
  infoRequests: string[] = [];
  readRequests: string[] = [];
  shouldFailRead: boolean = false;
  fileInfo: FileInfo = {
    name: 'README.md',
    size: 4096,
    mimeType: 'text/plain'
  };
  chunkResult: ReadFileChunkResult = {
    name: 'README.md',
    contentBase64: 'cmVhZG1l',
    offset: 0,
    chunkSize: 6,
    totalSize: 6,
    mimeType: 'text/plain'
  };
  fileReadResult: ReadFileResult = {
    name: 'README.md',
    contentBase64: 'cmVhZG1l',
    mimeType: 'text/plain',
    size: 4096
  };

  async streamFile(path: string, sessionId: string | undefined, onChunk: (bytes: Uint8Array, info: FileInfo) => Promise<void>, onProgress?: (downloaded: number, total: number) => void): Promise<FileInfo> {
    this.readRequests.push(`${path}|${sessionId}`);
    if (this.shouldFailRead) throw new Error('Expected download failure.');
    await onChunk(new Uint8Array([1,2,3]), this.fileInfo);
    if (onProgress) onProgress(this.fileInfo.size, this.fileInfo.size);
    return this.fileInfo;
  }

  async getFileInfo(path: string, sessionId?: string): Promise<FileInfo> {
    this.infoRequests.push(`${path}|${sessionId || ''}`);
    return this.fileInfo;
  }

  async readFile(
    path: string,
    sessionId?: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<ReadFileResult> {
    this.readRequests.push(`${path}|${sessionId || ''}`);
    if (onProgress) {
      onProgress(2048, 4096);
    }
    if (this.shouldFailRead) {
      throw new Error('Expected download failure.');
    }
    return this.fileReadResult;
  }

  async readFileChunk(
    path: string,
    offset: number,
    limit: number,
    sessionId?: string
  ): Promise<ReadFileChunkResult> {
    this.readRequests.push(`${path}|${sessionId || ''}|${offset}|${limit}`);
    if (this.shouldFailRead) {
      throw new Error('Expected download failure.');
    }
    return {
      name: this.chunkResult.name,
      contentBase64: this.chunkResult.contentBase64,
      offset,
      chunkSize: this.chunkResult.chunkSize,
      totalSize: this.chunkResult.totalSize,
      mimeType: this.chunkResult.mimeType
    };
  }
}

export class RemoteDownloadStatusRecord {
  downloadingFilePath: string = '';
  downloadedFilePath: string = '';
  fileDownloadStatus: string = '';
}

export class FakeRemoteFileSaver implements RemoteFileSaver {
  savedNames: string[] = [];

  async begin(name: string): Promise<void> { this.savedNames.push(name); }
  async write(_bytes: Uint8Array): Promise<void> {}
  async finish(): Promise<string> { return `test://${this.savedNames[this.savedNames.length - 1]}`; }
  async abort(): Promise<void> {}
}

export class FakeRemoteToolActionClient implements RemoteToolActionClient {
  actions: string[] = [];
  shouldFail: boolean = false;

  async confirmTool(toolId: string, updatedInput?: Object): Promise<void> {
    this.actions.push(`confirm:${toolId}:${JSON.stringify(updatedInput || {})}`);
    this.failIfNeeded();
  }

  async rejectTool(toolId: string, reason: string): Promise<void> {
    this.actions.push(`reject:${toolId}:${reason}`);
    this.failIfNeeded();
  }

  async cancelTool(toolId: string, reason: string): Promise<void> {
    this.actions.push(`cancel:${toolId}:${reason}`);
    this.failIfNeeded();
  }

  async answerQuestion(toolId: string, answers: RemoteQuestionAnswerPayload): Promise<void> {
    this.actions.push(`answer:${toolId}:${JSON.stringify(answers)}`);
    this.failIfNeeded();
  }

  private failIfNeeded(): void {
    if (this.shouldFail) {
      throw new Error('Expected tool action failure.');
    }
  }
}

export class FakeRemoteModelClient implements RemoteModelClient {
  catalog: RemoteModelCatalog = remoteModelCatalog();
  catalogRequests: string[] = [];
  modelSelections: string[] = [];
  selectedModelId: string = 'model-b';
  shouldFailCatalog: boolean = false;
  shouldFailSelect: boolean = false;

  async getModelCatalog(sessionId?: string): Promise<RemoteModelCatalog> {
    this.catalogRequests.push(sessionId || '');
    if (this.shouldFailCatalog) {
      throw new Error('Expected catalog failure.');
    }
    return this.catalog;
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<string> {
    this.modelSelections.push(`${sessionId}:${modelId}`);
    if (this.shouldFailSelect) {
      throw new Error('Expected model selection failure.');
    }
    return this.selectedModelId;
  }
}

export class FakeRemoteModelPreferenceStore implements RemoteModelPreferenceStore {
  savedModelIds: string[] = [];

  async saveLastModelId(modelId: string): Promise<void> {
    this.savedModelIds.push(modelId);
  }
}

export class RemoteModelProjectionRecord {
  version: number = 0;
  selectedModelId: string = '';
  sessionModelId: string = '';
  modelCount: number = 0;
}

export class FakeRemoteSessionClient implements RemoteSessionClient {
  listResults: SessionListResult[] = [];
  listRequests: string[] = [];
  createRequests: string[] = [];
  deleteRequests: string[] = [];
  createdSession: SessionSummary = {
    sessionId: 'created-session',
    title: 'Created Session',
    workspacePath: '/workspace',
    agentType: 'code'
  };
  shouldFailList: boolean = false;
  shouldFailCreate: boolean = false;
  shouldFailDelete: boolean = false;
  emitAllocationBeforeCreateReturn: boolean = false;

  async listSessions(limit: number, offset: number, query: string, agentType: string): Promise<SessionListResult> {
    this.listRequests.push(`${limit}:${offset}:${query}:${agentType}`);
    if (this.shouldFailList) {
      throw new Error('Expected session list failure.');
    }
    const result = this.listResults.shift();
    if (!result) {
      throw new Error('Missing fake session list result.');
    }
    return result;
  }

  async createSession(
    options: CreateSessionOptions,
    onAllocated?: (session: SessionSummary) => Promise<void>
  ): Promise<SessionSummary> {
    this.createRequests.push(
      `${options.agentType}:${options.title}:${options.instruction}:${options.workspacePath || ''}`
    );
    if (this.shouldFailCreate) {
      throw new Error('Expected session create failure.');
    }
    if (this.emitAllocationBeforeCreateReturn && onAllocated) {
      await onAllocated({
        sessionId: this.createdSession.sessionId,
        title: this.createdSession.title,
        workspacePath: this.createdSession.workspacePath,
        agentType: this.createdSession.agentType
      });
    }
    return this.createdSession;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteRequests.push(sessionId);
    if (this.shouldFailDelete) {
      throw new Error('Expected session delete failure.');
    }
  }
}

export class RemoteSessionProjectionRecord {
  sessions: RemoteSession[] = [];
  hasMore: boolean = false;
}

export class FakeRemoteChatCommandClient implements RemoteChatCommandClient {
  messageResults: SessionMessagesResult[] = [];
  messageRequests: string[] = [];
  messageResolvers: Array<(result: SessionMessagesResult) => void> = [];
  sendRequests: string[] = [];
  sendTurnIds: string[] = [];
  buildPlanRequests: string[] = [];
  steerRequests: string[] = [];
  cancelRequests: string[] = [];
  renameRequests: string[] = [];
  turnId: string = 'turn-1';
  shouldFailMessages: boolean = false;
  deferMessages: boolean = false;
  shouldFailSend: boolean = false;
  shouldFailCancel: boolean = false;
  shouldFailRename: boolean = false;

  async getSessionMessages(sessionId: string): Promise<SessionMessagesResult> {
    this.messageRequests.push(sessionId);
    if (this.shouldFailMessages) {
      throw new Error('Expected message load failure.');
    }
    if (this.deferMessages) {
      return new Promise<SessionMessagesResult>((resolve: (result: SessionMessagesResult) => void) => {
        this.messageResolvers.push(resolve);
      });
    }
    const result = this.messageResults.shift();
    if (!result) {
      throw new Error('Missing fake session messages result.');
    }
    return result;
  }

  resolveNextMessages(result: SessionMessagesResult): void {
    const resolve = this.messageResolvers.shift();
    if (!resolve) {
      throw new Error('Missing deferred message request.');
    }
    resolve(result);
  }

  async sendMessage(sessionId: string, text: string, agentType?: string, turnId?: string): Promise<string> {
    this.sendRequests.push(`text:${sessionId}:${text}:${agentType || ''}`);
    this.sendTurnIds.push(turnId || '');
    if (this.shouldFailSend) {
      throw new Error('Expected send failure.');
    }
    return this.turnId;
  }

  async sendMessageWithImages(
    sessionId: string,
    text: string,
    agentType: string,
    imageContexts: RemoteImageContext[],
    turnId?: string
  ): Promise<string> {
    this.sendRequests.push(`images:${sessionId}:${text}:${agentType}:${imageContexts.length}`);
    this.sendTurnIds.push(turnId || '');
    if (this.shouldFailSend) {
      throw new Error('Expected send failure.');
    }
    return this.turnId;
  }

  async steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    displayContent: string,
    imageContexts: RemoteImageContext[]
  ): Promise<SteerTurnResult> {
    this.steerRequests.push(`${sessionId}:${turnId}:${text}:${displayContent}:${imageContexts.length}`);
    if (this.shouldFailSend) {
      throw new Error('Expected steer failure.');
    }
    return {
      sessionId,
      turnId,
      steeringId: 'steering-1'
    };
  }

  async buildPlan(sessionId: string, planFilePath: string, planName: string, agentType: string): Promise<string> {
    this.buildPlanRequests.push(`${sessionId}:${planFilePath}:${planName}:${agentType}`);
    if (this.shouldFailSend) {
      throw new Error('Expected plan build failure.');
    }
    return this.turnId;
  }

  async cancelTask(sessionId: string, turnId?: string): Promise<void> {
    this.cancelRequests.push(`${sessionId}:${turnId || ''}`);
    if (this.shouldFailCancel) {
      throw new Error('Expected cancel failure.');
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.renameRequests.push(`${sessionId}:${title}`);
    if (this.shouldFailRename) {
      throw new Error('Expected rename failure.');
    }
  }
}

export class RemoteChatMessagesProjectionRecord {
  messages: ChatMessage[] = [];
  hasMoreMessages: boolean = true;
  pollVersion: number = -1;
  knownMessageCount: number = -1;
}

/** Stands in for the RDB-backed transcript cache, keyed the same way it is. */
/**
 * An in-memory stand-in for `RemoteChatLocalRdbStore`.
 *
 * Recency is modelled the same way the real store models it — reads touch a
 * session just as writes do — so a test can assert which transcript eviction
 * actually kept rather than only that a prune was asked for.
 */
export class FakeRemoteChatCacheStore implements RemoteChatCacheStore {
  readonly slices: Map<string, RemoteChatCacheSlice> = new Map<string, RemoteChatCacheSlice>();
  appendCount: number = 0;
  replaceCount: number = 0;
  pruneRequests: number[] = [];
  clearCount: number = 0;
  shouldFail: boolean = false;
  /** Cache keys, least recently touched first. */
  private recency: string[] = [];

  async init(_context: Context): Promise<void> {
    this.failIfNeeded();
  }

  async loadSlice(deviceKey: string, sessionId: string): Promise<RemoteChatCacheSlice> {
    this.failIfNeeded();
    const key = FakeRemoteChatCacheStore.key(deviceKey, sessionId);
    const slice = this.slices.get(key);
    if (!slice) {
      return { messages: [], lastMessageId: '' };
    }
    this.touch(key);
    return { messages: slice.messages.slice(), lastMessageId: slice.lastMessageId };
  }

  async appendMessages(
    deviceKey: string,
    sessionId: string,
    startSeq: number,
    messages: ChatMessage[],
    lastMessageId: string
  ): Promise<void> {
    this.failIfNeeded();
    this.appendCount += 1;
    const key = FakeRemoteChatCacheStore.key(deviceKey, sessionId);
    const existing = this.slices.get(key);
    const kept = existing ? existing.messages.slice(0, startSeq) : [];
    this.slices.set(key, { messages: kept.concat(messages), lastMessageId });
    this.touch(key);
  }

  async replaceMessages(
    deviceKey: string,
    sessionId: string,
    messages: ChatMessage[],
    lastMessageId: string
  ): Promise<void> {
    this.failIfNeeded();
    this.replaceCount += 1;
    const key = FakeRemoteChatCacheStore.key(deviceKey, sessionId);
    this.slices.set(key, { messages: messages.slice(), lastMessageId });
    this.touch(key);
  }

  async deleteSession(deviceKey: string, sessionId: string): Promise<void> {
    this.failIfNeeded();
    this.drop(FakeRemoteChatCacheStore.key(deviceKey, sessionId));
  }

  async pruneSessions(deviceKey: string, keepMostRecent: number): Promise<void> {
    this.failIfNeeded();
    this.pruneRequests.push(keepMostRecent);
    const prefix = `${deviceKey}::`;
    const owned = this.recency.filter((key: string): boolean => key.startsWith(prefix));
    owned.slice(0, Math.max(0, owned.length - keepMostRecent))
      .forEach((key: string): void => this.drop(key));
  }

  async clearAll(): Promise<void> {
    this.failIfNeeded();
    this.clearCount += 1;
    this.slices.clear();
    this.recency = [];
  }

  private touch(key: string): void {
    this.recency = this.recency.filter((stored: string): boolean => stored !== key);
    this.recency.push(key);
  }

  private drop(key: string): void {
    this.slices.delete(key);
    this.recency = this.recency.filter((stored: string): boolean => stored !== key);
  }

  private failIfNeeded(): void {
    if (this.shouldFail) {
      throw new Error('Expected remote chat cache failure.');
    }
  }

  private static key(deviceKey: string, sessionId: string): string {
    return `${deviceKey}::${sessionId}`;
  }
}

/**
 * A cache that never initializes, so every call is a miss.
 *
 * That is the shape most controller tests want: the cache is transparent and
 * the assertions stay about the network path.
 */
export function inertRemoteChatCache(): RemoteChatCache {
  return new RemoteChatCache(new FakeRemoteChatCacheStore(), (): string => 'device-1');
}

/** A cache backed by [store] and ready to read and write. */
export async function readyRemoteChatCache(
  store: FakeRemoteChatCacheStore,
  deviceKey: string = 'device-1'
): Promise<RemoteChatCache> {
  const cache = new RemoteChatCache(store, (): string => deviceKey);
  await cache.init({} as Context);
  return cache;
}

export class FakeRemoteSessionListStore implements RemoteSessionListStore {
  readonly lists: Map<string, RemoteSessionListSlice> = new Map<string, RemoteSessionListSlice>();
  readonly workspaces: Map<string, RecentWorkspaceEntry[]> = new Map<string, RecentWorkspaceEntry[]>();
  lastDeviceKey: string = '';
  saveCount: number = 0;
  clearCount: number = 0;
  shouldFail: boolean = false;

  async init(_context: Context): Promise<void> {
    this.failIfNeeded();
  }

  async loadList(deviceKey: string): Promise<RemoteSessionListSlice> {
    this.failIfNeeded();
    const slice = this.lists.get(deviceKey);
    if (!slice) {
      return { sessions: [], hasMore: false };
    }
    return { sessions: slice.sessions.slice(), hasMore: slice.hasMore };
  }

  async loadLastList(): Promise<RemoteSessionListSlice> {
    this.failIfNeeded();
    return await this.loadList(this.lastDeviceKey);
  }

  async saveList(deviceKey: string, sessions: RemoteSession[], hasMore: boolean): Promise<void> {
    this.failIfNeeded();
    this.saveCount += 1;
    this.lists.set(deviceKey, { sessions: sessions.slice(), hasMore });
    this.lastDeviceKey = deviceKey;
  }

  async saveObservedList(deviceKey: string, sessions: RemoteSession[], hasMore: boolean): Promise<void> {
    this.failIfNeeded();
    this.saveCount += 1;
    this.lists.set(deviceKey, { sessions: sessions.slice(), hasMore });
  }

  async loadWorkspaces(deviceKey: string): Promise<RecentWorkspaceEntry[]> {
    this.failIfNeeded();
    const entries = this.workspaces.get(deviceKey);
    return entries ? entries.slice() : [];
  }

  async saveWorkspaces(deviceKey: string, workspaces: RecentWorkspaceEntry[]): Promise<void> {
    this.failIfNeeded();
    this.workspaces.set(deviceKey, workspaces.slice());
  }

  async clearAll(): Promise<void> {
    this.failIfNeeded();
    this.clearCount += 1;
    this.lists.clear();
    this.workspaces.clear();
    this.lastDeviceKey = '';
  }

  private failIfNeeded(): void {
    if (this.shouldFail) {
      throw new Error('Expected remote session list cache failure.');
    }
  }
}

/** A session list cache backed by [store] and ready to read and write. */
export async function readyRemoteSessionListCache(
  store: FakeRemoteSessionListStore,
  deviceKey: string = 'device-1'
): Promise<RemoteSessionListCache> {
  const cache = new RemoteSessionListCache(store, (): string => deviceKey);
  await cache.init({} as Context);
  return cache;
}

export class FakeGeneralChatCommandClient implements GeneralChatCommandClient {
  currentSessions: RemoteSession[] = [remoteSession('chat-1', 'Chat 1')];
  messagesBySession: Map<string, ChatMessage[]> = new Map<string, ChatMessage[]>();
  initRequests: number = 0;
  createRequests: string[] = [];
  deleteRequests: string[] = [];
  archiveRequests: string[] = [];
  renameRequests: string[] = [];
  removeFailedRequests: string[] = [];
  messageRequests: string[] = [];
  sendRequests: string[] = [];
  cancelCount: number = 0;
  recordedAssistantMessages: string[] = [];
  shouldFail: boolean = false;
  shouldFailSend: boolean = false;
  shouldFailRecordAssistant: boolean = false;

  async init(_context: Context): Promise<void> {
    this.initRequests += 1;
    this.failIfNeeded();
  }

  sessions(): RemoteSession[] {
    return this.currentSessions.slice();
  }

  async createSession(firstMessage: string): Promise<RemoteSession> {
    this.createRequests.push(firstMessage);
    this.failIfNeeded();
    const session = remoteSession('chat-created', firstMessage);
    session.agentType = 'chat';
    this.currentSessions = [session].concat(this.currentSessions);
    return session;
  }

  async messages(sessionId: string): Promise<ChatMessage[]> {
    this.messageRequests.push(sessionId);
    this.failIfNeeded();
    return (this.messagesBySession.get(sessionId) || []).slice();
  }

  async sendMessage(
    sessionId: string,
    text: string,
    images: ImageAttachment[],
    observer?: GeneralChatStreamObserver
  ): Promise<GeneralChatSendResult> {
    this.sendRequests.push(`${sessionId}:${text}:${images.length}`);
    if (this.shouldFailSend) {
      throw new Error('Expected general chat send failure.');
    }
    const userMessage = chatMessage('sent-user', 'user', text, 'completed');
    const assistantMessage = chatMessage('sent-assistant', 'assistant', `Echo: ${text}`, 'completed');
    if (observer) {
      await observer.onUserMessage(userMessage);
      observer.onDelta('Echo: ');
      observer.onDelta(text);
    }
    return {
      userMessage,
      assistantMessage,
      streamChunks: ['Echo: ', text],
      tools: []
    };
  }

  cancelCurrentRequest(): void {
    this.cancelCount += 1;
  }

  async recordAssistantMessage(sessionId: string, message: ChatMessage): Promise<void> {
    if (this.shouldFailRecordAssistant) {
      throw new Error('Expected general chat record failure.');
    }
    this.recordedAssistantMessages.push(`${sessionId}:${message.id}`);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.renameRequests.push(`${sessionId}:${title}`);
    this.failIfNeeded();
    this.currentSessions = this.currentSessions.map((session: RemoteSession) => {
      if (session.id !== sessionId) {
        return session;
      }
      return {
        id: session.id,
        title,
        agentType: session.agentType,
        status: session.status,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        messageCount: session.messageCount,
        workspacePath: session.workspacePath,
        workspaceName: session.workspaceName
      };
    });
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    this.archiveRequests.push(`${sessionId}:${archived ? '1' : '0'}`);
    this.failIfNeeded();
  }

  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    this.failIfNeeded();
    this.currentSessions = this.currentSessions.map((session: RemoteSession) => {
      const updated: RemoteSession = {
        id: session.id,
        title: session.title,
        agentType: session.agentType,
        status: session.status,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        messageCount: session.messageCount,
        workspacePath: session.workspacePath,
        workspaceName: session.workspaceName,
        pinned: session.id === sessionId ? pinned : false,
        titleGenerated: session.titleGenerated
      };
      return updated;
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteRequests.push(sessionId);
    this.failIfNeeded();
    this.currentSessions = this.currentSessions.filter((session: RemoteSession) => session.id !== sessionId);
  }

  async removeFailedUserMessage(sessionId: string, text: string): Promise<void> {
    this.removeFailedRequests.push(`${sessionId}:${text}`);
    this.failIfNeeded();
  }

  private failIfNeeded(): void {
    if (this.shouldFail) {
      throw new Error('Expected general chat command failure.');
    }
  }
}

export class FakeGeneralChatConfigStore extends GeneralChatConfigStore {
  initRequests: number = 0;
  snapshotResult: GeneralChatConfigSnapshot = {
    apiUrl: 'https://api.example.com',
    modelName: 'model-a',
    hasApiKey: true
  };
  shouldFailInit: boolean = false;

  async init(_context: Context): Promise<GeneralChatConfigSnapshot> {
    this.initRequests += 1;
    if (this.shouldFailInit) {
      throw new Error('Expected config init failure.');
    }
    return this.snapshotResult;
  }
}

export class FakeHostSessionManager extends RemoteSessionManager {
  callbacks?: HostSessionCallbacks;
  subscribeSession(logicalId: string, callbacks: HostSessionCallbacks): HostSessionStream {
    this.callbacks = callbacks;
    const source: HostSessionSource = {
      target: 'fixture-host',
      read: () => new Promise<HostStreamPage>(() => {}),
      unsubscribe: async (): Promise<void> => {},
      onHint: () => () => {}, onReconnect: () => () => {}
    };
    return new HostSessionStream(logicalId, source, callbacks);
  }
  async emit(event: HostSessionEvent): Promise<void> {
    await this.callbacks?.onEvent(event); await this.callbacks?.onCaughtUp();
  }
}
export function hostRecord(sessionId: string, revision: number, text: string, status: string = 'inprogress'): HostSessionEvent {
  const record: SessionRecord = { sessionId: sessionId, id: 'item/text', revision: revision,
    turn: { sessionId: sessionId, turnId: 'turn', turnIndex: 0, timestamp: 1,
      userMessage: { id: 'user', content: 'question', timestamp: 1 }, status: status },
    round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: status },
    item: { type: 'text', data: { id: 'text', content: text, timestamp: 3 } }
  };
  return { session_id: sessionId, event: 'session-record', payload: record };
}
