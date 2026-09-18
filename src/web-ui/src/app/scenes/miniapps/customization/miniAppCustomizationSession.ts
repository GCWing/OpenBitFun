import type { CreateSessionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '@/flow_chat/types/flow-chat';
import { isTransientTurnStatus } from '@/flow_chat/utils/dialogTurnStability';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('MiniAppCustomizationSession');

export interface BuildMiniAppCustomizationSessionRequestInput {
  sessionId: string;
  sessionName: string;
  /** Owning workspace ID; authoritative for session placement. */
  workspaceId?: string;
  /** Workspace root as an IO operand for the customization draft. */
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export function buildMiniAppCustomizationSessionRequest(
  input: BuildMiniAppCustomizationSessionRequestInput,
): CreateSessionRequest {
  return {
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    agentType: 'Standard',
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    remoteConnectionId: input.remoteConnectionId,
    remoteSshHost: input.remoteSshHost,
    sessionKind: 'subagent',
    config: {
      enableTools: true,
      safeMode: true,
      autoCompact: true,
      enableContextCompression: true,
      remoteConnectionId: input.remoteConnectionId,
      remoteSshHost: input.remoteSshHost,
    },
  };
}

export function createMiniAppCustomizationSessionId(appId: string): string {
  return `miniapp-customize-${appId}-${Date.now()}`;
}

export function isMiniAppCustomizationSessionRunning(
  session: Pick<Session, 'dialogTurns'> | null | undefined,
): boolean {
  const lastTurn = session?.dialogTurns.at(-1);
  return Boolean(lastTurn && isTransientTurnStatus(lastTurn.status));
}

export async function launchMiniAppCustomizationSession(params: {
  appId: string;
  appName: string;
  workspaceId?: string;
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  sessionName: string;
  prompt: string;
  displayMessage: string;
}): Promise<{ sessionId: string }> {
  const [
    { agentAPI },
    { FlowChatManager },
    { flowChatStore },
  ] = await Promise.all([
    import('@/infrastructure/api/service-api/AgentAPI'),
    import('@/flow_chat/services/FlowChatManager'),
    import('@/flow_chat/store/FlowChatStore'),
  ]);
  const request = buildMiniAppCustomizationSessionRequest({
    sessionId: createMiniAppCustomizationSessionId(params.appId),
    sessionName: params.sessionName,
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    remoteConnectionId: params.remoteConnectionId,
    remoteSshHost: params.remoteSshHost,
  });
  const created = await agentAPI.createSession(request);

  flowChatStore.addExternalSession(
    created.sessionId,
    created.sessionName,
    created.agentType,
    params.workspacePath,
    {
      sessionKind: 'miniapp',
      isTransient: true,
      agentBackedTransient: true,
      workspaceId: created.workspaceId ?? params.workspaceId,
    },
    params.remoteConnectionId,
    params.remoteSshHost,
  );

  await FlowChatManager.getInstance().sendMessage(
    params.prompt,
    created.sessionId,
    params.displayMessage,
    'Standard',
    undefined,
    {
      userMessageMetadata: {
        surface: 'miniapp_customization',
        appId: params.appId,
      },
    },
  );

  return { sessionId: created.sessionId };
}

export function cleanupMiniAppCustomizationSession(sessionId: string | null | undefined): void {
  if (!sessionId) {
    return;
  }

  void Promise.all([
    import('@/flow_chat/services/FlowChatManager'),
    import('@/infrastructure/api/service-api/AgentAPI'),
  ]).then(([{ FlowChatManager }, { agentAPI }]) => {
    try {
      FlowChatManager.getInstance().discardLocalSession(sessionId);
    } catch (error) {
      log.warn('Failed to remove MiniApp customization session locally', { sessionId, error });
    }

    return agentAPI.cancelSession(sessionId);
  }).catch((error) => {
    log.warn('Failed to clean up MiniApp customization session', { sessionId, error });
  });
}
