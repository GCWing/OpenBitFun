import { useEffect, useMemo, useState } from 'react';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { hasSessionFileProvider } from '../session-drivers/sessionFileNavigation';
import type { FlowToolItem } from '../types/flow-chat';
import { localFileOperationDiffStats, type FileOperationDiffStats } from './fileOperationDiffStats';
import { getToolCardStatus } from './toolCardStatus';
import { loadOperationSummary } from '../timeline/operationSummaryResource';

const log = createLogger('useFileOperationDiffStats');

interface SnapshotStats {
  sessionId: string;
  surfaceEpoch: number;
  operations: ReadonlyMap<string, FileOperationDiffStats | null>;
}

/** Resolve only recorded operation summaries, scoped to their session and device. */
export function useFileOperationDiffStats(items: readonly FlowToolItem[], {
  sessionId, surfaceEpoch, snapshotsAvailable,
}: { sessionId?: string; surfaceEpoch: number; snapshotsAvailable: boolean }): ReadonlyMap<string, FileOperationDiffStats> {
  const [snapshotStats, setSnapshotStats] = useState<SnapshotStats>();
  const dispatchSession = hasSessionFileProvider(sessionId);
  const operationIdsKey = JSON.stringify(sessionId && !dispatchSession ? items
    .filter(item => getToolCardStatus(item) === 'completed'
      && (snapshotsAvailable || item.toolResult?.result?.snapshot_recorded === true))
    .map(item => item.toolCall?.id).filter(Boolean) : []);
  const operationIds = useMemo(() => new Set<string>(JSON.parse(operationIdsKey)), [operationIdsKey]);

  useEffect(() => {
    if (!sessionId || operationIds.size === 0) return;
    const cached = snapshotStats && snapshotStats.sessionId === sessionId && snapshotStats.surfaceEpoch === surfaceEpoch
      ? snapshotStats.operations : undefined;
    const missing = [...operationIds].filter(id => !cached?.has(id));
    if (missing.length === 0) return;
    const scope = getActiveSurfaceScope();
    let cancelled = false;

    void (async () => {
      const results = await Promise.all(missing.map(async operationId => {
        try {
          if (cancelled || !scope.isCurrent()) return [operationId, null] as const;
          const summary = await loadOperationSummary(sessionId, operationId, surfaceEpoch, () => !cancelled && scope.isCurrent());
          return [operationId, summary] as const;
        } catch (error) {
          if (!cancelled && scope.isCurrent()) log.warn('Failed to load operation summary', { sessionId, operationId, error });
          return [operationId, null] as const;
        }
      }));
      if (cancelled || !scope.isCurrent()) return;
      setSnapshotStats({ sessionId, surfaceEpoch, operations: new Map([...(cached ?? []), ...results]) });
    })();

    return () => { cancelled = true; };
  }, [operationIds, sessionId, surfaceEpoch, snapshotStats]);

  return useMemo(() => {
    const recorded = snapshotStats && snapshotStats.sessionId === sessionId && snapshotStats.surfaceEpoch === surfaceEpoch
      ? snapshotStats.operations : undefined;
    return new Map(items.map(item => [item.id,
      (operationIds.has(item.toolCall?.id) ? recorded?.get(item.toolCall.id) : undefined)
        ?? localFileOperationDiffStats(item),
    ]));
  }, [items, operationIds, sessionId, surfaceEpoch, snapshotStats]);
}
