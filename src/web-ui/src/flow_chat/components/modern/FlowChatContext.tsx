/**
 * FlowChat context.
 * Pass callbacks and config through the tree to avoid prop drilling.
 */

import { createContext, useContext } from 'react';
import type React from 'react';
import type { Session, ToolRejectOptions } from '../../types/flow-chat';
import { type LineRange } from '@/shared/editor/LineRange';
import type { SearchMatch } from './useFlowChatSearch';

/**
 * Stable part of the FlowChat context: callbacks with stable identities plus
 * scalar session info. This value must NOT change on every streaming flush —
 * volatile per-flush state lives in {@link FlowChatVolatileContext} instead so
 * memoized message components are not re-rendered by context churn.
 */
export interface FlowChatContextValue {
  // File and panel actions
  onFileViewRequest?: (filePath: string, fileName: string, lineRange?: LineRange) => void;
  onTabOpen?: (tabInfo: any, sessionId?: string, panelType?: string) => void;
  onHttpLinkClick?: (url: string, event: React.MouseEvent<HTMLAnchorElement>) => boolean | void;
  onOpenVisualization?: (type: string, data: any) => void;

  // Tool actions
  onToolConfirm?: (toolId: string, permissionOptionId?: string, approve?: boolean) => Promise<void>;
  onToolReject?: (toolId: string, options?: ToolRejectOptions) => Promise<void>;

  // Session info (scalars only — never put the whole session object here from
  // providers that update on every streaming flush).
  sessionId?: string;
  /** Effective workspace ID of the session (session.workspaceId || session.config.workspaceId). */
  workspaceId?: string;
  /** Effective workspace path of the session (session.workspacePath || session.config.workspacePath). */
  workspacePath?: string;
  /** Effective remote connection id of the session. */
  remoteConnectionId?: string;
  /** Whether the session is a restored historical session. */
  isHistoricalSession?: boolean;
  /** Context restore state of the session (scalar mirror of session.contextRestoreState). */
  contextRestoreState?: Session['contextRestoreState'];
  /**
   * Full session override for embedded panels (e.g. BtwSessionPanel) that render
   * a session other than the active one. The main chat container intentionally
   * leaves this unset; consumers should fall back to store subscriptions or the
   * scalar fields above.
   */
  activeSessionOverride?: Session | null;
  allowUserMessageRollback?: boolean;
  allowUserMessageEdit?: boolean;
  /** Hides transcript actions when the visible projection omits internal turn input. */
  allowTranscriptExport?: boolean;

  // ========== Explore group collapse actions (stable callbacks) ==========
  /**
   * Toggle explore group expanded/collapsed state.
   */
  onExploreGroupToggle?: (groupId: string) => void;

  /**
   * Expand the specified explore group.
   */
  onExpandGroup?: (groupId: string) => void;

  /**
   * Expand all explore groups within a turn.
   */
  onExpandAllInTurn?: (turnId: string) => void;

  /**
   * Collapse the specified explore group.
   */
  onCollapseGroup?: (groupId: string) => void;
}

/**
 * Volatile part of the FlowChat context: state that legitimately changes at a
 * high frequency (search, permission highlights, explore-group expansion).
 * Only components that actually depend on these fields should subscribe.
 */
export interface FlowChatVolatileContextValue {
  /** Tool-call IDs highlighted for active permission requests, including delegated parent Task calls. */
  pendingPermissionToolCallIds?: ReadonlySet<string>;

  /**
   * Expanded/collapsed state for explore groups.
   * key: groupId, value: true means expanded.
   */
  exploreGroupStates?: Map<string, boolean>;

  // Message search state
  searchQuery?: string;
  searchMatchesByVirtualIndex?: ReadonlyMap<number, readonly SearchMatch[]>;
  searchCurrentMatch?: SearchMatch;
}

export const FlowChatContext = createContext<FlowChatContextValue>({});

export const FlowChatVolatileContext = createContext<FlowChatVolatileContextValue>({});

/**
 * FlowChat context hook (stable callbacks + session scalars).
 */
export const useFlowChatContext = () => {
  return useContext(FlowChatContext);
};

/**
 * FlowChat volatile context hook (search / permission / explore-group state).
 */
export const useFlowChatVolatileContext = () => {
  return useContext(FlowChatVolatileContext);
};
