import type {
  ChatMessage,
  RecentWorkspaceEntry,
  RemoteWorkspaceIdentity,
  SessionInfo,
} from './RemoteSessionManager';
import { mergeWorkspaceSessions } from './workspaceIdentity';

const DB_NAME = 'openbitfun-mobile-remote-cache';
const DB_VERSION = 1;
const SESSION_STORE = 'session_state';
const TRANSCRIPT_STORE = 'transcripts';
const MAX_SESSIONS_PER_DEVICE = 60;
const MAX_TRANSCRIPTS_PER_DEVICE = 20;
const MAX_MESSAGES_PER_TRANSCRIPT = 200;

export interface RemoteCacheScope {
  accountId: string;
  deviceId: string;
  key: string;
}

export interface CachedSessionState {
  sessions: SessionInfo[];
  workspaces: RecentWorkspaceEntry[];
  workspaceCatalogSource?: 'opened' | 'recent';
  updatedAt: number;
}

export interface CachedTranscript {
  messages: ChatMessage[];
  hasMore: boolean;
  updatedAt: number;
}

interface SessionStateRecord extends CachedSessionState {
  key: string;
  accountId: string;
  deviceId: string;
}

interface TranscriptRecord extends CachedTranscript {
  key: string;
  deviceKey: string;
  accountId: string;
  deviceId: string;
  sessionId: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function createRemoteCacheScope(
  accountId: string | null | undefined,
  deviceId: string | null | undefined,
): RemoteCacheScope | null {
  const normalizedAccountId = accountId?.trim();
  const normalizedDeviceId = deviceId?.trim();
  if (!normalizedAccountId || !normalizedDeviceId) return null;
  return {
    accountId: normalizedAccountId,
    deviceId: normalizedDeviceId,
    key: `${encodeURIComponent(normalizedAccountId)}::${encodeURIComponent(normalizedDeviceId)}`,
  };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(TRANSCRIPT_STORE)) {
        const store = db.createObjectStore(TRANSCRIPT_STORE, { keyPath: 'key' });
        store.createIndex('deviceKey', 'deviceKey', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      console.warn('Remote cache is unavailable', request.error);
      resolve(null);
    };
    request.onblocked = () => {
      console.warn('Remote cache database upgrade is blocked');
      resolve(null);
    };
  });
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function enqueueWrite(operation: () => Promise<void>): void {
  writeQueue = writeQueue
    .then(operation)
    .catch((error) => console.warn('Remote cache write failed', error));
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort((left, right) => (
    Number.parseInt(right.updated_at, 10) - Number.parseInt(left.updated_at, 10)
  ));
}

async function readSessionRecord(scope: RemoteCacheScope): Promise<SessionStateRecord | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const transaction = db.transaction(SESSION_STORE, 'readonly');
    const record = await requestResult(
      transaction.objectStore(SESSION_STORE).get(scope.key) as IDBRequest<SessionStateRecord | undefined>,
    );
    return record ?? null;
  } catch (error) {
    console.warn('Remote session cache read failed', error);
    return null;
  }
}

function transcriptKey(scope: RemoteCacheScope, sessionId: string): string {
  return `${scope.key}::${encodeURIComponent(sessionId)}`;
}

