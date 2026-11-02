/**
 * Content-related type definitions.
 * Reuses the shared FlexiblePanel content contract.
 */

export type { PanelContentType, PanelContent } from '../../base/types';
import type { PanelContentType } from '../../base/types';
import type { CanvasTab } from './tab';

/** BTW and subagent tabs are scoped to the primary session that opened them. */
export const isCanvasTabVisibleForSession = (
  tab: Pick<CanvasTab, 'content'>,
  activeSessionId?: string | null,
): boolean => {
  if (tab.content.type !== 'btw-session') return true;
  const parentSessionId = tab.content.data?.parentSessionId;
  return Boolean(activeSessionId && parentSessionId === activeSessionId);
};

/**
 * File viewer types (code, markdown, images, etc.).
 */
export const FILE_VIEWER_TYPES: PanelContentType[] = [
  'code-preview',
  'code-viewer',
  'code-editor',
  'markdown-viewer',
  'markdown-editor',
  'text-viewer',
  'file-viewer',
  'image-viewer',
  'pdf-viewer',
  'html-preview',
  'diff-code-editor',
  'plan-viewer',
];

/**
 * Check whether a content type is a file viewer.
 */
export const isFileViewerType = (type: PanelContentType): boolean => {
  return FILE_VIEWER_TYPES.includes(type);
};

/**
 * Options for creating a tab.
 */
export interface CreateTabOptions {
  /** Content type */
  type: PanelContentType;
  /** Title */
  title: string;
  /** Data */
  data?: any;
  /** Metadata */
  metadata?: Record<string, any>;
  /** Whether to check duplicates */
  checkDuplicate?: boolean;
  /** Duplicate check key */
  duplicateCheckKey?: string;
  /** Whether to replace existing tab */
  replaceExisting?: boolean;
  /** Target editor group */
  targetGroup?: 'primary' | 'secondary';
  /** Enable split view (auto-switch to horizontal split) */
  enableSplitView?: boolean;
}

/**
 * Create-tab event detail.
 */
export interface CreateTabEventDetail extends CreateTabOptions {
  /** App mode / target canvas */
  mode?: 'agent' | 'project' | 'git';
}

/**
 * Tab event names.
 */
export const TAB_EVENTS = {
  /** Create tab in agent mode */
  AGENT_CREATE_TAB: 'agent-create-tab',
  /** Create tab in project mode */
  /** Create tab in Git scene canvas */
  GIT_CREATE_TAB: 'git-create-tab',
  /** Expand right panel */
  EXPAND_RIGHT_PANEL: 'expand-right-panel',
  /** Create tab in the session bottom terminal panel */
  BOTTOM_TERMINAL_CREATE_TAB: 'bottom-terminal-create-tab',
  /** Expand the session bottom terminal panel */
  EXPAND_BOTTOM_TERMINAL_PANEL: 'expand-bottom-terminal-panel',
} as const;
