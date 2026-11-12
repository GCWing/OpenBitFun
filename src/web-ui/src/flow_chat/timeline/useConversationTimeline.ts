import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { prewarmMarkdownParse } from '@/infrastructure/markdown/markdownParseCache';
import { markdownSections } from '@/infrastructure/markdown/markdownSections';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowGroupToolLabels } from '../grouping/browse';
import { useFlowChatVolatileContext } from '../components/modern/FlowChatContext';
import type { VirtualItem } from '../types/flow-chat-projection';
import { ConversationDocumentProjection } from './document';
import { useFlowChatReaderScope, type FlowChatReaderState } from './readerState';
import { MAX_RETAINED_SESSION_VIEWS, RetainedViewMemory } from './retainedViewMemory';
import { useHostQueueTimeline } from './useHostQueueTimeline';

/**
 * Projections of recently left views. A reopened session resumes its rows and
 * view-local key aliases instead of rebuilding them, which is also what lets
 * its retained row measurements match the keys it renders.
 */
export const retainedTimelineProjections = new RetainedViewMemory<FlowChatReaderState, ConversationDocumentProjection>(
  MAX_RETAINED_SESSION_VIEWS,
);

export function useConversationTimeline(sources: VirtualItem[], sessionId: string | undefined, viewport: string) {
  const { t } = useI18n('flow-chat');
  const transcriptSources = useHostQueueTimeline(sources, sessionId);
  const surface = getActiveSurfaceScope();
  const reader = useFlowChatReaderScope(`${surface.epoch}:${viewport}:${sessionId ?? ''}`);
  const revision = useSyncExternalStore(reader.subscribeProjection, reader.getProjectionRevision, reader.getProjectionRevision);
  const { groupStates, exploreGroupStates, expandedToolCapsules, pendingPermissionToolCallIds } = useFlowChatVolatileContext();
  const projectionRef = useRef<{ reader: typeof reader; value: ConversationDocumentProjection } | null>(null);
  if (projectionRef.current?.reader !== reader) {
    projectionRef.current = {
      reader,
      value: retainedTimelineProjections.peek(reader) ?? new ConversationDocumentProjection(),
    };
  }
  const projection = projectionRef.current.value;
  // Claim while mounted; hand back on unmount or when this view changes scope.
  useLayoutEffect(() => {
    retainedTimelineProjections.take(reader);
    return () => retainedTimelineProjections.put(reader, projection);
  }, [reader, projection]);
  const labels = useMemo(() => flowGroupToolLabels(t), [t]);
  // Every streamed flush produces a new sources array; skip texts already
  // queued or parsed instead of re-walking the whole timeline each time.
  const prewarmedTextsRef = useRef<WeakSet<object>>(new WeakSet());
  // A projected source is reused by identity only while its members are the
  // same objects, so a source already walked has nothing new to queue.
  const prewarmedSourcesRef = useRef<WeakSet<object>>(new WeakSet());
  useEffect(() => {
    const seen = prewarmedTextsRef.current;
    const seenSources = prewarmedSourcesRef.current;
    const texts = new Set<string>();
    for (const source of sources) {
      if (seenSources.has(source)) continue;
      seenSources.add(source);
      const members = source.type === 'explore-group' ? source.data.allItems
        : source.type === 'model-round' ? source.projectedGroups?.flatMap(group => group.type === 'critical' ? [group.item]
          : group.projection?.allItems ?? group.items) ?? source.data.items : [];
      for (const member of members) {
        if (member.type !== 'text' || !('content' in member) || typeof member.content !== 'string') continue;
        if ('isStreaming' in member && member.isStreaming) continue;
        if (member.content.length < 2000) continue;
        if (seen.has(member)) continue;
        seen.add(member);
        texts.add(member.content);
      }
    }
    // Members are complete, immutable text items, so their warmup remains
    // useful even if this view unmounts or sources change. The cache and worker
    // queue are bounded; cancelling here would make a later flush permanently
    // skip a job that never completed.
    for (const text of texts) {
      for (const section of markdownSections(text)) prewarmMarkdownParse(text.slice(section.start, section.end));
    }
  }, [sources]);
  const items = useMemo(() => {
    // Reader mutations can change a projection while the source array is stable.
    void revision;
    return projection.project(transcriptSources, {
      reader, sessionId, groupStates: groupStates ?? exploreGroupStates,
      expandedToolCapsules, pendingPermissionToolCallIds, toolLabels: labels,
    });
  }, [projection, transcriptSources, reader, sessionId, revision, groupStates, exploreGroupStates, expandedToolCapsules, pendingPermissionToolCallIds, labels]);
  return { items, reader };
}
