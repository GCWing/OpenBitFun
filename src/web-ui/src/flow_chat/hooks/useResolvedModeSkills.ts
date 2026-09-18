import { useCallback, useEffect, useRef, useState } from 'react';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import type { ModeSkillInfo, SkillScanDiagnostic } from '@/infrastructure/config/types';
import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useResolvedModeSkills');
const EMPTY_SKILLS: ModeSkillInfo[] = [];

type Snapshot = {
  key: string;
  skills: ModeSkillInfo[] | null;
  loading: boolean;
  failed: boolean;
  diagnostics?: SkillScanDiagnostic[];
  diagnosticsAvailable?: boolean;
};

export function useResolvedModeSkills({
  enabled,
  surfaceEpoch,
  connectionId,
  modeId,
  workspaceId,
}: {
  enabled: boolean;
  surfaceEpoch: number;
  connectionId?: string | null;
  modeId: string;
  workspaceId?: string | null;
}) {
  const key = JSON.stringify([surfaceEpoch, connectionId ?? null, workspaceId || null, modeId]);
  const entryRef = useRef<Snapshot | null>(null);
  const mountedRef = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const invalidate = () => {
      entryRef.current = null;
      setSnapshot(null);
      setRevision(value => value + 1);
    };
    globalEventBus.on('mode:config:updated', invalidate);
    return () => { globalEventBus.off('mode:config:updated', invalidate); };
  }, []);

  useEffect(() => {
    if (entryRef.current?.key !== key) {
      entryRef.current = { key, skills: null, loading: false, failed: false };
    }
    const entry = entryRef.current;
    if (!enabled || entry.loading) return;

    // Keep a single in-flight request when a picker closes/reopens. Each later
    // opening revalidates source files and mode policy, displaying the last result.
    entry.loading = true;
    entry.failed = false;
    setSnapshot({ ...entry });
    void configAPI.getModeSkillScanReport({ modeId, workspaceId: workspaceId || undefined })
      .then(report => {
        // The host owns runtime selection and availability for every source.
        entry.skills = report.skills;
        entry.diagnostics = report.diagnostics;
        entry.diagnosticsAvailable = report.diagnosticsAvailable;
      })
      .catch(err => {
        entry.skills = null;
        entry.diagnostics = [];
        entry.failed = true;
        log.error('Failed to load mode-resolved skills for chat input', { err, modeId, workspaceId });
      })
      .finally(() => {
        entry.loading = false;
        if (mountedRef.current && entryRef.current === entry) setSnapshot({ ...entry });
      });
  }, [enabled, key, modeId, workspaceId, revision]);

  // Hide a previous host/workspace/mode synchronously, before effects run.
  const current = snapshot?.key === key ? snapshot : null;
  return {
    skills: current?.skills ?? EMPTY_SKILLS,
    diagnostics: current?.diagnostics ?? [],
    diagnosticsAvailable: current?.diagnosticsAvailable ?? true,
    loading: current?.loading ?? enabled,
    hasLoaded: current?.skills != null,
    failed: current?.failed ?? false,
    retry: useCallback(() => setRevision(value => value + 1), []),
  };
}
