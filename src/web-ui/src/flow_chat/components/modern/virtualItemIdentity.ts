import type { VirtualItem } from '../../store/modernFlowChatStore';

/** Stable identity shared by React, the virtualizer and viewport snapshots. */
export function getVirtualItemStableKey(item: VirtualItem): string {
  if (item.timeline) return `block:${item.timeline.key}`;
  switch (item.type) {
    case 'background-run':
      return `${item.type}:${item.turnId}`;
    case 'user-message':
      return item.presentationKey ?? `${item.type}:${item.turnId}:${item.data.id}`;
    case 'user-steering-message':
      return `${item.type}:${item.turnId}:${item.data.id}`;
    case 'model-round':
      return `${item.type}:${item.turnId}:${item.data.id}`;
    case 'explore-group':
      return `${item.type}:${item.turnId}:${item.data.groupId}`;
    case 'turn-completion-notice':
      return `${item.type}:${item.turnId}:${item.data.reasonCode}`;
    case 'turn-failure-notice':
    case 'image-analyzing':
      return `${item.type}:${item.turnId}`;
  }
}

/** Bookmarks use host IDs even while a mounted row retains its live stream key. */
export function getVirtualItemBookmarkKey(item: VirtualItem): string {
  const block = item.timeline;
  if (item.type === 'model-round' && block && (block.kind === 'content' || block.kind === 'group-members') && block.memberIds.length) {
    const start = block.markdownSection?.start ?? 0;
    return `block:${item.turnId}:${block.memberIds[0]}${start > 0 ? `:markdown:${start}` : ''}`;
  }
  return getVirtualItemStableKey(item);
}
