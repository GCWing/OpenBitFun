import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../store/FlowChatStore';
import {
  endSessionMutation,
  tryBeginSessionMutation,
} from '../store/sessionMutationStore';
import { resolveMaterializedSessionTurnIdentity } from '../utils/flowChatTurnIdentity';
import { rollbackSessionToTurn } from './SessionRollbackService';

const log = createLogger('UserMessageEditService');

export interface UserMessageEditImpact {
  willStopRunningTask: boolean;
  willRestoreFiles: boolean;
  willDeleteTurns: boolean;
  willRerun: boolean;
}

export interface EditAndRerunUserMessageRequest {
  sessionId: string;
  turnId: string;
  originalContent: string;
  editedContent: string;
  agentType?: string;
  rerun: (content: string, agentType: string | undefined, leaseId: string) => Promise<void>;
}

export function describeUserMessageEditImpact(_sessionId: string): UserMessageEditImpact {
  return {
    willStopRunningTask: false,
    willRestoreFiles: true,
    willDeleteTurns: true,
    willRerun: true,
  };
}

export async function editAndRerunUserMessage(
  request: EditAndRerunUserMessageRequest,
): Promise<void> {
  const trimmedEditedContent = request.editedContent.trim();
  if (!trimmedEditedContent) {
    throw new Error('Edited message cannot be empty');
  }

  if (trimmedEditedContent === request.originalContent.trim()) {
    return;
  }

  const session = flowChatStore.getState().sessions.get(request.sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${request.sessionId}`);
  }

  const targetTurn = resolveMaterializedSessionTurnIdentity(
    session,
    flowChatStore.getSessionHistoryViewState(request.sessionId),
    request.turnId,
  )?.turn;
  if (!targetTurn) {
    throw new Error('Message edit target is no longer available');
  }

  const triggerSource = targetTurn.userMessage.metadata?.triggerSource;
  if (triggerSource && triggerSource !== 'desktop_ui') {
    throw new Error('Only messages sent from the desktop chat input can be edited');
  }

  log.info('Editing user message and rerunning from turn', {
    sessionId: request.sessionId,
    turnId: request.turnId,
  });

  const lease = tryBeginSessionMutation(request.sessionId, 'edit-rerun', request.turnId);
  if (!lease) {
    throw new Error('Another Session history mutation is already in progress');
  }
  try {
    await rollbackSessionToTurn({
      sessionId: request.sessionId,
      targetTurnId: request.turnId,
      kind: 'edit-rerun',
      lease,
    });

    await request.rerun(trimmedEditedContent, request.agentType, lease.leaseId);
  } finally {
    endSessionMutation(lease);
  }
}
