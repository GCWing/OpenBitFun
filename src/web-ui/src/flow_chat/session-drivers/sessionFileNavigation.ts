import { flowChatStore } from '../store/FlowChatStore';
import { driverForSession } from './registry';
import type { LineRange } from '@/shared/editor/LineRange';

function sessionFileProvider(sessionId: string | undefined) {
  if (!sessionId) return undefined;
  return driverForSession(sessionId, flowChatStore.getState().sessions.get(sessionId)).fileAccess;
}

export function hasSessionFileProvider(sessionId: string | undefined): boolean {
  return Boolean(sessionFileProvider(sessionId));
}

/**
 * The workspace a session's file references belong to. Files opened from a
 * conversation are IO on that session's workspace; the ID selects it and the
 * path stays an IO operand.
 */
export function sessionWorkspaceId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const session = flowChatStore.getState().sessions.get(sessionId);
  return session?.workspaceId || session?.config?.workspaceId || undefined;
}

export function readImageThroughSession(sessionId: string | undefined, filePath: string, refresh?: boolean): Promise<string> {
  const provider = sessionFileProvider(sessionId);
  if (!sessionId || !provider?.readImage) return Promise.reject(new Error('This session cannot provide image bytes'));
  return provider.readImage(sessionId, filePath, refresh);
}

export function downloadFileThroughSession(sessionId: string | undefined, filePath: string): Promise<void> {
  const provider = sessionFileProvider(sessionId);
  if (!sessionId || !provider?.download) return Promise.reject(new Error('This session cannot provide file downloads'));
  return provider.download(sessionId, filePath);
}

/** Returns true once the owning transport handles the request, including errors. */
export function openFileThroughSession(
  sessionId: string | undefined,
  filePath: string,
  fileName: string,
  lineRange?: LineRange,
): boolean {
  const provider = sessionFileProvider(sessionId);
  if (!provider || !sessionId) return false;
  void provider.open(sessionId, filePath, fileName, lineRange);
  return true;
}
