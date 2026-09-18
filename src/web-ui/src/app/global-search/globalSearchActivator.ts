import { appManager } from '@/app/services/AppManager';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { dispatchHistorySessionOpenIntent } from '@/flow_chat/services/sessionOpenIntent';
import {
  FLOWCHAT_FOCUS_ITEM_EVENT,
  type FlowChatFocusItemRequest,
} from '@/flow_chat/events/flowchatNavigation';
import { globalEventBus } from '@/infrastructure/event-bus';
import { openFileInBestTarget } from '@/shared/utils/tabUtils';
import { useSceneStore } from '@/app/stores/sceneStore';
import { activateProductAction } from './productActionActivator';
import { activateInteractiveCapability } from './interactiveCapabilityActivator';
import type { GlobalSearchTarget } from './types';

export interface GlobalSearchActivationContext {
  setActiveWorkspace: (workspaceId: string) => Promise<unknown>;
  selectAssistantWorkspace: (workspaceId: string) => void;
  openAssistant: (workspaceId: string) => void;
  tCommon: (key: string, options?: Record<string, unknown>) => string;
}
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function activateGlobalSearchTarget(
  target: GlobalSearchTarget,
  context: GlobalSearchActivationContext,
): Promise<void> {
  switch (target.kind) {
    case 'action':
      await activateProductAction(target.actionId, { t: context.tCommon });
      return;
    case 'workspace':
      await context.setActiveWorkspace(target.workspaceId);
      return;
    case 'assistant':
      context.selectAssistantWorkspace(target.workspaceId);
      context.openAssistant(target.workspaceId);
      await context.setActiveWorkspace(target.workspaceId);
      appManager.updateLayout({ leftPanelActiveTab: 'profile', leftPanelCollapsed: false });
      useSceneStore.getState().openScene('assistant');
      return;
    case 'session': {
      await context.setActiveWorkspace(target.workspaceId);
      const available = await flowChatStore.ensurePersistedSessionMetadata(
        target.sessionId,
        target.workspaceId,
      );
      if (!available) {
        throw new Error(context.tCommon('nav.search.errors.sessionUnavailable'));
      }
      const session = flowChatStore.getState().sessions.get(target.sessionId);
      dispatchHistorySessionOpenIntent(target.sessionId, session?.title);
      await openMainSession(target.sessionId);

      if (target.turnId || target.turnIndex) {
        await afterNextPaint();
        const request: FlowChatFocusItemRequest = {
          sessionId: target.sessionId,
          turnId: target.turnId,
          turnIndex: target.turnIndex,
          source: 'global-search',
        };
        void globalEventBus.emit(FLOWCHAT_FOCUS_ITEM_EVENT, request, 'GlobalSearch');
      }
      return;
    }
    case 'file':
      await context.setActiveWorkspace(target.workspaceId);
      openFileInBestTarget({
        filePath: target.filePath,
        fileName: target.fileName,
        workspaceId: target.workspaceId,
        workspacePath: target.workspacePath,
        jumpToLine: target.lineNumber,
      });
      return;
    case 'settings':
      useSettingsStore.getState().openDestination(target.destination);
      useSceneStore.getState().openScene('settings');
      return;
    case 'capability':
      await activateInteractiveCapability(target.capabilityId, {
        t: context.tCommon,
        itemId: target.itemId,
      });
      return;
  }
}
