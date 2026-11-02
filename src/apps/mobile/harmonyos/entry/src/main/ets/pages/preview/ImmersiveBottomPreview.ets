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
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AdaptiveLayoutInput } from '../policy/AdaptiveLayoutInput';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import {
  AppRootPresentationActions,
  emptyAppRootPresentationActions
} from '../actions/AppRootPresentationActions';
import { ComposerPresentation } from '../components/ComposerBar';
import { ConversationViewContract, ConversationViewOptions } from '../components/ConversationViewContract';
import { ConversationViewState } from '../state/ConversationViewState';
import { ConversationIntent } from '../actions/ConversationIntent';
import { HdsNavigation, HdsNavDestination } from '@kit.UIDesignKit';
import { AppRoute } from '../navigation/AppRouteContract';
import { ConversationHeaderPolicy, ConversationHeaderPresentation } from '../policy/ConversationHeaderPolicy';
import { HdsTitleBarContentParams, HdsTitleBarSupport } from '../components/HdsTitleBarSupport';
import { PAGE_BG } from '../components/Theme';

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

/**
 * The account's desktops as the connect sheet's signed-in step lists them: one
 * online and currently controlled (the row that reads "controlling"), one
 * offline (a row with no action), and one online but idle (the row that offers
 * the connect action). Three rows is what the step's own card holds, so the
 * fixture shows every state it can render without scrolling the card.
 */
