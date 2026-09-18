import type { SessionResponse } from '../types/session';

export interface TerminalWorkspaceScope {
  workspaceId: string;
  rootPath: string;
  connectionId?: string | null;
  isRemote: boolean;
}

/** Target path semantics, independent of the controller's operating system. */
export function normalizeTerminalPath(path: string, remote = false): string {
  const windows = !remote && (/^[a-z]:[/\\]/i.test(path) || path.startsWith('\\\\'));
  const normalized = windows ? path.replace(/\\/g, '/').toLowerCase() : path;
  return normalized.replace(/\/+$/, '') || '/';
}

export function isTerminalPathInside(path: string, root: string, remote = false): boolean {
  if (!path || !root) return false;
  const candidate = normalizeTerminalPath(path, remote);
  const parent = normalizeTerminalPath(root, remote);
  return candidate === parent || candidate.startsWith(parent === '/' ? '/' : `${parent}/`);
}

/** Workspace ownership is independent of the terminal's mutable cwd. */
export function terminalBelongsToWorkspace(
  session: SessionResponse,
  scope: TerminalWorkspaceScope,
): boolean {
  return !!session.workspaceId && session.workspaceId === scope.workspaceId;
}

/** Legacy hosts expose only cwd. Remember the first observation for this service lifetime. */
export class TerminalOriginCache {
  private origins = new Map<string, { initialCwd: string; workspaceId?: string }>();

  project(surfaceId: string, session: SessionResponse): SessionResponse {
    const key = JSON.stringify([surfaceId, session.id]);
    const previous = this.origins.get(key);
    const initialCwd = session.initialCwd || previous?.initialCwd || session.cwd;
    const workspaceId = session.workspaceId || previous?.workspaceId;
    this.origins.set(key, { initialCwd, workspaceId });
    return { ...session, initialCwd, workspaceId };
  }
}
