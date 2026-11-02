import { useSyncExternalStore } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { sessionProjectWorkspaceId } from '@/flow_chat/utils/sessionWorkspace';
import { sessionWorktreeRootPath } from '@/flow_chat/utils/sessionWorktree';

/**
 * Working directory a terminal must start in when it is created for the
 * `workspaceId` scope.
 *
 * A worktree-isolated session executes in its worktree, so a terminal started
 * from that session's project would otherwise run `git`, build, and test
 * commands in the main working tree while the agent edits the worktree.
 *
 * The terminal stays owned by `workspaceId`; only the cwd follows the session.
 * `undefined` means the caller keeps the workspace root, which is also the
 * answer when the active session belongs to another project (the workspace ID,
 * never a path, decides that) or is not worktree-isolated.
 */
export function resolveSessionTerminalDirectory(
  session: Session | undefined,
  workspaceId: string | undefined,
): string | undefined {
  if (!session || !workspaceId) return undefined;
  if (sessionProjectWorkspaceId(session) !== workspaceId) return undefined;
  return sessionWorktreeRootPath(session);
}

/**
 * Resolve the directory against the current store state. Action handlers use
 * this because they resolve their target workspace at event time.
 */
export function activeSessionTerminalDirectory(workspaceId: string | undefined): string | undefined {
  const state = flowChatStore.getState();
  return resolveSessionTerminalDirectory(
    state.activeSessionId ? state.sessions.get(state.activeSessionId) : undefined,
    workspaceId,
  );
}

const subscribeFlowChatStore = (listener: () => void) => flowChatStore.subscribe(listener);

/** Terminal default cwd for `workspaceId`, tracking the active session. */
export function useSessionTerminalDirectory(workspaceId: string | undefined): string | undefined {
  return useSyncExternalStore(
    subscribeFlowChatStore,
    () => activeSessionTerminalDirectory(workspaceId),
    () => undefined,
  );
}
