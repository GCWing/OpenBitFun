import {
  ActiveTurnSnapshotResponse,
  ChatMessage,
  ChatMessageItemResponse,
  ChatMessageResponse,
  InitialSyncResponse,
  RecentWorkspaceEntry,
  RecentWorkspaceEntryResponse,
  RemoteSession,
  RemoteToolStatusResponse,
  SessionItemResponse,
  WorkspaceInfo,
  WorkspaceInfoResponse
} from '../model/RemoteModels';

export class RemoteResponseMapper {
  static workspaceFromInitialSync(response: InitialSyncResponse): WorkspaceInfo {
    const workspacePath = response.path || '';
    const workspaceName = response.project_name || RemoteResponseMapper.basename(workspacePath);
    return {
      workspaceId: response.workspace_id,
      path: workspacePath,
      name: workspaceName || 'Workspace',
      hasWorkspace: response.has_workspace !== false && workspacePath.length > 0,
      gitBranch: response.git_branch || '',
      workspaceKind: response.workspace_kind || 'normal',
      assistantId: response.assistant_id,
      remoteConnectionId: (response.workspace_kind === 'normal' || response.workspace_kind === 'assistant') ? undefined : response.remote_connection_id,
      remoteSshHost: (response.workspace_kind === 'normal' || response.workspace_kind === 'assistant') ? undefined : response.remote_ssh_host
    };
  }

  static workspaceFromResponse(response: WorkspaceInfoResponse): WorkspaceInfo {
    const workspacePath = response.path || response.workspace_path || '';
    const workspaceName = response.project_name || response.workspace_name || RemoteResponseMapper.basename(workspacePath);
    return {
      workspaceId: response.workspace_id,
      path: workspacePath,
      name: workspaceName || 'Workspace',
      hasWorkspace: response.has_workspace !== false && workspacePath.length > 0,
      gitBranch: response.git_branch || '',
      workspaceKind: response.workspace_kind || 'normal',
      assistantId: response.assistant_id,
      remoteConnectionId: (response.workspace_kind === 'normal' || response.workspace_kind === 'assistant') ? undefined : response.remote_connection_id,
      remoteSshHost: (response.workspace_kind === 'normal' || response.workspace_kind === 'assistant') ? undefined : response.remote_ssh_host
    };
  }

  static recentWorkspaces(items: RecentWorkspaceEntryResponse[]): RecentWorkspaceEntry[] {
    return items.map((item: RecentWorkspaceEntryResponse) => {
      const workspace: RecentWorkspaceEntry = {
        workspaceId: item.workspace_id,
        path: item.path || '',
        name: item.name || RemoteResponseMapper.basename(item.path || '') || 'Workspace',
        lastOpened: RemoteResponseMapper.firstTimeValue([
          item.last_opened,
          item.lastOpened,
          item.updated_at,
          item.updatedAt
        ]),
        remoteSshHost: (item.workspace_kind === 'normal' || item.workspace_kind === 'assistant') ? undefined : item.remote_ssh_host,
        remoteConnectionId: (item.workspace_kind === 'normal' || item.workspace_kind === 'assistant') ? undefined : item.remote_connection_id,
        workspaceKind: item.workspace_kind || 'normal'
      };
      return workspace;
    }).filter((item: RecentWorkspaceEntry) => item.path.length > 0);
  }

  static sessions(items: SessionItemResponse[]): RemoteSession[] {
    return RemoteResponseMapper.visibleSessions(RemoteResponseMapper.allSessions(items));
  }

  /** Maps a server page before mobile-only visibility rules are applied. */
  static allSessions(items: SessionItemResponse[]): RemoteSession[] {
    return items.map((item: SessionItemResponse) => {
      const id = item.id || item.session_id || '';
      const session: RemoteSession = {
        id,
        title: item.title || item.name || `Session ${id.slice(0, 6)}`,
        agentType: item.agent_type || 'code',
        status: item.status || 'idle',
        updatedAt: RemoteResponseMapper.firstTimeValue([
          item.updated_at,
          item.updatedAt,
          item.updated,
          item.updated_time,
          item.update_time,
          item.modified_at,
          item.last_active_at,
          item.last_activity_at,
          item.last_message_at,
          item.last_interaction_at,
          item.lastUpdated,
          item.lastActivityAt,
          item.lastMessageAt,
          item.timestamp
        ]),
        createdAt: RemoteResponseMapper.firstTimeValue([
          item.created_at,
          item.createdAt,
          item.created,
          item.created_time,
          item.create_time,
          item.inserted_at,
          item.started_at,
          item.start_time
        ]),
        messageCount: item.message_count || 0,
        workspacePath: item.workspace_path,
        workspaceName: item.workspace_name,
        parentSessionId: item.parent_session_id,
        relationshipKind: item.relationship_kind
      };
      // An ID-aware host pins every session to its workspace record. Keep that
      // ID as the identity; the listing scope may later fill in display facts.
      const workspaceId = (item.workspace_id || '').trim();
      if (workspaceId.length > 0) {
        session.workspaceIdentity = { workspaceId: workspaceId, path: item.workspace_path || '' };
      }
      return session;
    });
  }

  /**
   * ACP sessions are created on Desktop and are not controllable on HarmonyOS.
   * Child sessions (Desktop's 侧问 / review / miniapp / subagent) belong under
   * their parent, so they must not appear as standalone conversations.
   */
  static visibleSessions(sessions: RemoteSession[]): RemoteSession[] {
    return sessions.filter((session: RemoteSession) => RemoteResponseMapper.isVisibleSession(session));
  }

