import { RemoteWorkspaceIdentity } from '../model/RemoteModels';

/**
 * Upgrade-only conversion for pre-ID caches and host projections.
 *
 * Paths are not workspace keys. New state and commands retain `workspaceId`;
 * this is the single place where a reference without one may be attributed to
 * a catalog record. Mirrors the Kotlin `LegacyWorkspaceCompatibility.resolve`
 * and the Rust `resolve_legacy_workspace_reference`:
 * - an explicit ID is authoritative and never falls back to a path;
 * - a unique path match adopts the record;
 * - an ambiguous path stays unresolved;
 * - `localhost` without a saved connection is a 1.0.0 local marker, not a host.
 *
 * Remove when all supported caches have migrated and every peer negotiates
 * `workspace_id_references_v1`.
 */
export class LegacyWorkspaceCompatibility {
  static resolve(
    reference: RemoteWorkspaceIdentity,
    catalog: RemoteWorkspaceIdentity[]
  ): RemoteWorkspaceIdentity | undefined {
    const workspaceId = (reference.workspaceId || '').trim();
    if (workspaceId.length > 0) {
      // Two catalog rows sharing an ID is a corrupt catalog; refusing is the only safe answer.
      const byId = catalog.filter((candidate: RemoteWorkspaceIdentity): boolean =>
        candidate.workspaceId === workspaceId);
      return byId.length === 1 ? byId[0] : undefined;
    }
    const root = LegacyWorkspaceCompatibility.normalizeRoot(reference.path);
    const connectionId = (reference.remoteConnectionId || '').trim();
    const sshHost = (reference.remoteSshHost || '').trim();
    const localMarker = connectionId.length === 0 && sshHost === 'localhost';
    const matches = catalog.filter((candidate: RemoteWorkspaceIdentity): boolean => {
      if (LegacyWorkspaceCompatibility.normalizeRoot(candidate.path) !== root) {
        return false;
      }
      if (connectionId.length > 0 && (candidate.remoteConnectionId || '').trim() !== connectionId) {
        return false;
      }
      if (sshHost.length > 0 && !localMarker && (candidate.remoteSshHost || '').trim() !== sshHost) {
        return false;
      }
      return true;
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Trailing separators are not identity; a bare root keeps its slash. */
  private static normalizeRoot(path: string): string {
    const trimmed = path.trim();
    const normalized = trimmed.replace(/\/+$/, '');
    return normalized.length > 0 ? normalized : trimmed;
  }
}
