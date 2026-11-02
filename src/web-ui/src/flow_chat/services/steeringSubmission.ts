import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import type { SteeringImage } from '../types/flow-chat';
import { insertSteeringItemIfAbsent } from './flow-chat-manager/EventHandlerModule';

const log = createLogger('SteeringSubmission');

/** Legacy send-now transport, shared by queued messages and inline follow-ups. */
export async function submitSteeringMessage(
  request: Parameters<typeof agentAPI.steerDialogTurn>[0],
  images?: SteeringImage[],
): Promise<void> {
  const surfaceScope = getActiveSurfaceScope();
  surfaceScope.assertCurrent('submit steering message');
  const response = await agentAPI.steerDialogTurn(request);
  surfaceScope.assertCurrent('accept steering message');
  if (!response.success || !response.steeringId) {
    throw new Error('Host did not acknowledge the steering message');
  }
  try {
    insertSteeringItemIfAbsent({
      sessionId: request.sessionId,
      turnId: request.dialogTurnId,
      steeringId: response.steeringId,
      content: request.displayContent ?? request.content,
      images,
      status: 'pending',
    });
  } catch (error) {
    // The host already accepted this message. A projection failure must not
    // invite a duplicate submission; the authoritative event can render it.
    log.warn('Optimistic steering render failed', { error });
  }
}
