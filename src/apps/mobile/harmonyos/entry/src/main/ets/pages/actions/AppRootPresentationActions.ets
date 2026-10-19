import { WorkspaceToolsIntent } from '../state/WorkspaceToolsState';
import { RemotePermissionMode, RemoteSession } from '../../model/RemoteModels';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { ConversationIntent } from './ConversationIntent';
import { AppRoute } from '../navigation/AppRouteContract';

export interface AppRootPresentationActions {
  readonly onWorkspaceTools: (intent: WorkspaceToolsIntent) => void;
  readonly onNavigationBack: (route: AppRoute) => boolean;
  readonly onConversationIntent: (route: AppRoute, intent: ConversationIntent) => void;
  readonly onCloseSidebar: () => void;
  readonly onCompactLayoutEntered: () => void;
  readonly onLayoutModeChanged: (wideLayout: boolean) => void;
  readonly onRemoteHome: RemoteHomePresentationActions;
  readonly onSidebar: SidebarPresentationActions;
  readonly onSettings: SettingsPresentationActions;
  readonly onConnect: ConnectPresentationActions;
  readonly onFilePreview: FilePreviewPresentationActions;
  readonly generalStatus: () => string;
}

export interface FilePreviewPresentationActions {
  readonly close: () => void;
  readonly refresh: () => void;
  readonly download: (path: string) => void;
  readonly openLink: (reference: string, label: string) => void;
}

export interface RemoteHomePresentationActions {
  readonly openMiniApps: () => void;
  readonly openSidebar: () => void;
  readonly connectWorkspace: () => void;
  readonly addConnection: () => void;
  readonly refresh: () => void;
  readonly showWorkspaces: () => void;
  readonly showAssistants: () => void;
  readonly selectWorkspace: (path: string, deviceId?: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void;
  readonly selectAssistant: (path: string, workspaceId?: string) => void;
  readonly cancelWorkspace: () => void;
  readonly cancelAssistant: () => void;
  readonly queryChanged: (query: string) => void;
  readonly search: () => void;
  readonly loadMore: () => void;
  readonly reconnect: () => void;
  readonly disconnect: () => void;
  readonly clearPairing: () => void;
  readonly create: (agentType: string) => void;
  readonly createInPlace: (agentType: string) => void;
  readonly createInWorkspace: (path: string, agentType: string, deviceId?: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void;
  readonly createInWorkspaceInPlace: (path: string, agentType: string, deviceId?: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void;
  readonly selectDirectoryDevice: (deviceId: string) => void;
  readonly addDirectoryWorkspace: (deviceId: string) => void;
  readonly retryDirectoryDevice: (deviceId: string) => void;
  readonly loadWorkspaceSessions: (deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string) => Promise<void>;
  readonly openSession: (session: RemoteSession) => void;
  readonly openSessionInPlace: (session: RemoteSession) => void;
  readonly deleteSession: (session: RemoteSession) => void;
}

export interface SidebarPresentationActions {
  readonly close: () => void;
  readonly newChat: (agentType?: string) => void;
  readonly enterCode: () => void;
  /** Opens account settings, where the account device directory selects a desktop. */
  readonly openAccountDevices: () => void;
  /** Refreshes device presence and the disclosed workspace session lists. */
  readonly refreshDevices: () => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
  readonly settings: () => void;
  readonly openAccount: () => void;
  readonly openSession: (session: RemoteSession) => void;
  readonly deleteSession: (session: RemoteSession) => void;
}

export interface SettingsPresentationActions {
  readonly close: () => void;
  /** Account login finished or signed out inside settings; return to the single settings page. */
  readonly accountSettled: () => void;
  readonly disconnect: () => void;
  readonly clearPairing: () => void;
  readonly reconnect: () => void;
  readonly openAccount: () => void;
  readonly cloudCancelLogin: () => void;
  readonly cloudLogin: () => Promise<string>;
  readonly cloudLogout: () => Promise<void>;
  readonly cloudListDevices: () => Promise<CloudAccountDevice[]>;
  readonly cloudSelectDevice: (device: CloudAccountDevice) => Promise<void>;
  readonly getPermissionMode: () => Promise<RemotePermissionMode>;
  readonly setPermissionMode: (mode: RemotePermissionMode) => Promise<RemotePermissionMode>;
  readonly setLanguage: (language: string) => Promise<void>;
}

/**
 * The connect sheet closes through the platform's own chrome — the title bar's
 * close icon, the scrim, the swipe down — so there is no `back` here: every one
 * of those reaches the sheet's `onWillDismiss`, and the header control that used
 * to call this was the same dismissal drawn a second time.
 */
export interface ConnectPresentationActions {
  readonly openAccount: () => void;
  readonly connect: (password?: string) => void;
  readonly clearPairing: () => void;
  readonly cloudListDevices: () => Promise<CloudAccountDevice[]>;
  readonly cloudSelectDevice: (device: CloudAccountDevice) => Promise<void>;
}

export function emptyAppRootPresentationActions(): AppRootPresentationActions {
  return {
    onWorkspaceTools: () => {},
    onNavigationBack: () => false,
    onConversationIntent: () => {},
    onCloseSidebar: () => {},
    onCompactLayoutEntered: () => {},
    onLayoutModeChanged: () => {},
    onRemoteHome: {
      openMiniApps: () => {},
      openSidebar: () => {}, connectWorkspace: () => {}, addConnection: () => {},
      refresh: () => {}, showWorkspaces: () => {}, showAssistants: () => {}, selectWorkspace: () => {},
      selectAssistant: () => {}, cancelWorkspace: () => {}, cancelAssistant: () => {}, queryChanged: () => {},
      search: () => {}, loadMore: () => {}, reconnect: () => {}, disconnect: () => {}, clearPairing: () => {},
      create: () => {}, createInPlace: () => {}, createInWorkspace: () => {},
      createInWorkspaceInPlace: () => {}, selectDirectoryDevice: () => {}, addDirectoryWorkspace: () => {},
      retryDirectoryDevice: () => {}, loadWorkspaceSessions: async () => {},
      openSession: () => {}, openSessionInPlace: () => {}, deleteSession: () => {}
    },
    onSidebar: {
      close: () => {}, newChat: () => {}, enterCode: () => {}, openAccountDevices: () => {},
      refreshDevices: async () => {}, refreshSessions: async () => {}, settings: () => {}, openAccount: () => {},
      openSession: () => {}, deleteSession: () => {}
    },
    onSettings: {
      close: () => {}, accountSettled: () => {}, disconnect: () => {}, clearPairing: () => {},
      reconnect: () => {}, openAccount: () => {},
      cloudCancelLogin: () => {},
      cloudLogin: async () => '', cloudLogout: async () => {},
      cloudListDevices: async () => [], cloudSelectDevice: async () => {},
      getPermissionMode: async () => 'ask',
      setPermissionMode: async (mode: RemotePermissionMode) => mode,
      setLanguage: async () => {}
    },
    onConnect: {
      openAccount: () => {}, connect: () => {}, clearPairing: () => {},
      cloudListDevices: async () => [], cloudSelectDevice: async () => {}
    },
    onFilePreview: { close: () => {}, refresh: () => {}, download: () => {}, openLink: () => {} },
    generalStatus: () => ''
  };
}
