import {
  Bot as LucideBot,
  MessageSquare as LucideMessageSquare,
  Users as LucideUsers,
} from 'lucide-react';
import React from 'react';
import type { RecentWorkspaceEntry } from '../services/RemoteSessionManager';
import { sessionIconKind, type SessionIconKind } from '../services/workspaceIdentity';

const SESSION_ICONS: Record<SessionIconKind, typeof LucideBot> = {
  assistant: LucideBot,
  cowork: LucideUsers,
  code: LucideMessageSquare,
};

/**
 * Shared session-type icon: assistant entries, Claw history rows, the resume
 * card and the compact sidebar all resolve through `sessionIconKind`.
 */
export function SessionTypeIcon({
  agentType,
  workspaceKind,
  size = 18,
}: {
  agentType?: string;
  workspaceKind?: RecentWorkspaceEntry['workspace_kind'];
  size?: number;
}) {
  const Icon = SESSION_ICONS[sessionIconKind(agentType, workspaceKind)];
  return <Icon width={size} height={size} stroke="currentColor" aria-hidden="true" />;
}
