import { useCallback, useEffect, useRef, useState } from 'react';
import { agentAPI, type ModelRoutingStatus, type ModelRoutingStatusRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { ModelRoutingMode } from '@/infrastructure/config/types';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

/** A host response is the authority for both strategy and feature support. */
export function useModelRouting({ identity, epoch, request, allowed, open, modelName, reasoningPreset, onModelChange, draft }: {
  draft?: { mode?: ModelRoutingMode; onChange: (mode: ModelRoutingMode) => void };
  identity: string; epoch: number; request: ModelRoutingStatusRequest;
  allowed: boolean; open: boolean; modelName: string; reasoningPreset?: string;
  onModelChange: (id: string) => void;
}) {
  const live = useRef(identity); live.current = identity;
  const sequence = useRef(0);
  const busy = useRef(false);
  const [snapshot, setSnapshot] = useState<{ identity: string; status: ModelRoutingStatus | null }>({ identity, status: null });
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const status = allowed && snapshot.identity === identity ? snapshot.status : null;
  const available = status?.available === true;
  const selectedMode = draft ? draft.mode ?? status?.defaultMode : request.sessionId ? status?.mode : status?.defaultMode;
  const mode: ModelRoutingMode = available && selectedMode === 'smart' ? 'smart' : 'manual';
  const requestKey = JSON.stringify(draft ? { ...request, sessionId: undefined } : request);
  const refresh = useCallback(async () => {
    const order = ++sequence.current;
    const surface = getActiveSurfaceScope();
    if (!allowed) return;
    try {
      const status = await agentAPI.getModelRoutingStatus(JSON.parse(requestKey));
      if (!surface.isCurrent() || live.current !== identity || order !== sequence.current) return;
      setSnapshot({ identity, status: status.apiVersion === 1 ? status : null });
    } catch {
      if (surface.isCurrent() && live.current === identity && order === sequence.current) setSnapshot({ identity, status: null });
    }
  }, [allowed, identity, requestKey]);
  useEffect(() => {
    void refresh();
    return configManager.onConfigChange(path => {
      if (!path || path === 'ai' || ['ai.models', 'ai.default_models', 'ai.model_routing'].some(owner => path === owner || path.startsWith(`${owner}.`))) void refresh();
    });
  }, [refresh]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  const select = async (next: ModelRoutingMode) => {
    if (!allowed || !status || busy.current || (next === 'smart' && (!available || !status.ready))) return false;
    if (next === mode && selectedMode === mode && (!draft || draft.mode !== undefined)) return true;
    const surface = getActiveSurfaceScope();
    if (surface.epoch !== epoch || live.current !== identity) return false;
    busy.current = true; setPendingIdentity(identity);
    try {
      const selected = next === 'smart' ? 'primary' : modelName;
      if (request.sessionId) {
        if (draft) draft.onChange(next);
        else await agentAPI.updateSessionModel({ ...request, sessionId: request.sessionId,
            modelName: selected, reasoningPreset: reasoningPreset ?? null, routingMode: next });
        if (!surface.isCurrent() || live.current !== identity) return false;
        onModelChange(selected);
      }
      if (!request.sessionId) {
        await configManager.setConfig('ai.model_routing.default_mode', next);
      }
      if (!surface.isCurrent() || live.current !== identity) return false;
      await refresh();
      return true;
    } finally {
      busy.current = false;
      setPendingIdentity(current => current === identity ? null : current);
    }
  };
  return { status, available, mode, pending: pendingIdentity === identity, select, refresh };
}