export const remoteCache = {
  async loadSessionState(scope: RemoteCacheScope | null): Promise<CachedSessionState | null> {
    if (!scope) return null;
    const record = await readSessionRecord(scope);
    if (!record) return null;
    return {
      sessions: record.sessions,
      workspaces: record.workspaces,
      workspaceCatalogSource: record.workspaceCatalogSource,
      updatedAt: record.updatedAt,
    };
  },

  saveSessionPage(
    scope: RemoteCacheScope | null,
    sessions: SessionInfo[],
    options: {
      workspacePath?: string;
      workspaceIdentity?: RemoteWorkspaceIdentity;
      replaceWorkspace?: boolean;
    } = {},
  ): void {
    if (!scope) return;
    enqueueWrite(async () => {
      const db = await openDatabase();
      if (!db) return;
      const existing = await readSessionRecord(scope);
      const transaction = db.transaction(SESSION_STORE, 'readwrite');
      transaction.objectStore(SESSION_STORE).put({
        key: scope.key,
        accountId: scope.accountId,
        deviceId: scope.deviceId,
        // The stored identity carries the workspace ID when the listing had
        // one; older records without it stay readable and resolve through the
        // legacy compatibility helper on read.
        sessions: sortSessions(mergeWorkspaceSessions(
          existing?.sessions ?? [],
          sessions,
          options.workspacePath || options.workspaceIdentity?.workspaceId ? {
            workspace_id: options.workspaceIdentity?.workspaceId,
            path: options.workspacePath,
            remote_connection_id: options.workspaceIdentity?.remoteConnectionId,
            remote_ssh_host: options.workspaceIdentity?.remoteSshHost,
          } : undefined,
          options.replaceWorkspace ?? false,
        )).slice(0, MAX_SESSIONS_PER_DEVICE),
        workspaces: existing?.workspaces ?? [],
        workspaceCatalogSource: existing?.workspaceCatalogSource,
        updatedAt: Date.now(),
      } satisfies SessionStateRecord);
      await transactionDone(transaction);
    });
  },

  saveWorkspaceCatalog(
    scope: RemoteCacheScope | null,
    workspaces: RecentWorkspaceEntry[],
    workspaceCatalogSource: 'opened' | 'recent' = 'recent',
  ): void {
    if (!scope) return;
    enqueueWrite(async () => {
      const db = await openDatabase();
      if (!db) return;
      const existing = await readSessionRecord(scope);
      const transaction = db.transaction(SESSION_STORE, 'readwrite');
      transaction.objectStore(SESSION_STORE).put({
        key: scope.key,
        accountId: scope.accountId,
        deviceId: scope.deviceId,
        sessions: existing?.sessions ?? [],
        workspaces,
        workspaceCatalogSource,
        updatedAt: Date.now(),
      } satisfies SessionStateRecord);
      await transactionDone(transaction);
    });
  },

  renameSession(scope: RemoteCacheScope | null, sessionId: string, name: string): void {
    if (!scope) return;
    enqueueWrite(async () => {
      const db = await openDatabase();
      if (!db) return;
      const existing = await readSessionRecord(scope);
      if (!existing) return;
      const transaction = db.transaction(SESSION_STORE, 'readwrite');
      transaction.objectStore(SESSION_STORE).put({
        ...existing,
        sessions: existing.sessions.map((session) => (
          session.session_id === sessionId ? { ...session, name } : session
        )),
        updatedAt: Date.now(),
      } satisfies SessionStateRecord);
      await transactionDone(transaction);
    });
  },

  deleteSession(scope: RemoteCacheScope | null, sessionId: string): void {
    if (!scope) return;
    enqueueWrite(async () => {
      const db = await openDatabase();
      if (!db) return;
      const existing = await readSessionRecord(scope);
      const transaction = db.transaction([SESSION_STORE, TRANSCRIPT_STORE], 'readwrite');
      if (existing) {
        transaction.objectStore(SESSION_STORE).put({
          ...existing,
          sessions: existing.sessions.filter((session) => session.session_id !== sessionId),
          updatedAt: Date.now(),
        } satisfies SessionStateRecord);
      }
      transaction.objectStore(TRANSCRIPT_STORE).delete(transcriptKey(scope, sessionId));
      await transactionDone(transaction);
    });
  },

  async loadTranscript(
    scope: RemoteCacheScope | null,
    sessionId: string,
  ): Promise<CachedTranscript | null> {
    if (!scope) return null;
    const db = await openDatabase();
    if (!db) return null;
    try {
      const transaction = db.transaction(TRANSCRIPT_STORE, 'readonly');
      const record = await requestResult(
        transaction.objectStore(TRANSCRIPT_STORE).get(
          transcriptKey(scope, sessionId),
        ) as IDBRequest<TranscriptRecord | undefined>,
      );
      if (!record) return null;
      return {
        messages: record.messages,
        hasMore: record.hasMore,
        updatedAt: record.updatedAt,
      };
    } catch (error) {
      console.warn('Remote transcript cache read failed', error);
      return null;
    }
  },

  saveTranscript(
    scope: RemoteCacheScope | null,
    sessionId: string,
    messages: ChatMessage[],
    hasMore: boolean,
  ): void {
    if (!scope) return;
    enqueueWrite(async () => {
      const db = await openDatabase();
      if (!db) return;
      const existingTransaction = db.transaction(TRANSCRIPT_STORE, 'readonly');
      const existingRecords = await requestResult(
        existingTransaction.objectStore(TRANSCRIPT_STORE).index('deviceKey').getAll(
          scope.key,
        ) as IDBRequest<TranscriptRecord[]>,
      );
      const key = transcriptKey(scope, sessionId);
      const retainedExistingCount = existingRecords.some((record) => record.key === key)
        ? MAX_TRANSCRIPTS_PER_DEVICE
        : MAX_TRANSCRIPTS_PER_DEVICE - 1;
      const transaction = db.transaction(TRANSCRIPT_STORE, 'readwrite');
      const store = transaction.objectStore(TRANSCRIPT_STORE);
      store.put({
        key,
        deviceKey: scope.key,
        accountId: scope.accountId,
        deviceId: scope.deviceId,
        sessionId,
        messages: messages.slice(-MAX_MESSAGES_PER_TRANSCRIPT),
        hasMore,
        updatedAt: Date.now(),
      } satisfies TranscriptRecord);
      existingRecords
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(retainedExistingCount)
        .forEach((record) => store.delete(record.key));
      await transactionDone(transaction);
    });
  },
};
