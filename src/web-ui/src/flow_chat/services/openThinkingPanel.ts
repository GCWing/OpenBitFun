import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { createTab } from '@/shared/utils/tabUtils';
import type { FlowThinkingItem } from '../types/flow-chat';
import type { FlowChatFocusItemRequest } from '../events/flowchatNavigation';

export interface ThinkingDetailPanelData {
  surfaceId: string;
  sessionId?: string;
  thinkingItem: FlowThinkingItem;
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  /** Location in the conversation that opened the reader, including projected items. */
  navigationTarget?: Pick<FlowChatFocusItemRequest, 'sessionId' | 'turnId' | 'itemId'>;
}

export function openThinkingPanel({ title, ...source }: Omit<ThinkingDetailPanelData, 'surfaceId'> & { title: string }): void {
  const surfaceId = getActiveSurfaceId();
  // The canvas owns one reader. Selecting another thought replaces its source.
  const duplicateCheckKey = 'thinking-detail';
  createTab({
    type: 'thinking-detail',
    title,
    data: { ...source, surfaceId } satisfies ThinkingDetailPanelData,
    metadata: { duplicateCheckKey, sessionId: source.sessionId, contentRole: 'thinking-detail' },
    checkDuplicate: true,
    duplicateCheckKey,
    replaceExisting: true,
    mode: 'agent',
  });
}
