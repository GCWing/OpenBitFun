import { deviceWorkspaceCatalog } from '@/infrastructure/peer-device/deviceWorkspaceCatalog';
import { markAllSessionsRead } from '@/app/services/markAllSessionsRead';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { FlowChatStore } from '@/flow_chat/store/FlowChatStore';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('AgentCompanionPetCommands');

/**
 * Commands the desktop pet window asks the main window to run on its behalf.
 *
 * The pet window renders a minimal React tree (no workspace/session stores, no
 * config write path wired to the main window listeners), so every action that
 * touches product state is forwarded here through
 * `agent-companion://pet-command`.
 */
export type AgentCompanionPetCommand =
  /** Right-click menu: open the companion appearance picker in Settings. */
  | { type: 'open-pet-settings' }
  /** Right-click menu: turn the companion off ("Show Agent companion"). */
  | { type: 'close-desktop-pet' }
  /** Bubble right-click menu: the user acknowledged this bubble. */
  /** `surfaceId` names a background device that owns the session. */
  | { type: 'dismiss-task'; sessionId: string; surfaceId?: string }
  /** Bubble right-click menu: mark every session read, like the sidebar view menu. */
  | { type: 'mark-all-read' }
  /** Bubble composer: send a message straight into the bubble's session. */
  | { type: 'send-message'; sessionId: string; message: string };

/**
 * Close the companion by turning off the "Show Agent companion" setting.
 *
 * Persisting it is what makes the close stick: the settings change listener in
 * `App` runs `syncAgentCompanionDesktopWindow`, which destroys the pet window.
 */
async function closeAgentCompanionDesktopPet(): Promise<void> {
  const settings = await aiExperienceConfigService.getSettingsAsync();
  if (!settings.enable_agent_companion) {
    log.debug('Skipped closing Agent companion: it is already disabled');
    return;
  }

  await aiExperienceConfigService.saveSettings({
    enable_agent_companion: false,
  });
  log.info('Agent companion disabled from pet context menu');
}

async function openAgentCompanionPetSettings(): Promise<void> {
  const { quickActions } = await import('@/shared/services/ide-control');
  quickActions.openSettings({ pageId: 'application.pet' });
  await api.invoke('show_main_window');
  log.info('Agent companion settings opened from pet context menu');
}

/**
 * Clear the unread completion mark so the acknowledged bubble does not come
 * back with the next activity payload. Attention marks (`ask_user`,
 * `tool_confirm`) are left untouched: the session really is blocked, so the
 * pet only hides that bubble locally.
 */
function dismissAgentCompanionTask(sessionId: string): void {
  FlowChatStore.getInstance().clearSessionUnreadCompletion(sessionId);
}

async function sendAgentCompanionMessage(sessionId: string, message: string): Promise<void> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return;
  }

  const flowChatManager = FlowChatManager.getInstance();
  const session = flowChatManager.getFlowChatState().sessions.get(sessionId);
  if (!session) {
    log.warn('Skipped Agent companion message: session not found', { sessionId });
    return;
  }

  // `sendMessage` owns the busy-session decision: it queues into the pending
  // queue while a dialog turn is still running, exactly like the main composer.
  await flowChatManager.sendMessage(trimmedMessage, sessionId);
  FlowChatStore.getInstance().clearSessionUnreadCompletion(sessionId);
  log.info('Agent companion message sent from pet bubble composer', {
    sessionId,
    textLength: trimmedMessage.length,
  });
}

export async function handleAgentCompanionPetCommand(
  command: AgentCompanionPetCommand | null | undefined,
): Promise<void> {
  if (!command) {
    return;
  }

  switch (command.type) {
    case 'open-pet-settings':
      await openAgentCompanionPetSettings();
      return;
    case 'close-desktop-pet':
      await closeAgentCompanionDesktopPet();
      return;
    case 'dismiss-task':
      if (command.sessionId && command.surfaceId && command.surfaceId !== getActiveSurfaceId()) {
        // A background device's session is acknowledged on its own host.
        void deviceWorkspaceCatalog.markSessionRead(command.surfaceId, command.sessionId);
      } else if (command.sessionId) {
        dismissAgentCompanionTask(command.sessionId);
      }
      return;
    case 'mark-all-read':
      markAllSessionsRead();
      return;
    case 'send-message':
      if (command.sessionId) {
        await sendAgentCompanionMessage(command.sessionId, command.message ?? '');
      }
      return;
    default:
      log.warn('Ignored unknown Agent companion pet command', { command });
  }
}
