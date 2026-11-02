import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { QueueView } from '../../../../shared/dialog-queue/HostDialogQueue';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { hostDialogQueue, hostQueueSupported } from '../services/hostDialogQueue';
import { hostQueuePresentation, observePresentedHostQueue } from '../services/hostQueuePresentation';
import type { VirtualItem } from '../types/flow-chat-projection';
import { HostQueueProjection } from './hostQueueProjection';

const EMPTY: QueueView = { snapshot: null, pending: [], error: null };
const emptySnapshot = () => EMPTY;
const noopSubscribe = () => () => {};
const log = createLogger('HostQueueTimeline');

export function useHostQueueTimeline(sources: VirtualItem[], sessionId?: string) {
  const scope = getActiveSurfaceScope();
  const queue = sessionId && hostQueueSupported(sessionId) ? hostDialogQueue(sessionId) : undefined;
  const view = useSyncExternalStore(queue?.subscribe ?? noopSubscribe, queue?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const projectionRef = useRef<{
    queue: typeof queue; epoch: number; sessionId?: string; value: HostQueueProjection;
  }>();
  if (!projectionRef.current || projectionRef.current.queue !== queue
    || projectionRef.current.epoch !== scope.epoch || projectionRef.current.sessionId !== sessionId) {
    projectionRef.current = { queue, epoch: scope.epoch, sessionId, value: new HostQueueProjection() };
  }
  const projection = projectionRef.current.value;
  const result = useMemo(() => projection.project(sources, view.snapshot), [projection, sources, view.snapshot]);
  const owner = useRef({});
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!queue || !scope.isCurrent()) return;
    const stop = observePresentedHostQueue(queue);
    scope.signal.addEventListener('abort', stop, { once: true });
    return () => { scope.signal.removeEventListener('abort', stop); stop(); };
  }, [queue, scope]);
  useLayoutEffect(() => {
    if (!queue || !scope.isCurrent()) return;
    const presentation = hostQueuePresentation(queue);
    const lease = owner.current;
    const clear = () => presentation.set(lease, []);
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [queue, scope]);
  useLayoutEffect(() => {
    if (queue && scope.isCurrent()) hostQueuePresentation(queue).set(owner.current, result.hidden);
  }, [queue, scope, result]);
  useEffect(() => {
    if (!queue || !view.snapshot || view.error || !scope.isCurrent()) return;
    const epoch = view.snapshot.queueEpoch;
    for (const id of result.missing) {
      const key = `${queue.scope}:${scope.epoch}:${epoch}:${id}`;
      if (tried.current.has(key)) continue;
      tried.current.add(key);
      void queue.receipt(id, epoch).catch(error => {
        tried.current.delete(key);
        if (scope.isCurrent()) log.warn('Unable to reconcile accepted steering receipt', { sessionId, turnId: id, error });
      });
    }
  }, [queue, scope, sessionId, view, result]);
  return result.items;
}
