import { useEffect, useMemo, useRef, useState } from 'react';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { Session } from '../types/flow-chat';
import { loadTrajectoryCatalog, loadTrajectoryPage } from './trajectoryApi';
import { mergeTrajectoryNodes, projectLoadedTrajectory, type TrajectoryNode, type TrajectoryProjectionCache } from './trajectoryModel';

/** Summaries are pageable independently of the rendered transcript. No history
 * window is activated by browsing/searching this index. One read is in flight. */
export function useTrajectory(session: Session, query: string) {
  const peer = usePeerDeviceModeOptional();
  const supported = !peer?.peerMode.active || peer.currentPeerCapabilities?.sessionTrajectoryV1 === true;
  const scope = getActiveSurfaceScope();
  const [history, setHistory] = useState<TrajectoryNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [complete, setComplete] = useState(false);
  const [revision, setRevision] = useState(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Search text is debounced by the caller; stable catalog revisions fence
  // rollbacks and external source rewrites, without restarting on every token.
  const catalogRevision = session.turnCatalog?.revision;
  useEffect(() => {
    let cancelled = false;
    let snapshot = sessionRef.current;
    setHistory([]); setError(false); setComplete(false);
    if (!supported || !snapshot.workspaceId) {
      setLoading(false);
      setComplete(!snapshot.isPartial);
      return;
    }
    const current = () => !cancelled && scope.isCurrent();
    setLoading(true);
    const read = async () => {
      try {
        // Replica catalogs have a different revision namespace. Discover the
        // owning host's persisted index without replacing the content replica.
        const catalog = await loadTrajectoryCatalog(snapshot);
        if (!current()) return;
        if (catalog.status === 'ready') throw new Error('Missing trajectory catalog');
        snapshot = { ...snapshot, turnCatalog: catalog.catalog };
        let ordinal = snapshot.turnCatalog!.entries[0]?.ordinal ?? 0;
        let offset = 0;
        const end = (snapshot.turnCatalog!.entries.at(-1)?.ordinal ?? -1) + 1;
        while (current() && ordinal < end) {
          const page = await loadTrajectoryPage(snapshot, ordinal, query, offset);
          if (!current()) return;
          if (page.status !== 'ready') throw new Error('Session trajectory revision changed');
          // Keep the light index only. Full bodies are read only on selection.
          setHistory(previous => [...previous, ...page.nodes]);
          if (page.nextNodeOffset !== null) {
            if (page.nextNodeOffset <= offset) throw new Error('Trajectory cursor did not advance');
            offset = page.nextNodeOffset;
          } else {
            if (page.endOrdinalExclusive <= ordinal) throw new Error('Trajectory window did not advance');
            ordinal = page.endOrdinalExclusive; offset = 0;
          }
          // Yield between pages so large sessions remain interactive and a new
          // query/close/surface switch can abandon the next request.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        if (current()) setComplete(true);
      } catch {
        if (current()) setError(true);
      } finally {
        if (current()) setLoading(false);
      }
    };
    const timer = setTimeout(() => void read(), 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session.sessionId, catalogRevision, scope, supported, query, revision]);
  // Immutable Turn identity, ordinal and query fully determine cached nodes.
  const projectionCache = useMemo<TrajectoryProjectionCache>(() => new WeakMap(), []);
  const live = useMemo(() => projectLoadedTrajectory(session, query, projectionCache), [session, query, projectionCache]);
  const nodes = useMemo(() => mergeTrajectoryNodes(history, live), [history, live]);
  return { nodes, loading, error, complete, supported, retry: () => setRevision(value => value + 1) };
}
