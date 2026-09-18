import { create } from 'zustand';
import type { FlowChatState } from '../types/flow-chat';
import {
  deriveBackgroundSubagentActivity,
  deriveBackgroundSubagentActivityItemForSession,
  type BackgroundSubagentActivityItem,
} from '../utils/backgroundSubagentActivity';

interface BackgroundSubagentActivityState {
  activities: Record<string, BackgroundSubagentActivityItem>;
  reconcileParent: (state: FlowChatState, parentSessionId: string | undefined | null) => void;
  reconcileSession: (state: FlowChatState, subagentSessionId: string | undefined | null) => void;
  removeSession: (sessionId: string | undefined | null) => void;
  removeSessions: (sessionIds: Iterable<string>) => void;
  clear: () => void;
}

function sortByCreatedAt(
  left: BackgroundSubagentActivityItem,
  right: BackgroundSubagentActivityItem,
): number {
  return left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId);
}

function isSameActivity(
  left: BackgroundSubagentActivityItem | undefined,
  right: BackgroundSubagentActivityItem,
): boolean {
  return !!left &&
    left.parentSessionId === right.parentSessionId &&
    left.title === right.title &&
    left.agentType === right.agentType &&
    left.status === right.status &&
    left.workspaceId === right.workspaceId &&
    left.workspacePath === right.workspacePath &&
    left.remoteConnectionId === right.remoteConnectionId &&
    left.remoteSshHost === right.remoteSshHost &&
    left.parentToolCallId === right.parentToolCallId &&
    left.subagentType === right.subagentType &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt;
}

export const useBackgroundSubagentActivityStore = create<BackgroundSubagentActivityState>((set) => ({
  activities: {},

  reconcileParent: (flowState, parentSessionId) => {
    if (!parentSessionId) {
      return;
    }

    const activity = deriveBackgroundSubagentActivity(flowState, parentSessionId);
    set((state) => {
      const nextActivities = { ...state.activities };
      for (const [sessionId, item] of Object.entries(nextActivities)) {
        if (item.parentSessionId === parentSessionId) {
          delete nextActivities[sessionId];
        }
      }
      for (const item of activity.items) {
        nextActivities[item.sessionId] = item;
      }
      return { activities: nextActivities };
    });
  },

  reconcileSession: (flowState, subagentSessionId) => {
    if (!subagentSessionId) {
      return;
    }

    const item = deriveBackgroundSubagentActivityItemForSession(flowState, subagentSessionId);
    set((state) => {
      const previous = state.activities[subagentSessionId];
      if (!item) {
        if (!previous) {
          return state;
        }
        const nextActivities = { ...state.activities };
        delete nextActivities[subagentSessionId];
        return { activities: nextActivities };
      }

      if (isSameActivity(previous, item)) {
        return state;
      }

      return {
        activities: {
          ...state.activities,
          [item.sessionId]: item,
        },
      };
    });
  },

  removeSession: (sessionId) => {
    if (!sessionId) {
      return;
    }

    set((state) => {
      if (!state.activities[sessionId]) {
        return state;
      }
      const nextActivities = { ...state.activities };
      delete nextActivities[sessionId];
      return { activities: nextActivities };
    });
  },

  removeSessions: (sessionIds) => {
    const sessionIdSet = new Set(sessionIds);
    if (sessionIdSet.size === 0) {
      return;
    }

    set((state) => {
      let changed = false;
      const nextActivities = { ...state.activities };
      for (const sessionId of sessionIdSet) {
        if (nextActivities[sessionId]) {
          delete nextActivities[sessionId];
          changed = true;
        }
      }
      return changed ? { activities: nextActivities } : state;
    });
  },

  clear: () => {
    set({ activities: {} });
  },
}));

export function visibleBackgroundSubagentActivitiesForSession(
  activities: Record<string, BackgroundSubagentActivityItem>,
  parentSessionId: string | undefined | null,
): BackgroundSubagentActivityItem[] {
  if (!parentSessionId) {
    return [];
  }

  return Object.values(activities)
    .filter(activity => activity.parentSessionId === parentSessionId)
    .sort(sortByCreatedAt);
}
