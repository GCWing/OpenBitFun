import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ConversationSessionRef } from '../../contexts/conversationViewScope';
import type { SessionViewportState } from './ModernFlowChatContainer';

type Host = 'main' | 'dock';
type Reader = { scope: SurfaceScope; read: (sessionId: string) => SessionViewportState | null };
const readers = new Map<string, Reader>();
const transfers = new Map<string, { scope: SurfaceScope; state: SessionViewportState; revision: number }>();
let revision = 0;
const key = (ref: ConversationSessionRef, host: Host) => JSON.stringify([ref.surfaceId, host, host === 'dock' ? ref.sessionId : '']);
const transferKey = (ref: ConversationSessionRef, host: Host) => JSON.stringify([ref.surfaceId, ref.sessionId, host]);

/** Only an explicit host move hands off presentation. Runtime state is never copied. */
export function registerConversationReader(ref: ConversationSessionRef, host: Host, read: Reader['read']) {
  const reader = { scope: getActiveSurfaceScope(), read };
  const id = key(ref, host);
  readers.set(id, reader);
  return () => { if (readers.get(id) === reader) readers.delete(id); };
}

export function stageConversationViewTransfer(ref: ConversationSessionRef, source: Host) {
  const reader = readers.get(key(ref, source));
  if (!reader?.scope.isCurrent() || reader.scope.surfaceId !== ref.surfaceId) return;
  const state = reader.read(ref.sessionId);
  if (state) transfers.set(transferKey(ref, source === 'main' ? 'dock' : 'main'), { scope: reader.scope, state, revision: ++revision });
}

export function peekConversationViewTransfer(ref: ConversationSessionRef, destination: Host) {
  const transfer = transfers.get(transferKey(ref, destination));
  return transfer?.scope.isCurrent() ? transfer : undefined;
}

export function takeConversationViewTransfer(ref: ConversationSessionRef, destination: Host, expectedRevision?: number) {
  const id = transferKey(ref, destination);
  const transfer = transfers.get(id);
  if (expectedRevision !== undefined && transfer?.revision !== expectedRevision) return undefined;
  transfers.delete(id);
  return transfer?.scope.isCurrent() ? transfer : undefined;
}
