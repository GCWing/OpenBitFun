import { ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatMessage, RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';
import { MiniAppSummary } from '../../model/MiniAppModels';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { ChatSurface } from '../state/ChatSurface';
import { REMOTE_CHAT_COMPOSER_CAPABILITIES } from '../state/ChatComposerCapabilities';
import { AppShellState } from '../state/AppShellState';
import { MiniAppState } from '../state/MiniAppState';
import { RemotePageState } from '../state/RemotePageState';
import {
  DeviceDirectoryEntry,
  DeviceDirectoryState,
  emptyDeviceDirectoryEntry
} from '../state/DeviceDirectoryState';
import { WorkspaceToolsState, WorkspaceFileEntry } from '../state/WorkspaceToolsState';
import { ConversationView } from '../components/ConversationView';
import { AppShell } from '../components/AppShell';
import { MiniAppSurface } from '../components/MiniAppSurface';
import { AppConnectSurface, AppSettingsSurface, AppSidebarSurface } from '../components/AppRootOverlaySurfaces';
import {
  RemoteSurfaceHost,
  RemoteSurfaceMode,
  RemoteSurfaceState
} from '../components/remote/RemoteSurfaceHost';
import { AdaptiveSheetOptions } from '../components/AdaptiveSheetOptions';
import {
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { ComposerPresentation } from '../components/ComposerBar';
import { ConversationViewOptions } from '../components/ConversationViewContract';
import { ConversationViewState } from '../state/ConversationViewState';
import { ConversationIntent } from '../actions/ConversationIntent';

/** Turns in the transcript. Long enough that the list has to scroll to reach the end. */
const TRANSCRIPT_TURNS: number = 16;

/** Tiles in the mini-app gallery: enough rows that the gallery itself scrolls. */
const GALLERY_APPS: number = 9;

/** Devices the account panel lists: enough rows that the settings sheet scrolls. */
const SETTINGS_DEVICES: number = 9;

/** Workspaces on the fixture desktop: enough rows that the sidebar's directory scrolls. */
const SIDEBAR_WORKSPACES: number = 14;

/** Sessions in the first workspace: the sidebar's own scrollable rows. */
const SIDEBAR_SESSIONS: number = 36;

/** Files in the workspace tools sheet: enough rows that the file list scrolls. */
const TOOLS_FILES: number = 18;

/** Lines in the seeded editor file: enough that the editor's web view scrolls. */
const EDITOR_LINES: number = 120;

/** Prose tall enough to be read while it is already half faded out. */
const ANSWER_PARAGRAPH: string =
  'The transcript runs the full height of the pane, so the last answer keeps '
  + 'scrolling until it reaches the bottom edge of the screen. The composer '
  + 'floats over it and the fade carries the text into the page colour instead '
  + 'of cutting it off at a hard line.';

const FINAL_ANSWER_PARAGRAPH: string =
  'This is the final answer of the transcript, and it decides whether the bottom '
  + 'edge reads as a continuation of the conversation or as a strip of empty page '
  + 'colour: it must be able to scroll above the floating composer, and everything '
  + 'below the composer must still look like the surface the answer is drawn on. A '
  + 'reader who flings the list to the end should see the answer fade into the page '
  + 'rather than stop short of it.';

function message(id: string, role: string, text: string): ChatMessage {
  return { id, role, text, status: 'completed', timestamp: '0' };
}

function row(id: string, role: string, text: string): ObservableChatTimelineItem {
  return new ObservableChatTimelineItem({
    id,
    type: role === 'user' ? 'user_message' : 'assistant_message',
    message: message(id, role, text),
    isStreaming: false,
    isFinalizing: false
  });
}

function transcript(): ObservableChatTimelineItem[] {
  const rows: ObservableChatTimelineItem[] = [];
  for (let index = 0; index < TRANSCRIPT_TURNS; index++) {
    const turn = index + 1;
    rows.push(row(`turn-${turn}-user`, 'user', `Round ${turn}: how does the bottom of the chat page read?`));
    rows.push(row(`turn-${turn}-assistant`, 'assistant',
      turn === TRANSCRIPT_TURNS ? FINAL_ANSWER_PARAGRAPH : ANSWER_PARAGRAPH));
  }
  return rows;
}

function gallery(): MiniAppSummary[] {
  const apps: MiniAppSummary[] = [];
  for (let index = 0; index < GALLERY_APPS; index++) {
    const tile = index + 1;
    apps.push({
      id: `gallery-${tile}`,
      name: `Mini app ${tile}`,
      description: 'Offline sample tile, so the gallery has rows below the fold.'
    });
  }
  return apps;
}

function settingsDevices(): CloudAccountDevice[] {
  const devices: CloudAccountDevice[] = [];
  for (let index = 0; index < SETTINGS_DEVICES; index++) {
    const device = index + 1;
    devices.push({
      deviceId: `account-desktop-${device}`,
      deviceName: `Account desktop ${device}`,
      online: device % 3 !== 0,
      lastSeenAt: device
    });
  }
  return devices;
}

function sidebarWorkspaces(): RecentWorkspaceEntry[] {
  const workspaces: RecentWorkspaceEntry[] = [];
  for (let index = 0; index < SIDEBAR_WORKSPACES; index++) {
    const workspace = index + 1;
    workspaces.push({
      path: `/workspace/project-${workspace}`,
      name: `Workspace ${workspace}`,
      lastOpened: `${workspace}`,
      workspaceKind: 'normal',
      workspaceId: `ws-${workspace}`
    });
  }
  return workspaces;
}

function sidebarSessions(): RemoteSession[] {
  const sessions: RemoteSession[] = [];
  for (let index = 0; index < SIDEBAR_SESSIONS; index++) {
    const session = index + 1;
    sessions.push({
      id: `sidebar-session-${session}`,
      title: `Sidebar session ${String(session).padStart(2, '0')}`,
      agentType: 'code',
      status: 'completed',
      updatedAt: `${session}`,
      createdAt: `${session}`,
      messageCount: session * 3,
      workspacePath: '/workspace/project-1',
      workspaceName: 'Workspace 1',
      deviceId: 'fixture-desktop'
    });
  }
  return sessions;
}

function toolsFiles(): WorkspaceFileEntry[] {
  const entries: WorkspaceFileEntry[] = [];
  for (let index = 0; index < TOOLS_FILES; index++) {
    const file = index + 1;
    const name = `report-${String(file).padStart(2, '0')}.md`;
    entries.push({
      path: `/workspace/${name}`,
      name,
      isDirectory: false,
      size: file * 64,
      modifiedTime: file
    });
  }
  return entries;
}

/** The file the editor tab opens: long enough that its content has to scroll. */
function toolsEditorContent(): string {
  const lines: string[] = [];
  for (let index = 0; index < EDITOR_LINES; index++) {
    const line = index + 1;
    lines.push(`# Section ${line}`);
    lines.push('');
    lines.push(`This line is body copy for section ${line}, long enough that the`);
    lines.push('editor has to scroll before the last line can come to rest.');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The empty actions with one override. The interface's members are readonly,
 * so the settings sheet's device catalog is supplied by building the whole
 * literal once rather than assigning into it.
 */
function previewActionsWithDevices(devices: CloudAccountDevice[]): AppRootPresentationActions {
  const base = emptyAppRootPresentationActions();
  return {
    onWorkspaceTools: base.onWorkspaceTools,
    onNavigationBack: base.onNavigationBack,
    onConversationIntent: base.onConversationIntent,
    onCloseSidebar: base.onCloseSidebar,
    onCompactLayoutEntered: base.onCompactLayoutEntered,
    onLayoutModeChanged: base.onLayoutModeChanged,
    onRemoteHome: base.onRemoteHome,
    onSidebar: base.onSidebar,
    onSettings: {
      close: base.onSettings.close,
      accountSettled: base.onSettings.accountSettled,
      disconnect: base.onSettings.disconnect,
      clearPairing: base.onSettings.clearPairing,
      reconnect: base.onSettings.reconnect,
      openAccount: base.onSettings.openAccount,
      cloudCancelLogin: base.onSettings.cloudCancelLogin,
      cloudLogin: base.onSettings.cloudLogin,
      cloudLogout: base.onSettings.cloudLogout,
      cloudListDevices: async (): Promise<CloudAccountDevice[]> => devices,
      cloudSelectDevice: base.onSettings.cloudSelectDevice,
      getPermissionMode: base.onSettings.getPermissionMode,
      setPermissionMode: base.onSettings.setPermissionMode,
      setLanguage: base.onSettings.setLanguage
    },
    onConnect: base.onConnect,
    onFilePreview: base.onFilePreview,
    generalStatus: base.generalStatus
  };
}

/**
 * The chat page's bottom edge, drawn by the production `ConversationView` over a
 * transcript long enough to scroll: the composer and the status line float over
 * the list, and the list carries the page colour down to the bottom of the
 * screen.
 *
 * This fixture exists because the bottom edge cannot be judged from the composer
 * alone: where the input ends up, how far the last message can scroll, and which
 * colour the fade finishes on are three separate readings of one capture, and the
 * layout dump has to show the same pane the pixels do.
 *
 * The scenario id picks the state, because the shell has to be in it before the
 * first frame: `-wide` swaps the composer to the wide detail pane's floating
 * presentation, `-drawer` mounts the production `AppShell` with its drawer open
 * over the same conversation, `-settings` and `-cover` mount the shell with its
 * settings sheet and its compact account cover open, `-miniapps` mounts the
 * mini-app gallery, `-tools` opens the workspace tools sheet over the drawer
 * (with `-tools-editor` opening it on the editor tab and
 * `-tools-file-action` opening its file action form), `-view-settings` opens
 * the remote view settings sheet over the same conversation, and `-connect`
 * opens the connect sheet. The drawer, settings and tools states seed remote
 * content — a device with workspaces and sessions, an account with desktops, a
 * directory of files — because a surface whose content fits its viewport has no
 * bottom edge to read. None of them changes the window posture: every one of
 * these surfaces shares the shell's immersive layout, so every one of them is
 * where a control can end up under the navigation bar.
 */
@ComponentV2
export struct ImmersiveBottomPreview {
  @Local state: ConversationViewState = this.initialState();
  @Local shellState: AppShellState = this.initialShellState();
  @Local miniAppState: MiniAppState = this.initialMiniAppState();
  @Local remotePageState: RemotePageState = new RemotePageState();
  @Local directoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Local previewActions: AppRootPresentationActions = emptyAppRootPresentationActions();
  @Local floating: boolean = false;
  @Local drawer: boolean = false;
  @Local settings: boolean = false;
  @Local cover: boolean = false;
  @Local galleryVisible: boolean = false;
  @Local wideShell: boolean = false;
  @Local viewSettings: boolean = false;
  @Local showViewSettingsSheet: boolean = false;
  @Local remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();

  aboutToAppear(): void {
    const scenarioId = AppStorage.get<string>('scenarioId') ?? '';
    this.floating = scenarioId.endsWith('-wide') && !scenarioId.endsWith('-wide-shell');
    this.drawer = scenarioId.includes('-drawer') || scenarioId.startsWith('immersive-bottom-tools');
    this.settings = scenarioId.endsWith('-settings') || scenarioId.endsWith('-settings-dark');
    this.cover = scenarioId.endsWith('-cover');
    this.galleryVisible = scenarioId.endsWith('-miniapps');
    // The wide shell keeps the same session list as a master pane instead of a
    // drawer, so its bottom edge is the same bottom edge.
    this.wideShell = scenarioId.endsWith('-wide-shell');
    this.viewSettings = scenarioId.endsWith('-view-settings');
    this.showViewSettingsSheet = this.viewSettings;
    // The shell's own surfaces have to be open before the first frame, and the
    // scenario id is only known once the page is appearing, so the flags are
    // applied here rather than in the field initialisers.
    this.shellState.showSidebar = this.drawer || this.wideShell;
    this.shellState.showSettings = this.settings || this.cover;
    this.shellState.showConnectSheet = scenarioId.endsWith('-connect');
    if (this.cover) {
      this.shellState.settingsMode = 'account';
    }
    this.seedRemoteState(scenarioId);
  }  private initialState(): ConversationViewState {
    const state = new ConversationViewState();
    state.surface = ChatSurface.Remote;
    state.connectionState = 'connected';
    state.activeSession = {
      sessionId: 'immersive-bottom-preview',
      title: 'Bottom edge',
      workspacePath: '/workspace',
      agentType: 'code'
    };
    state.desktopName = 'Studio';
    state.composerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
    state.timelineItems = transcript();
    state.timelineRevision = 1;
    return state;
  }

  private initialShellState(): AppShellState {
    return new AppShellState();
  }

  private initialMiniAppState(): MiniAppState {
    const state = new MiniAppState();
    state.visible = true;
    state.apps = gallery();
    return state;
  }

  /**
   * Remote content for the shell's own surfaces. The surfaces under test scroll,
   * so their fixture content has to overflow their viewport: the settings sheet
   * lists an account's desktops, the drawer carries a device directory with
   * workspaces and sessions, and the tools sheet carries a directory of files.
   * The connect sheet carries a persisted legacy pairing link, because its
   * status strip — the fixed control at its bottom edge — is what that state
   * mounts there. The view settings sheet shares the drawer's directory because
   * its filters are what scroll in it.
   */
  private seedRemoteState(scenarioId: string): void {
    if (this.settings) {
      this.remotePageState.setAccountUserId('octocat');
      this.remotePageState.setAccountUsername('octocat');
      this.remotePageState.setControlTarget('account_device', 'account-desktop-1', 'Account desktop 1');
      this.remotePageState.setDesktopIdentity('Account desktop 1', 'account-desktop-1');
      this.remotePageState.connectionState = 'connected';
      this.previewActions = previewActionsWithDevices(settingsDevices());
      return;
    }
    if (scenarioId.endsWith('-connect')) {
      this.remotePageState.setPairingInput('https://pair.example/openbitfun/legacy', 'user-1', false);
      return;
    }
    if (this.drawer || this.viewSettings) {
      const desktop: DeviceDirectoryEntry = emptyDeviceDirectoryEntry('fixture-desktop', 'Studio', true);
      desktop.status = 'ready';
      desktop.workspaces = sidebarWorkspaces();
      this.directoryState.replace([desktop]);
      this.directoryState.select('fixture-desktop');
      this.directoryState.setWorkspaceExpanded('fixture-desktop', '/workspace/project-1', true,
        undefined, undefined, 'ws-1');
      this.remotePageState.setControlTarget('account_device', 'fixture-desktop', 'Studio');
      this.remotePageState.setDesktopIdentity('Studio', 'fixture-desktop');
      this.remotePageState.connectionState = 'connected';
      this.remotePageState.workspacePath = '/workspace/project-1';
      this.remotePageState.workspaceName = 'Workspace 1';
      this.remotePageState.workspaceId = 'ws-1';
      this.remotePageState.workspaceKind = 'normal';
      this.remotePageState.setSessions(sidebarSessions(), false);
      if (scenarioId.startsWith('immersive-bottom-tools')) {
        this.remotePageState.workspaceTools.visible = true;
        this.remotePageState.workspaceTools.directory = '/workspace';
        this.remotePageState.workspaceTools.entries = toolsFiles();
        if (scenarioId.endsWith('-tools-editor')) {
          // The editor tab: the WebView is the tab's bottom edge, so its content
          // has to be long enough to scroll inside it.
          this.remotePageState.workspaceTools.editorVisible = true;
          this.remotePageState.workspaceTools.selectedFile = '/workspace/report-01.md';
          this.remotePageState.workspaceTools.content = toolsEditorContent();
        }
        if (scenarioId.endsWith('-tools-file-action')) {
          // The file action form: a FIT_CONTENT sheet whose buttons are the
          // fixed controls at the screen edge.
          this.remotePageState.workspaceTools.fileAction = 'file';
        }
      }
    }
  }

  private options(): ConversationViewOptions {
    const options = new ConversationViewOptions();
    options.showSidebarButton = true;
    options.showBackButton = false;
    options.composerPresentation =
      this.floating ? ComposerPresentation.Floating : ComposerPresentation.Compact;
    return options;
  }

  build() {
    if (this.galleryVisible) {
      MiniAppSurface({ state: this.miniAppState })
    } else if (this.viewSettings) {
      this.ViewSettingsLayout()
    } else if (this.drawer || this.settings || this.cover || this.wideShell ||
      this.shellState.showConnectSheet) {
      this.ShellLayout()
    } else {
      this.Conversation()
    }
  }

  /**
   * The remote view settings sheet, mounted the way the app root mounts it: a
   * bindSheet with the compact placement's options over the conversation. The
   * sheet is the production `RemoteSurfaceHost` in its settings mode, so the
   * surface under test is the production component.
   */
  @Builder
  private ViewSettingsLayout() {
    Column() {
      this.Conversation()
    }
    .width('100%')
    .height('100%')
    .bindSheet($$this.showViewSettingsSheet, this.ViewSettingsSheet(), AdaptiveSheetOptions.fromPlacement(
      SettingsPlacementPolicy.compactBottom(SettingsSheetKind.RemoteViewSettings), true))
  }

  @Builder
  private ViewSettingsSheet() {
    RemoteSurfaceHost({
      mode: RemoteSurfaceMode.Settings,
      remotePageState: this.remotePageState,
      presentationState: this.remoteSurfaceState,
      actions: this.previewActions,
      onCloseSettings: () => { this.showViewSettingsSheet = false; }
    })
  }

  /**
   * The drawer, the settings sheet, the connect sheet and the compact account
   * cover are all shell surfaces rather than pages, so they are mounted through
   * the production shell with the production content for their slot. Each of
   * them has its own bottom edge, and the shell is what moves them with the
   * window.
   */
  @Builder
  private ShellLayout() {
    AppShell({
      shellState: this.shellState,
      useWideLayout: this.wideShell,
      allowSidebar: true,
      compactAccountLogin: this.cover,
      content: () => { this.Conversation(); },
      sidebar: () => { this.Sidebar(); },
      settings: () => { this.Settings(); },
      connect: () => { this.Connect(); },
      onCloseSidebar: () => { this.shellState.showSidebar = false; }
    })
  }

  @Builder
  private Settings() {
    AppSettingsSurface({
      shellState: this.shellState,
      remotePageState: this.remotePageState,
      actions: this.previewActions
    })
  }

  @Builder
  private Connect() {
    AppConnectSurface({
      remotePageState: this.remotePageState,
      actions: this.previewActions
    })
  }

  @Builder
  private Sidebar() {
    AppSidebarSurface({
      shellState: this.shellState,
      remotePageState: this.remotePageState,
      deviceDirectoryState: this.directoryState,
      actions: emptyAppRootPresentationActions()
    })
  }

  @Builder
  private Conversation() {
    ConversationView({
      state: this.state,
      options: this.options(),
      onIntent: (_intent: ConversationIntent): void => {}
    })
  }
}
