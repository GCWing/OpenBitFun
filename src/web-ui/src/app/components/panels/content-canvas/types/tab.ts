import type { PanelContent } from './content';
import type { EditorGroupId } from './layout';

/**
 * Tab states
 * - preview: italic title, single-click replace, no close button
 * - active: normal title, auto-upgrades on edit, with close button
 * - pinned: pinned icon, not replaced, close manually
 */
export type TabState = 'preview' | 'active' | 'pinned';

/**
 * Canvas tab data.
 */
export interface CanvasTab {
  /** Unique identifier */
  id: string;
  /** Stable document identity across main/side-pane moves; absent in legacy tabs. */
  documentId?: string;
  /** Display title */
  title: string;
  /** Tab content */
  content: PanelContent;
  /** Tab state */
  state: TabState;
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** File path no longer exists on disk (or is not a file); tab title shows a deleted label */
  fileDeletedFromDisk?: boolean;
  /** Whether hidden (for persistent sessions like terminal) */
  isHidden?: boolean;
  /** Created timestamp */
  createdAt: number;
  /** Last accessed timestamp */
  lastAccessedAt: number;
}

export const canvasTabDocumentId = (tab: Pick<CanvasTab, 'id' | 'documentId'>): string =>
  tab.documentId ?? `canvas:${tab.id}`;

/**
 * Editor group state (tab collection within a column).
 */
export interface EditorGroupState {
  /** Tabs in group */
  tabs: CanvasTab[];
  /** Active tab ID */
  activeTabId: string | null;
}

/**
 * Tab drag payload.
 */
export interface TabDragPayload {
  tabId: string;
  sourceGroupId: EditorGroupId;
  tab: CanvasTab;
}

/**
 * Tab action callbacks.
 */
export interface TabActions {
  /** Click tab */
  onTabClick: (tabId: string) => void;
  /** Double-click tab */
  onTabDoubleClick: (tabId: string) => void;
  /** Close tab */
  onTabClose: (tabId: string) => Promise<void>;
  /** Pin/unpin tab */
  onTabPin: (tabId: string) => void;
  /** Start dragging tab */
  onTabDragStart: (payload: TabDragPayload) => void;
  /** End dragging tab */
  onTabDragEnd: () => void;
}

/**
 * Tab visual props.
 */
export interface TabVisualProps {
  /** Whether active tab */
  isActive: boolean;
  /** Whether being dragged */
  isDragging: boolean;
  /** Show close button (on hover) */
  showCloseButton: boolean;
}

/**
 * Recently closed tab (for restore).
 */
export interface ClosedTabRecord {
  tab: CanvasTab;
  closedAt: number;
  groupId: EditorGroupId;
  index: number;
}

/**
 * Generate a tab ID.
 */
export const generateTabId = (): string => {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * Create a new tab.
 */
export const createTab = (
  content: PanelContent,
  state: TabState = 'preview'
): CanvasTab => {
  const now = Date.now();
  return {
    id: generateTabId(),
    // Older terminal tab payloads shortened title but retained the full session name.
    title: content.type === 'terminal' && typeof content.data?.sessionName === 'string'
      ? content.data.sessionName
      : content.title,
    content,
    state,
    isDirty: false,
    createdAt: now,
    lastAccessedAt: now,
  };
};
