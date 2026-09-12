import { RemotePermissionMode, RemoteSession } from '../../model/RemoteModels';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { DetectedUrlAction } from '../../services/ConnectScanDecisionPolicy';
import { ConversationIntent } from './ConversationIntent';
import { AppRoute } from '../navigation/AppRouteContract';

export interface AppRootPresentationActions {
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
  readonly openSettings: () => void;
  readonly refresh: () => void;
  readonly showWorkspaces: () => void;
  readonly showAssistants: () => void;
  readonly selectWorkspace: (path: string, deviceId?: string) => void;
  readonly selectAssistant: (path: string) => void;
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
  readonly createInWorkspace: (path: string, agentType: string, deviceId?: string) => void;
  readonly createInWorkspaceInPlace: (path: string, agentType: string, deviceId?: string) => void;
  readonly selectDirectoryDevice: (deviceId: string) => void;
  readonly addDirectoryWorkspace: (deviceId: string) => void;
  readonly retryDirectoryDevice: (deviceId: string) => void;
  readonly loadWorkspaceSessions: (deviceId: string, path: string) => Promise<void>;
  readonly openSession: (session: RemoteSession) => void;
  readonly openSessionInPlace: (session: RemoteSession) => void;
  readonly deleteSession: (session: RemoteSession) => void;
}

export interface SidebarPresentationActions {
  readonly close: () => void;
  readonly newChat: (agentType?: string) => void;
  readonly enterCode: () => void;
  /** Opens the QR scanner directly from sidebar device actions. */
  readonly scanDesktop: () => void;
  /** Opens the QR scanner from the device-section add button. */
  readonly addDesktop: () => void;
  /** Refreshes account device presence from the relay. */
  readonly refreshDevices: () => Promise<void>;
  readonly settings: () => void;
  readonly openAccount: () => void;
  readonly openSession: (session: RemoteSession) => void;
  readonly deleteSession: (session: RemoteSession) => void;
}

export interface SettingsPresentationActions {
  readonly close: () => void;
  readonly addConnection: () => void;
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

export interface ConnectPresentationActions {
  readonly back: () => void;
  readonly openAccount: () => void;
  readonly connect: (password?: string) => void;
  readonly clearPairing: () => void;
  readonly urlChanged: (url: string) => void;
  readonly userChanged: (user: string) => void;
  readonly detected: (url: string) => string;
  readonly inputVisible: (visible: boolean) => void;
  readonly paste: () => void;
  readonly scan: () => void;
  readonly cloudListDevices: () => Promise<CloudAccountDevice[]>;
  readonly cloudSelectDevice: (device: CloudAccountDevice) => Promise<void>;
}

export function emptyAppRootPresentationActions(): AppRootPresentationActions {
  return {
    onNavigationBack: () => false,
    onConversationIntent: () => {},
    onCloseSidebar: () => {},
    onCompactLayoutEntered: () => {},
    onLayoutModeChanged: () => {},
    onRemoteHome: {
      openMiniApps: () => {},
      openSidebar: () => {}, connectWorkspace: () => {}, addConnection: () => {}, openSettings: () => {},
      refresh: () => {}, showWorkspaces: () => {}, showAssistants: () => {}, selectWorkspace: () => {},
      selectAssistant: () => {}, cancelWorkspace: () => {}, cancelAssistant: () => {}, queryChanged: () => {},
      search: () => {}, loadMore: () => {}, reconnect: () => {}, disconnect: () => {}, clearPairing: () => {},
      create: () => {}, createInPlace: () => {}, createInWorkspace: () => {},
      createInWorkspaceInPlace: () => {}, selectDirectoryDevice: () => {}, addDirectoryWorkspace: () => {},
      retryDirectoryDevice: () => {}, loadWorkspaceSessions: async () => {},
      openSession: () => {}, openSessionInPlace: () => {}, deleteSession: () => {}
    },
    onSidebar: {
      close: () => {}, newChat: () => {}, enterCode: () => {}, scanDesktop: () => {}, addDesktop: () => {},
      refreshDevices: async () => {}, settings: () => {}, openAccount: () => {},
      openSession: () => {}, deleteSession: () => {}
    },
    onSettings: {
      close: () => {}, addConnection: () => {}, disconnect: () => {}, clearPairing: () => {},
      reconnect: () => {}, openAccount: () => {},
      cloudCancelLogin: () => {},
      cloudLogin: async () => '', cloudLogout: async () => {},
      cloudListDevices: async () => [], cloudSelectDevice: async () => {},
      getPermissionMode: async () => 'ask',
      setPermissionMode: async (mode: RemotePermissionMode) => mode,
      setLanguage: async () => {}
    },
    onConnect: {
      back: () => {}, openAccount: () => {}, connect: () => {}, clearPairing: () => {},
      urlChanged: () => {}, userChanged: () => {},
      detected: () => DetectedUrlAction.INVALID, inputVisible: () => {}, paste: () => {}, scan: () => {},
      cloudListDevices: async () => [], cloudSelectDevice: async () => {}
    },
    onFilePreview: { close: () => {}, refresh: () => {}, download: () => {}, openLink: () => {} },
    generalStatus: () => ''
  };
}
