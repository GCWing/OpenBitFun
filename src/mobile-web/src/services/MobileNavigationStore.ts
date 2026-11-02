import { canonicalAgentId } from '../../../shared/agent-harness/contract.generated';
import type { SessionWorkspaceContext } from './workspaceIdentity';
const STORAGE_KEY = 'openbitfun.mobile.navigation.v1';

export interface MobileNavigationScope {
  accountId: string;
  controllerDeviceId: string;
  relayUrl: string;
  routeKey: string;
}

export interface MobileNavigation {
  deviceId: string;
  disconnected?: boolean;
  session?: { id: string; name: string; agentType: string; workspace?: SessionWorkspaceContext };
}

export interface PairedNavigation {
  scope: MobileNavigationScope;
  restored: MobileNavigation | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Additive session field: records from older builds omit it, and bad values are dropped. */
function readSessionWorkspace(value: unknown): SessionWorkspaceContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: string) => (typeof record[field] === 'string' ? record[field] as string : undefined);
  const kind = text('workspace_kind');
  const workspace: SessionWorkspaceContext = {
    workspace_id: text('workspace_id'),
    path: text('path'),
    remote_connection_id: text('remote_connection_id'),
    remote_ssh_host: text('remote_ssh_host'),
    name: text('name'),
    workspace_kind: kind === 'normal' || kind === 'assistant' || kind === 'remote' ? kind : undefined,
  };
  return workspace.workspace_id || workspace.path || workspace.name ? workspace : undefined;
}

function browserStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

export function loadMobileNavigation(
  scope: MobileNavigationScope,
  storage: StorageLike | null = browserStorage(),
): MobileNavigation | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record.version !== 1
      || record.accountId !== scope.accountId
      || record.controllerDeviceId !== scope.controllerDeviceId
      || record.relayUrl !== scope.relayUrl
      || record.routeKey !== scope.routeKey
      || typeof record.deviceId !== 'string'
      || !record.deviceId.trim()) return null;
    const session = record.session;
    const workspace = readSessionWorkspace(session?.workspace);
    return {
      deviceId: record.deviceId,
      ...(record.disconnected === true ? { disconnected: true } : {}),
      session: session && typeof session.id === 'string' && session.id.trim()
        && typeof session.name === 'string' && typeof session.agentType === 'string'
        ? {
          id: session.id,
          name: session.name,
          agentType: canonicalAgentId(session.agentType),
          ...(workspace ? { workspace } : {}),
        }
        : undefined,
    };
  } catch {
    // Keep unreadable/newer records intact; live navigation remains usable.
    return null;
  }
}

export function saveMobileNavigation(
  scope: MobileNavigationScope,
  navigation: MobileNavigation,
  storage: StorageLike | null = browserStorage(),
): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...scope, ...navigation })); }
  catch { /* Browser storage is optional. */ }
}

export function clearMobileNavigation(storage: StorageLike | null = browserStorage()): void {
  try { storage?.removeItem(STORAGE_KEY); }
  catch { /* Browser storage is optional. */ }
}

/** Preserve this tab's target when its old per-tab account joins a shared browser identity. */
export function migrateMobileNavigationController(
  accountId: string, relayUrl: string, previousId: string, controllerDeviceId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (previousId === controllerDeviceId) return;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const record = JSON.parse(raw);
    if (record.version === 1 && record.accountId === accountId && record.relayUrl === relayUrl
      && record.controllerDeviceId === previousId) {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ ...record, controllerDeviceId }));
    }
  } catch { /* Retain unreadable navigation without replacing it. */ }
}