function connectDevices(): CloudAccountDevice[] {
  return [
    { deviceId: 'account-desktop-1', deviceName: 'Studio desktop', online: true, lastSeenAt: 3 },
    { deviceId: 'account-desktop-2', deviceName: 'Loft desktop', online: false, lastSeenAt: 1 },
    { deviceId: 'account-desktop-3', deviceName: 'Cabin desktop', online: true, lastSeenAt: 2 }
  ];
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
    onConnect: {
      openAccount: base.onConnect.openAccount,
      connect: base.onConnect.connect,
      clearPairing: base.onConnect.clearPairing,
      // The connect sheet's signed-in step lists the same account desktops the
      // settings sheet's account panel does, so both read the fixture's devices:
      // neither may reach the real account service from a preview.
      cloudListDevices: async (): Promise<CloudAccountDevice[]> => devices,
      cloudSelectDevice: base.onConnect.cloudSelectDevice
    },
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
  /**
   * The connect sheet's other step. The signed-out step is the sheet's landing
   * page, and the signed-in one is only reachable with an account id set, which
   * is what this flag seeds (see `seedRemoteState`): without it the account
   * device list has no fixture that mounts it.
   */
  @Local connectAuthed: boolean = false;
  /**
   * The platform title bar scenario: the compact conversation's chrome handed to
   * an `HdsNavDestination` instead of drawn by the pane. See `TitleBarLayout`.
   */
  @Local hdsTitleBar: boolean = false;
  /**
   * The fixture's own menu-open requests, by sequence.
   *
   * The production trigger reports into `RemotePageState`; this scenario carries
   * its own number because its conversation state is built here rather than
   * projected from the page's, and the pane consumes a sequence either way.
   */
  @Local previewMenuSeq: number = 0;
  /**
   * The stack the title bar scenario pushes its conversation onto. A title bar
   * only exists inside a `Navigation`, so the scenario mounts the smallest one
   * that can carry the production band.
   */
  private pageStack: NavPathStack = new NavPathStack();
  @Local remoteSurfaceState: RemoteSurfaceState = new RemoteSurfaceState();
  /**
   * The placements the app root would resolve for this window, one per sheet the
   * scenarios open. A fixture that pinned them would show the phone's answer on
   * a tablet, which is exactly the surface this preview is here to judge — the
   * same reason `CopySelectionPreview` resolves its own full-text panel.
   */
  @Local settingsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Settings);
  @Local connectPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Connect);
  @Local sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Local workspaceToolsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.WorkspaceTools);
  @Local viewSettingsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.RemoteViewSettings);

  aboutToAppear(): void {
    const scenarioId = AppStorage.get<string>('scenarioId') ?? '';
    this.floating = scenarioId.endsWith('-wide') && !scenarioId.endsWith('-wide-shell');
    this.drawer = scenarioId.includes('-drawer') || scenarioId.startsWith('immersive-bottom-tools');
    this.settings = scenarioId.endsWith('-settings') || scenarioId.endsWith('-settings-dark');
    this.cover = scenarioId.endsWith('-cover');
    this.galleryVisible = scenarioId.endsWith('-miniapps');
    // The wide shell keeps the same session list as a master pane instead of a
    // drawer, so its bottom edge is the same bottom edge. Matched as a prefix so the
    // dark appearance of the same shell is the same shell.
    this.wideShell = scenarioId.includes('immersive-bottom-wide-shell');
    this.viewSettings = scenarioId.endsWith('-view-settings');
    this.showViewSettingsSheet = this.viewSettings;
    this.connectAuthed = scenarioId.endsWith('-connect-authed');
    this.hdsTitleBar = scenarioId.endsWith('-hds-titlebar') || scenarioId.endsWith('-hds-titlebar-dark');
    // The shell's own surfaces have to be open before the first frame, and the
    // scenario id is only known once the page is appearing, so the flags are
    // applied here rather than in the field initialisers.
    this.shellState.showSidebar = this.drawer || this.wideShell;
    this.shellState.showSettings = this.settings || this.cover;
    this.shellState.showConnectSheet = this.connectAuthed || scenarioId.endsWith('-connect');
    if (this.cover) {
      this.shellState.settingsMode = 'account';
    }
    this.seedRemoteState(scenarioId);
    if (this.hdsTitleBar) {
      // Pushed before the first frame, the way the app root arrives with a
      // session already open: the destination is the surface under test, and the
      // home step behind it exists only so the push has somewhere to come from.
      this.pageStack.pushPath({ name: AppRoute.RemoteChat });
    }
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
    if (this.connectAuthed) {
      // The signed-in step: an account id is what moves the sheet off its intro
      // page and onto the account's desktops, and the device list it loads comes
      // from this fixture's own devices, never from the account service.
      this.remotePageState.setAccountUserId('preview-user');
      this.remotePageState.setAccountUsername('preview-user');
      this.remotePageState.setControlTarget('account_device', 'account-desktop-1', 'Studio desktop');
      this.remotePageState.setDesktopIdentity('Studio desktop', 'account-desktop-1');
      this.remotePageState.connectionState = 'connected';
      this.previewActions = previewActionsWithDevices(connectDevices());
      return;
    }
    if (scenarioId.endsWith('-connect')) {
      this.remotePageState.setPairingInput('https://pair.example/openbitfun/legacy', 'user-1', false);
      return;
    }
    // The wide shell carries the same directory the drawer does, as its master
    // pane instead of a drawer: the rows a capture has to read — a session row's
    // action menu among them — are the same rows, in the posture the wide window
    // shows them.
    if (this.drawer || this.viewSettings || this.wideShell) {
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

  /**
   * The placements the app root would resolve for this window. The fixture has
   * no creases to offer and is not asked to reproduce a foldable, so the input
   * carries the measured viewport and nothing else.
   */
  private refreshPlacements(width: number, height: number): void {
    const input = new AdaptiveLayoutInput(
      width,
      height,
      0,
      false,
      false,
      false,
      width >= ConversationLayoutPolicy.MD_MIN_WIDTH,
      [],
      []
    );
    this.settingsPlacement = SettingsPlacementPolicy.resolve(input, SettingsSheetKind.Settings);
    this.connectPlacement = SettingsPlacementPolicy.resolve(input, SettingsSheetKind.Connect);
    this.sessionDetailsPlacement = SettingsPlacementPolicy.resolve(
      input,
      SettingsSheetKind.SessionDetails
    );
    this.workspaceToolsPlacement = SettingsPlacementPolicy.resolve(
      input,
      SettingsSheetKind.WorkspaceTools
    );
    this.viewSettingsPlacement = SettingsPlacementPolicy.resolve(
      input,
      SettingsSheetKind.RemoteViewSettings
    );
  }

  private options(): ConversationViewOptions {
    const options = new ConversationViewOptions();
    options.showSidebarButton = true;
    options.showBackButton = false;
    options.platformBar = this.hdsTitleBar;
    options.composerPresentation =
      this.floating ? ComposerPresentation.Floating : ComposerPresentation.Compact;
    return options;
  }

  build() {
    Column() {
      if (this.galleryVisible) {
        MiniAppSurface({ state: this.miniAppState })
      } else if (this.viewSettings) {
        this.ViewSettingsLayout()
      } else if (this.hdsTitleBar) {
        this.TitleBarLayout()
      } else if (this.drawer || this.settings || this.cover || this.wideShell ||
        this.shellState.showConnectSheet) {
        this.ShellLayout()
      } else {
        this.Conversation()
      }
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.refreshPlacements(
        WideLayoutGeometry.areaLength(newArea.width),
        WideLayoutGeometry.areaLength(newArea.height)
      );
    })
  }

  /**
   * The remote view settings sheet, mounted the way the app root mounts it: a
   * bindSheet with the placement the app root would resolve for this window over
   * the conversation. The sheet is the production `RemoteSurfaceHost` in its
   * settings mode, so the surface under test is the production component.
   */
  @Builder
  private ViewSettingsLayout() {
    Column() {
      this.Conversation()
    }
    .width('100%')
    .height('100%')
    .bindSheet($$this.showViewSettingsSheet, this.ViewSettingsSheet(), AdaptiveSheetOptions.fromPlacement(
      this.viewSettingsPlacement,
      RemoteI18n.t('viewSettings.title'),
      RemoteI18n.t('viewSettings.subtitle')))
  }

  /**
   * The compact conversation's chrome as the app root assembles it.
   *
   * The platform title bar only exists inside a `Navigation`, so this scenario
   * mounts the smallest stack that reaches one — a home step the scenario never
   * shows, and the pushed conversation — and hands its band to the production
   * `HdsTitleBarSupport`, which is the same call `AppRootPresentation` makes.
   * The fixture imports the policy and the support class rather than restating
   * their parameters, so a device-level change cannot leave this capture and the
   * app describing two different bars.
   */
  @Builder
  private TitleBarLayout() {
    HdsNavigation(this.pageStack) {
      Column() {}.width('100%').height('100%').backgroundColor(PAGE_BG)
    }
    .id('hds-titlebar-navigation')
    .width('100%')
    .height('100%')
    .hideTitleBar(true)
    .mode(NavigationMode.Stack)
    .navBarWidth('100%')
    .minContentWidth(0)
    .navDestination(this.TitleBarDestination)
  }

  @Builder
  private TitleBarDestination(_name: string) {
    HdsNavDestination() { this.Conversation() }
      .titleBar(HdsTitleBarSupport.options(this.titleBarParams()))
      .hideBackButton(false)
      .backgroundColor(PAGE_BG)
      .onBackPressed(() => {
        this.pageStack.pop();
        // The destination handled it, the way the app root's own handler answers.
        return true;
      })
  }

  /**
   * The band's content, from the projection the pane's own header reads: the
   * fixture has one conversation and the bar has to name it the same way.
   *
   * There is no return control to configure: the band carries none, the platform
   * draws its own, and the destination's `onBackPressed` above is its action.
   */
  private titleBarParams(): HdsTitleBarContentParams {
    const presentation: ConversationHeaderPresentation = ConversationHeaderPolicy.present(
      this.state.surface,
      this.state.activeSession.title,
      this.state.desktopName,
      this.state.workspaceBranch,
      ConversationViewContract.hasRealTimelineItem(this.state.timelineItems)
    );
    return HdsTitleBarSupport.conversationParams(presentation, {
      onMenu: (): void => {
        this.requestPreviewMenu();
      }
    });
  }

  /**
   * The bar's menu trigger, answered the way the app root answers it.
   *
   * Production reports the request into `RemotePageState` and lets the pane
   * consume it from projected state; this fixture carries its own sequence
   * because its conversation state is built here rather than projected from the
   * page's. `ConversationViewState` is not an observed class, so the request
   * reaches the pane as a new object — which is exactly the shape a projection
   * arrives in, and why the pane consumes a sequence rather than a flag.
   */
  private requestPreviewMenu(): void {
    this.previewMenuSeq += 1;
    const next = this.initialState();
    next.conversationHeaderMenuSeq = this.previewMenuSeq;
    this.state = next;
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
      settingsPlacement: this.settingsPlacement,
      connectPlacement: this.connectPlacement,
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
      sessionDetailsPlacement: this.sessionDetailsPlacement,
      workspaceToolsPlacement: this.workspaceToolsPlacement,
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
