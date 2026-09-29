import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { prewarmMarkdownParse } from '@/infrastructure/markdown/markdownParseCache';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowGroupToolLabels } from '../grouping/browse';
import { useFlowChatVolatileContext } from '../components/modern/FlowChatContext';
import type { VirtualItem } from '../types/flow-chat-projection';
import { ConversationDocumentProjection } from './document';
import { useFlowChatReaderScope } from './readerState';

export function useConversationTimeline(sources: VirtualItem[], sessionId: string | undefined, viewport: string) {
  const { t } = useI18n('flow-chat');
  const surface = getActiveSurfaceScope();
  const reader = useFlowChatReaderScope(`${surface.epoch}:${viewport}:${sessionId ?? ''}`);
  const revision = useSyncExternalStore(reader.subscribeProjection, reader.getProjectionRevision, reader.getProjectionRevision);
  const { groupStates, exploreGroupStates, expandedToolCapsules, pendingPermissionToolCallIds } = useFlowChatVolatileContext();
  const projectionRef = useRef<{ reader: typeof reader; value: ConversationDocumentProjection } | null>(null);
  if (projectionRef.current?.reader !== reader) {
    projectionRef.current = { reader, value: new ConversationDocumentProjection() };
  }
  const projection = projectionRef.current.value;
  const labels = useMemo(() => flowGroupToolLabels(t), [t]);
  useEffect(() => {
    const texts = new Set<string>();
    for (const source of sources) {
      const members = source.type === 'explore-group' ? source.data.allItems
        : source.type === 'model-round' ? source.projectedGroups?.flatMap(group => group.type === 'critical' ? [group.item]
          : group.projection?.allItems ?? group.items) ?? source.data.items : [];
      for (const member of members) if (member.type === 'text' && !('isStreaming' in member && member.isStreaming)
        && 'content' in member && typeof member.content === 'string' && member.content.length >= 2000) texts.add(member.content);
    }
    const cancel = [...texts].map(prewarmMarkdownParse);
    return () => cancel.forEach(stop => stop());
  }, [sources]);
  const items = useMemo(() => {
    // Reader mutations can change a projection while the source array is stable.
    void revision;
    return projection.project(sources, {
      reader, sessionId, groupStates: groupStates ?? exploreGroupStates,
      expandedToolCapsules, pendingPermissionToolCallIds, toolLabels: labels,
    });
  }, [projection, sources, reader, sessionId, revision, groupStates, exploreGroupStates, expandedToolCapsules, pendingPermissionToolCallIds, labels]);
  return { items, reader };
}
