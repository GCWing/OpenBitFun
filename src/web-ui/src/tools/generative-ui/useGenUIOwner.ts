import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
import { accessGenUIOwner, type GenUIOwnerRevision } from './genUIOwner';
import { genUIContentKey } from './genUIState';
import type { GenUIAppDefinition, GenUIAppEnvelope, GenUIAppState } from './genUITypes';
export function useGenUIOwner(origin: GenerativeWidgetOrigin | undefined, app: GenUIAppEnvelope | undefined, ownerRevision: string | undefined) {
  const key = JSON.stringify([origin, app]);
  const [loaded, setLoaded] = useState<{ key: string; value: GenUIOwnerRevision }>();
  const [error, setError] = useState<{ key: string; message: string }>();
  const current = useRef<{ key: string; value: GenUIOwnerRevision }>();
  const active = useRef<{ key: string; epoch: number }>({ key, epoch: 0 });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enabled = Boolean(origin && app && ownerRevision);
  const ownerApp = app as (GenUIAppEnvelope & Partial<Pick<GenUIAppDefinition, 'libraryId' | 'libraryRevision' | 'designSpec' | 'source'>>) | undefined;
  const identity = useMemo(() => ownerApp ? {
    ...(ownerApp.libraryId ? { libraryId: ownerApp.libraryId } : {}),
    ...(ownerApp.libraryRevision !== undefined ? { libraryRevision: ownerApp.libraryRevision } : {}),
    ...(ownerApp.designSpec ? { designSpec: ownerApp.designSpec } : {}),
    ...(ownerApp.source?.kind ? { sourceKind: ownerApp.source.kind } : {}),
  } : undefined, [ownerApp]);
  const load = useCallback(async (epoch = active.current.epoch) => {
    if (!origin || !app) throw new Error('Missing GenUI owner');
    const value = await accessGenUIOwner(origin, app.id, undefined, identity);
    if (active.current.key !== key || active.current.epoch !== epoch) throw new Error('GenUI source changed during owner load');
    if (genUIContentKey(value.app) !== genUIContentKey(app)) throw new Error('A newer application is accepted on the owner; open its generation before editing');
    current.current = { key, value }; setLoaded({ key, value }); setError(undefined);
    return value.state;
  }, [origin, app, identity, key]);
  useEffect(() => {
    const epoch = active.current.epoch + 1;
    active.current = { key, epoch };
    current.current = undefined;
    if (!enabled) return;
    let alive = true;
    void load(epoch).catch(error => { if (alive) setError({ key, message: error instanceof Error ? error.message : String(error) }); });
    return () => { alive = false; active.current = { key: '', epoch: epoch + 1 }; };
  }, [key, enabled, load]);
  const save = (state: GenUIAppState): Promise<void> => {
    const epoch = active.current.epoch;
    const snapshot = structuredClone(state);
    const next = queue.current.catch(() => undefined).then(async () => {
      if (!origin || !app || active.current.key !== key || active.current.epoch !== epoch || current.current?.key !== key) throw new Error('GenUI owner is not ready');
      const value = await accessGenUIOwner(origin, app.id, { revision: current.current.value.revision, state: snapshot }, identity);
      if (active.current.key !== key || active.current.epoch !== epoch) throw new Error('GenUI source changed while saving');
      if (genUIContentKey(value.app) !== genUIContentKey(app)) throw new Error('A newer application is accepted on the owner; open its generation before editing');
      // Acknowledgements advance CAS, never rehydrate an older snapshot over
      // edits made while this request was in flight. Only load/reload hydrates.
      current.current = { key, value };
    });
    queue.current = next; return next;
  };
  const reload = async () => { const epoch = active.current.epoch; await queue.current; return load(epoch); };
  return { enabled, ready: loaded?.key === key && error?.key !== key, state: loaded?.key === key ? loaded.value.state : undefined, error: error?.key === key ? error.message : undefined, save, reload };
}
