import {
  CreateSessionOptions,
  RemoteCommand,
  RemoteImageContext,
  RemotePermissionMode,
  RemoteQuestionAnswerPayload,
  RemoteWorkspaceIdentity
} from '../model/RemoteModels';

/**
 * Builds the RemoteCommand wire shapes.
 *
 * Workspace references follow one rule: when the caller knows the
 * `workspaceId`, the command carries only `workspace_id`, so an ID-aware host
 * can never silently fall back to a path. The legacy `(path, connection,
 * ssh host)` projection is sent only for references that never had an ID.
 */
export class RemoteCommandFactory {
  static getWorkspaceInfo(): RemoteCommand {
    return { cmd: 'get_workspace_info' };
  }

  static listRecentWorkspaces(): RemoteCommand {
    return { cmd: 'list_recent_workspaces' };
  }

  static setWorkspace(path: string, workspaceId?: string, remoteConnectionId?: string, remoteSshHost?: string): RemoteCommand {
    if (workspaceId) {
      return { cmd: 'set_workspace', workspace_id: workspaceId };
    }
    // Upgrade-only command for pre-ID references: the host resolves the path
    // through its legacy resolver and rejects unknown or ambiguous roots.
    const command: RemoteCommand = {
      cmd: 'set_workspace',
      path
    };
    if (remoteConnectionId !== undefined) {
      command.remote_connection_id = remoteConnectionId;
    }
    if (remoteSshHost !== undefined) {
      command.remote_ssh_host = remoteSshHost;
    }
    return command;
  }

  static listAssistants(): RemoteCommand {
    return { cmd: 'list_assistants' };
  }

  static setAssistant(path: string, workspaceId?: string): RemoteCommand {
    if (workspaceId) {
      return { cmd: 'set_assistant', workspace_id: workspaceId };
    }
    return {
      cmd: 'set_assistant',
      path
    };
  }

  static listSessions(workspace: RemoteWorkspaceIdentity, limit: number, offset: number, query: string): RemoteCommand {
    const command: RemoteCommand = { cmd: 'list_sessions' };
    if (workspace.workspaceId) {
      command.workspace_id = workspace.workspaceId;
    } else {
      command.workspace_path = workspace.path;
    }
    command.limit = limit;
    command.offset = offset;
    if (query.trim().length > 0) {
      command.query = query.trim();
    }
    if (!workspace.workspaceId) {
      if (workspace.remoteConnectionId !== undefined) {
        command.remote_connection_id = workspace.remoteConnectionId;
      }
      if (workspace.remoteSshHost !== undefined) {
        command.remote_ssh_host = workspace.remoteSshHost;
      }
    }
    return command;
  }

  static createSession(options: CreateSessionOptions, workspacePath: string): RemoteCommand {
    const normalizedAgentType = (options.agentType || '').toLowerCase();
    const defaultTitle = normalizedAgentType === 'claw' || normalizedAgentType === 'assistant' || normalizedAgentType === 'chat' ?
      'Remote Assistant Session' : normalizedAgentType === 'cowork' ? 'Remote Cowork Session' : 'Remote Code Session';
    const command: RemoteCommand = {
      cmd: 'create_session',
      agent_type: options.agentType,
      session_name: options.title.trim() || defaultTitle
    };
    if (options.workspaceId) {
      command.workspace_id = options.workspaceId;
      return command;
    }
    if (workspacePath) {
      command.workspace_path = workspacePath;
      command.remote_connection_id = options.remoteConnectionId || '';
      command.remote_ssh_host = options.remoteSshHost;
    }
    return command;
  }

