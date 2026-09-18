import { ImagePickerService } from '../../services/ImagePickerService';
import { ClipboardService } from '../../services/ClipboardService';
import { RemoteChatCache } from '../../services/RemoteChatCache';
import { RemoteChatCommandController } from '../../services/RemoteChatCommandController';
import { RemoteChatPollingLifecycleController } from '../../services/RemoteChatPollingLifecycleController';
import { RemoteFileDownloadController } from '../../services/RemoteFileDownloadController';
import { RemoteModelController } from '../../services/RemoteModelController';
import { RemoteToolActionController } from '../../services/RemoteToolActionController';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { RemoteWorkspaceCoordinator } from '../../services/RemoteWorkspaceCoordinator';
import { AppRoute, AppRouteContract } from '../navigation/AppRouteContract';
import { ConversationViewModel } from './ConversationViewModel';
import { AppShellViewModel } from './AppShellViewModel';
import { FilePreviewController } from './FilePreviewController';
import { RemoteConnectionController } from './RemoteConnectionController';
import { RemoteSessionViewModel } from './RemoteSessionViewModel';
import { SettingsController } from './SettingsController';


export interface ConversationControllerHooks {
  readonly currentRoute: () => AppRoute;
}

export interface RemoteConversationHooks {
  readonly isConversationContext: (sessionId: string) => boolean;
  readonly isFilePreviewVisible: () => boolean;
  readonly stopVoiceInput: () => Promise<void>;
  readonly showToast: (message: string) => boolean;
  readonly selectAssistantWorkspace: (path: string, workspaceId?: string) => Promise<void>;
}

export interface RemoteConversationDependencies {
  readonly timeline: ConversationViewModel;
  readonly chat: RemoteChatCommandController;
  readonly chatCache: RemoteChatCache;
  readonly polling: RemoteChatPollingLifecycleController;
  readonly models: RemoteModelController;
  readonly files: RemoteFileDownloadController;
  readonly tools: RemoteToolActionController;
  readonly connection: RemoteConnectionController;
  readonly imagePicker: ImagePickerService;
  readonly clipboard: ClipboardService;
  readonly sessions: RemoteSessionViewModel;
  readonly sessionManager: RemoteSessionManager;
  readonly workspace: RemoteWorkspaceCoordinator;
  readonly settings: SettingsController;
  readonly appShell: AppShellViewModel;
  readonly filePreview: FilePreviewController;
  readonly hooks: RemoteConversationHooks;
}

export function requireRemoteRuntime(
  remoteRuntime?: RemoteConversationDependencies
): RemoteConversationDependencies {
  if (!remoteRuntime) {
    throw new Error('Remote conversation dependencies are not configured.');
  }
  return remoteRuntime;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId :
    sessionId.slice(0, 4) + '...' + sessionId.slice(sessionId.length - 4);
}

export function routeCreatedRemoteSession(
  sessionId: string,
  remoteRuntime: RemoteConversationDependencies,
  setDismissed: (dismissed: boolean) => void
): void {
  remoteRuntime.filePreview.close();
  setDismissed(false);
  if (remoteRuntime.appShell.isRoute(AppRoute.RemoteChat)) {
    return;
  }
  remoteRuntime.appShell.pushRoute(AppRoute.RemoteChat, sessionId);
}

export function routeRemoteSessionInPlace(
  sessionId: string,
  remoteRuntime: RemoteConversationDependencies,
  setDismissed: (dismissed: boolean) => void
): void {
  remoteRuntime.filePreview.close();
  setDismissed(false);
  const target = AppRouteContract.remoteSessionDestination(sessionId);
  remoteRuntime.appShell.replaceRouteWithoutAnimation(target.name, target.routeParam().sessionId);
}