  static isVisibleSession(session: RemoteSession): boolean {
    if ((session.agentType || '').trim().toLowerCase().startsWith('acp:')) {
      return false;
    }
    return !RemoteResponseMapper.isChildSession(session);
  }

  static isChildSession(session: RemoteSession): boolean {
    return (session.parentSessionId || '').trim().length > 0;
  }

  static chatMessage(item: ChatMessageResponse): ChatMessage {
    const text = RemoteResponseMapper.messageText(item);
    const tools = RemoteResponseMapper.toolsFromExplicitOrItems(item.tools || [], item.items || []);
    const message: ChatMessage = {
      id: RemoteResponseMapper.messageId(item, text),
      turnId: item.turn_id,
      role: item.role,
      text: text || item.content || '',
      status: item.status || (item.role === 'assistant' ? 'done' : 'sent'),
      detail: RemoteResponseMapper.messageDetail(tools),
      error: item.error,
      timestamp: item.timestamp,
      thinking: item.thinking,
      tools,
      items: item.items || [],
      images: item.images || []
    };
    return message;
  }

  static activeTurnToMessage(turn: ActiveTurnSnapshotResponse, renderVersion: number = 0): ChatMessage {
    const body = RemoteResponseMapper.activeTurnText(turn);
    const tools = RemoteResponseMapper.toolsFromExplicitOrItems(turn.tools || [], turn.items || []);
    const message: ChatMessage = {
      id: `active-${turn.turn_id}`,
      turnId: turn.turn_id,
      role: 'assistant',
      text: body,
      status: turn.status || 'active',
      renderVersion,
      detail: RemoteResponseMapper.messageDetail(tools),
      error: turn.error,
      thinking: turn.thinking,
      tools,
      items: turn.items || []
    };
    return message;
  }

  static basename(path: string): string {
    if (!path) {
      return '';
    }
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  private static messageText(item: ChatMessageResponse): string {
    if (item.content && item.content.trim().length > 0) {
      return item.content;
    }
    const topLevelText = RemoteResponseMapper.lastTopLevelText(item.items || []);
    if (topLevelText.length > 0) {
      return topLevelText;
    }
    return '';
  }

  private static messageId(item: ChatMessageResponse, text: string): string {
    if (item.id && item.id.length > 0) {
      return item.id;
    }
    if (item.message_id && item.message_id.length > 0) {
      return item.message_id;
    }
    const timestamp = item.timestamp || '';
    return `${item.role || 'message'}-${timestamp}-${RemoteResponseMapper.stableTextHash(text || item.content || '')}`;
  }

  private static stableTextHash(text: string): string {
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private static activeTurnText(turn: ActiveTurnSnapshotResponse): string {
    if (turn.text && turn.text.trim().length > 0) {
      return turn.text;
    }
    const topLevelText = RemoteResponseMapper.lastTopLevelText(turn.items || []);
    if (topLevelText.length > 0) {
      return topLevelText;
    }
    return '';
  }

  private static lastTopLevelText(items: ChatMessageItemResponse[]): string {
    for (let index = items.length - 1; index >= 0; index--) {
      if (RemoteResponseMapper.isFinalTextItem(items[index])) {
        return (items[index].content || '').trim();
      }
    }
    return '';
  }

  private static isFinalTextItem(item: ChatMessageItemResponse): boolean {
    const type = (item.type || '').toLowerCase();
    if ((item.content || '').trim().length === 0 || item.tool || item.is_subagent === true) {
      return false;
    }
    if (type === 'thinking' || type === 'user-steering' || type === 'tool' ||
      type === 'subagent' || type === 'agent') {
      return false;
    }
    return type === 'text' || type === 'message' || type.length === 0;
  }

  private static firstTimeValue(values: (string | number | undefined)[]): string {
    for (const value of values) {
      if (value === undefined) {
        continue;
      }
      if (typeof value === 'number') {
        return `${value}`;
      }
      if (value.trim().length > 0) {
        return value.trim();
      }
    }
    return '';
  }

  private static toolsFromExplicitOrItems(
    explicitTools: RemoteToolStatusResponse[],
    items: ChatMessageItemResponse[]
  ): RemoteToolStatusResponse[] {
    if (explicitTools.length > 0) {
      return explicitTools;
    }
    return RemoteResponseMapper.itemTools(items);
  }

  private static messageDetail(tools: RemoteToolStatusResponse[]): string {
    if (tools.length === 0) {
      return '';
    }
    const labels: string[] = [];
    tools.forEach((tool: RemoteToolStatusResponse) => {
      labels.push(`${tool.name || 'Tool'} · ${tool.status || 'pending'}`);
    });
    return labels.join('\n');
  }

  private static itemTools(items: ChatMessageItemResponse[]): RemoteToolStatusResponse[] {
    const tools: RemoteToolStatusResponse[] = [];
    items.forEach((item: ChatMessageItemResponse) => {
      if (item.tool) {
        tools.push(item.tool);
      }
      if (item.subItems) {
        RemoteResponseMapper.itemTools(item.subItems).forEach((tool: RemoteToolStatusResponse) => {
          tools.push(tool);
        });
      }
    });
    return tools;
  }
}