  static sendMessage(
    sessionId: string,
    text: string,
    agentType?: string,
    imageContexts?: RemoteImageContext[],
    turnId?: string
  ): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'send_message',
      session_id: sessionId,
      content: text
    };
    if (agentType && agentType.length > 0) {
      command.agent_type = agentType;
    }
    if (imageContexts && imageContexts.length > 0) {
      command.image_contexts = imageContexts;
    }
    if (turnId && turnId.length > 0) {
      command.turn_id = turnId;
    }
    return command;
  }

  static steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    displayContent: string,
    imageContexts?: RemoteImageContext[]
  ): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'steer_turn',
      session_id: sessionId,
      turn_id: turnId,
      content: text,
      display_content: displayContent
    };
    if (imageContexts && imageContexts.length > 0) {
      command.image_contexts = imageContexts;
    }
    return command;
  }

  static buildPlan(sessionId: string, planFilePath: string, planName: string, agentType?: string): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'build_plan',
      session_id: sessionId,
      plan_file_path: planFilePath,
      plan_name: planName
    };
    if (agentType && agentType.length > 0) {
      command.agent_type = agentType;
    }
    return command;
  }

  static getSessionMessages(sessionId: string): RemoteCommand {
    return {
      cmd: 'get_session_messages',
      session_id: sessionId
    };
  }

  static getModelCatalog(sessionId?: string): RemoteCommand {
    const command: RemoteCommand = { cmd: 'get_model_catalog' };
    if (sessionId && sessionId.length > 0) {
      command.session_id = sessionId;
    }
    return command;
  }

  static setSessionModel(sessionId: string, modelId: string): RemoteCommand {
    return {
      cmd: 'set_session_model',
      session_id: sessionId,
      model_id: modelId
    };
  }

  static pollSession(
    sessionId: string,
    sinceVersion: number,
    knownMessageCount: number,
    knownModelCatalogVersion: number
  ): RemoteCommand {
    return {
      cmd: 'poll_session',
      session_id: sessionId,
      since_version: sinceVersion,
      known_msg_count: knownMessageCount,
      known_model_catalog_version: knownModelCatalogVersion
    };
  }

  static cancelTask(sessionId: string, turnId?: string): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'cancel_task',
      session_id: sessionId
    };
    if (turnId && turnId.length > 0) {
      command.turn_id = turnId;
    }
    return command;
  }

  static renameSession(sessionId: string, title: string): RemoteCommand {
    return {
      cmd: 'update_session_title',
      session_id: sessionId,
      title
    };
  }

  static deleteSession(sessionId: string): RemoteCommand {
    return {
      cmd: 'delete_session',
      session_id: sessionId
    };
  }

  static confirmTool(toolId: string, updatedInput?: Object): RemoteCommand {
    return {
      cmd: 'confirm_tool',
      tool_id: toolId,
      updated_input: updatedInput
    };
  }

  static rejectTool(toolId: string, reason: string): RemoteCommand {
    return {
      cmd: 'reject_tool',
      tool_id: toolId,
      reason
    };
  }

  static cancelTool(toolId: string, reason: string): RemoteCommand {
    return {
      cmd: 'cancel_tool',
      tool_id: toolId,
      reason
    };
  }

  static getPermissionMode(): RemoteCommand {
    return { cmd: 'get_permission_mode' };
  }

  static setPermissionMode(mode: RemotePermissionMode): RemoteCommand {
    return { cmd: 'set_permission_mode', mode };
  }

  static answerQuestion(toolId: string, answers: RemoteQuestionAnswerPayload): RemoteCommand {
    return {
      cmd: 'answer_question',
      tool_id: toolId,
      answers
    };
  }

  static getFileInfo(path: string, sessionId?: string): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'get_file_info',
      path
    };
    if (sessionId && sessionId.length > 0) {
      command.session_id = sessionId;
    }
    return command;
  }

  static readFileChunk(path: string, offset: number, limit: number, sessionId?: string): RemoteCommand {
    const command: RemoteCommand = {
      cmd: 'read_file_chunk',
      path,
      offset,
      limit
    };
    if (sessionId && sessionId.length > 0) {
      command.session_id = sessionId;
    }
    return command;
  }

  static ping(): RemoteCommand {
    return { cmd: 'ping' };
  }

  /**
   * Ask the paired desktop to register a keyboard-less device on the account.
   * `requestId` comes from that device rather than from here, so a retry
   * anywhere along the watch → phone → desktop chain replays one idempotent
   * relay request instead of registering a second device.
   */
  static provisionPeerDevice(deviceId: string, deviceName: string, requestId: string): RemoteCommand {
    return {
      cmd: 'provision_peer_device',
      device_id: deviceId,
      device_name: deviceName,
      request_id: requestId
    };
  }
}
