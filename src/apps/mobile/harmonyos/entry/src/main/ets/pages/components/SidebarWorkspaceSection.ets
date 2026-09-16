import { WorkspaceToolsPanel } from './WorkspaceToolsPanel';
import { WorkspaceToolsState, WorkspaceToolsIntent } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { SavedRuntimeConnection, RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  DeviceDirectoryEntry,
  DeviceDirectoryState,
  emptyDeviceDirectoryEntry
} from '../state/DeviceDirectoryState';
import { SidebarDirectoryPreviewPolicy } from '../policy/SidebarDirectoryPreviewPolicy';
import { SidebarDeviceProjectionPolicy } from '../policy/SidebarDeviceProjectionPolicy';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import { STATUS_SUCCESS, STATUS_DANGER, INK, MUTED, SUBTLE } from './Theme';
import { SidebarDeviceGroup } from './SidebarDeviceGroup';
import {
  SidebarChevronIcon,
  SidebarDeviceIcon
} from './SidebarNavigationIcons';
import { SidebarWorkspacePicker } from './SidebarWorkspacePicker';
import { ConnectionStatusPresenter } from '../../services/ConnectionStatusPresenter';
import { RemoteUiState } from '../../services/RemoteUiState';

/**
 * Flat device selector followed by the selected device's workspace tree.
 *
 * Device rows choose the remote context; they no longer each own a nested
 * directory. This keeps one visible workspace hierarchy and makes its owner
 * explicit without repeating the same tree under every account desktop.
 */
@ComponentV2
export struct SidebarWorkspaceSection {
  @Param workspaceTools: WorkspaceToolsState = new WorkspaceToolsState();
  @Event onWorkspaceTools: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  @Param directoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Param sessions: RemoteSession[] = [];
  @Param savedConnections: SavedRuntimeConnection[] = [];
  @Param savedConnectionsTargetId: string = '';
  @Param recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Param workspaceName: string = '';
  @Param workspacePath: string = '';
  @Param workspaceConnectionId: string = '';
  @Param workspaceSshHost: string = '';
  @Param workspaceKind: string = 'normal';
  @Param connectionState: string = 'idle';
  @Param controlTargetType: string = 'none';
  @Param controlTargetDeviceId: string = '';
  @Param controlTargetDeviceName: string = '';
  @Param selectedSessionId: string = '';
  @Param runningSessionId: string = '';
  @Param query: string = '';
  @Param supportsHarnessProfiles: boolean = false;
  @Param workspacePickerPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Event onOpenSession: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onSessionActions: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onCreateInWorkspace: (deviceId: string, path: string, agentType: string, connectionId?: string, sshHost?: string) => void =
    (_deviceId: string, _path: string, _agentType: string) => {};
  @Event onOpenWorkspace: (deviceId: string, path: string, connectionId?: string, sshHost?: string) => void =
    (_deviceId: string, _path: string) => {};
  @Event onExpandWorkspace: (deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string) => Promise<void> =
    async (_deviceId: string, _path: string) => {};
  @Event onSelectDevice: (deviceId: string) => void = (_deviceId: string) => {};
  @Event onReconnect: () => void = () => {};
  @Event onRetryDevice: (deviceId: string) => void = (_deviceId: string) => {};
  @Event onAddWorkspace: (deviceId: string) => void = (_deviceId: string) => {};
  @Event onRefreshDevices: () => Promise<void> = async () => {};
  @Event onAddDevice: () => void = () => {};
  @Local visibleDeviceCount: number = SidebarDirectoryPreviewPolicy.PREVIEW_COUNT;
  @Local showWorkspacePicker: boolean = false;
  @Local workspacePickerDeviceId: string = '';
  private readonly transientEntry: DeviceDirectoryEntry = emptyDeviceDirectoryEntry('', '', false);

  build() {
    Column() {
      this.DeviceSectionHeader()
      if (this.directoryState.refreshError.length > 0) {
        Text(this.directoryState.refreshError)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(STATUS_DANGER)
          .width('100%')
          .padding({ top: 4, bottom: 8 })
          .onClick(() => { void this.onRefreshDevices(); })
      }
      Row() {}.height(0)
        .bindSheet($$this.workspaceTools.visible, this.WorkspaceTools(), { height: SheetSize.LARGE, onWillDismiss: (action: DismissSheetAction): void => {
          if (this.workspaceTools.dirty) this.onWorkspaceTools({ type: 'close' });
          else { this.onWorkspaceTools({ type: 'close' }); action.dismiss(); }
        }, onDisappear: () => this.onWorkspaceTools({ type: 'close' }) })
      if (this.deviceEntries().length > 0) {
        ForEach(this.visibleDeviceEntries(), (entry: DeviceDirectoryEntry) => {
          this.DeviceRow(entry)
          if (this.isActiveDevice(entry.deviceId) &&
            (this.connectionState === 'reconnecting' || this.connectionState === 'failed' || this.connectionState === 'disconnected')) {
            this.ConnectionRecoveryRow()
          }
        }, (entry: DeviceDirectoryEntry): string => this.deviceKey(entry))
        if (this.visibleDeviceCount < this.deviceEntries().length) {
          this.MoreDevicesRow()
        }
        // The workspace tree owns projection caches and local disclosure state.
        // Key the single visible tree by device so switching the flat selector
        // cannot reuse the outgoing device's component instance and projection.
        ForEach(this.selectedEntries(), (entry: DeviceDirectoryEntry) => {
          this.WorkspaceSection(entry)
        }, (entry: DeviceDirectoryEntry): string => entry.deviceId)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 18 })
    .bindSheet($$this.showWorkspacePicker, this.WorkspacePicker(), this.workspacePickerSheetOptions())
  }

  @Builder
  private WorkspaceTools() {
    WorkspaceToolsPanel({ state: this.workspaceTools, onIntent: this.onWorkspaceTools })
  }

  @Builder
  private DeviceSectionHeader() {
    Row() {
      Text(RemoteI18n.t('sidebar.devices'))
        .id('sidebar-workspace-section')
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(MUTED)
      Blank()
      Stack({ alignContent: Alignment.Center }) {
        if (this.directoryState.refreshing) {
          LoadingProgress()
            .width(18)
            .height(18)
            .color(MUTED)
        } else {
          SymbolGlyph($r('sys.symbol.arrow_clockwise'))
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
            .fontColor([MUTED])
        }
      }
      .width(34)
      .height(38)
      .enabled(!this.directoryState.refreshing)
      .accessibilityText(RemoteI18n.t('common.refresh'))
      .onClick(() => {
        void this.onRefreshDevices();
      })

    }
    .width('100%')
    .height(42)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private DeviceRow(entry: DeviceDirectoryEntry) {
    Row({ space: 8 }) {
      SidebarDeviceIcon({
        deviceName: entry.deviceName,
        iconSize: 24,
        tint: entry.online ? INK : SUBTLE
      })
        .hitTestBehavior(HitTestMode.None)
      Text(entry.deviceName)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontWeight(entry.deviceId.length > 0 && this.controlTargetDeviceId.trim() === entry.deviceId ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(entry.online ? INK : SUBTLE)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .wordBreak(WordBreak.BREAK_ALL)
        .hitTestBehavior(HitTestMode.None)
      if (entry.status === 'loading') {
        LoadingProgress()
          .width(13)
          .height(13)
          .color(MUTED)
          .hitTestBehavior(HitTestMode.None)
      } else {
        Text('')
          .width(8)
          .height(8)
          .backgroundColor(this.deviceHealthColor(entry))
          .borderRadius(4)
          .hitTestBehavior(HitTestMode.None)
      }
      Stack({ alignContent: Alignment.Center }) {
        SidebarChevronIcon({
          expanded: this.isSelected(entry),
          iconSize: 14,
          tint: entry.online ? INK : SUBTLE
        })
          .hitTestBehavior(HitTestMode.None)
      }
      .width(20)
      .height(24)
      .hitTestBehavior(HitTestMode.None)
    }
    .width('100%')
    .height(52)
    .padding({ left: 8, right: 4 })
    .alignItems(VerticalAlign.Center)
    .opacity(entry.online ? 1 : 0.58)
    .accessibilityText(`${entry.deviceName}, ${this.isActiveDevice(entry.deviceId) ? ConnectionStatusPresenter.label(this.connectionState) :
      RemoteI18n.t(entry.online ? 'sidebar.deviceOnline' : 'sidebar.deviceOffline')}`)
    .enabled(this.canUseDevice(entry))
    .onClick(() => {
      if (this.canUseDevice(entry)) {
        this.onSelectDevice(entry.deviceId);
      }
    })
  }

  private deviceHealthColor(entry: DeviceDirectoryEntry): ResourceColor {
    if (!this.isActiveDevice(entry.deviceId)) return entry.online ? STATUS_SUCCESS : SUBTLE;
    if (this.connectionState === 'connected') return STATUS_SUCCESS;
    if (this.connectionState === 'failed' || this.connectionState === 'disconnected') return STATUS_DANGER;
    return MUTED;
  }

  @Builder
  private ConnectionRecoveryRow() {
    Row() {
      Text(ConnectionStatusPresenter.label(this.connectionState))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(MUTED)
        .layoutWeight(1)
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontSize(17).fontColor([MUTED])
      }
      .width(44).height(44)
      .accessibilityText(RemoteI18n.t('common.retry'))
      .onClick(() => this.onReconnect())
    }
    .width('100%').height(44).padding({ left: 10, right: 6 })
  }

  @Builder
  private WorkspaceSection(entry: DeviceDirectoryEntry) {
    Column() {
      Row() {
        Text(RemoteI18n.t('sidebar.workspaces'))
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
        Blank()
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.plus'))
            .fontSize(18)
            .fontColor([this.canUseDevice(entry) ? INK : SUBTLE])
        }
        .width(34)
        .height(34)
        .opacity(this.canUseDevice(entry) ? 1 : 0.38)
        .accessibilityText(RemoteI18n.t('sidebar.addWorkspace'))
        .onClick(() => {
          if (this.canUseDevice(entry)) {
            this.openWorkspacePicker(entry);
          }
        })
      }
      .width('100%')
      .height(48)
      .margin({ top: 16 })
      .alignItems(VerticalAlign.Center)

      if (entry.catalogSource === 'recent') {
        Text(RemoteI18n.t('sidebar.legacyWorkspaceCatalog'))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(MUTED)
          .padding({ left: 10, right: 10, bottom: 4 })
      }
      SidebarDeviceGroup({
        onWorkspaceTools: this.onWorkspaceTools,
        device: entry,
        directoryState: this.directoryState,
        sessions: this.sessionsForDevice(entry),
        recentWorkspaces: this.workspacesForDevice(entry),
        workspaceName: this.liveWorkspaceName(entry),
        workspacePath: this.liveWorkspacePath(entry),
        workspaceConnectionId: this.isActiveDevice(entry.deviceId) ? this.workspaceConnectionId : '',
        workspaceSshHost: this.isActiveDevice(entry.deviceId) ? this.workspaceSshHost : '',
        workspaceKind: this.liveWorkspaceKind(entry),
        selectedSessionId: this.selectedSessionIdFor(entry),
        runningSessionId: this.isActiveDevice(entry.deviceId) ? this.runningSessionId : '',
        query: this.query,
        showHeader: false,
        isActive: this.isActiveDevice(entry.deviceId),
        supportsHarnessProfiles: this.supportsHarnessProfiles,
        onRetry: () => {
          if (this.isDirectoryEntry(entry)) {
            this.onRetryDevice(entry.deviceId);
          }
        },
        onOpenSession: this.onOpenSession,
        onSessionActions: this.onSessionActions,
        onCreateInWorkspace: (path: string, agentType: string, connectionId?: string, sshHost?: string) => {
          this.onCreateInWorkspace(entry.deviceId, path, agentType, connectionId, sshHost);
        },
        onOpenWorkspace: (path: string, connectionId?: string, sshHost?: string) => {
          this.onOpenWorkspace(entry.deviceId, path, connectionId, sshHost);
        },
        onExpandWorkspace: async (path: string, remoteConnectionId?: string, remoteSshHost?: string): Promise<void> => {
          await this.onExpandWorkspace(entry.deviceId, path, remoteConnectionId, remoteSshHost);
        },
        onWorkspaceExpandedChange: (path: string, expanded: boolean, remoteConnectionId?: string, remoteSshHost?: string): void => {
          this.directoryState.setWorkspaceExpanded(entry.deviceId, path, expanded, remoteConnectionId, remoteSshHost);
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private MoreDevicesRow() {
    Row({ space: 8 }) {
      Text('···')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
      Text(RemoteI18n.f('sidebar.moreDevices',
        String(this.deviceEntries().length - this.visibleDeviceCount)))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(40)
    .padding({ left: 10 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.visibleDeviceCount += SidebarDirectoryPreviewPolicy.PREVIEW_COUNT;
    })
  }

  private deviceEntries(): DeviceDirectoryEntry[] {
    const directoryEntries = this.directoryState.devices;
    if (!SidebarDeviceProjectionPolicy.shouldPrependControlTarget(
      directoryEntries.map((entry: DeviceDirectoryEntry): string => entry.deviceId),
      this.controlTargetType,
      this.controlTargetDeviceId,
      this.isConnected(),
      this.recentWorkspaces.length > 0 || this.sessions.length > 0
    )) {
      return directoryEntries;
    }
    this.updateTransientEntry();
    return [this.transientEntry].concat(directoryEntries);
  }

  @Builder
  private WorkspacePicker() {
    SidebarWorkspacePicker({
      tools: this.workspaceTools,
      canBrowse: this.isActiveDevice(this.workspacePickerDevice().deviceId),
      onBrowse: this.onWorkspaceTools,
      deviceName: this.workspacePickerDevice().deviceName,
      savedConnections: this.workspacePickerDevice().deviceId === this.savedConnectionsTargetId ? this.savedConnections : [],
      workspaces: this.workspacePickerDevice().catalogSource.length > 0 ?
        this.workspacePickerDevice().recentWorkspaces : this.workspacesForDevice(this.workspacePickerDevice()),
      selectedWorkspacePath: this.isActiveDevice(this.workspacePickerDevice().deviceId) ?
        this.workspacePath : '',
      loading: this.workspacePickerDevice().status === 'loading',
      onClose: () => {
        this.showWorkspacePicker = false;
      },
      onSelectWorkspace: (path: string, connectionId?: string, sshHost?: string) => {
        const deviceId = this.workspacePickerDeviceId;
        this.showWorkspacePicker = false;
        this.onOpenWorkspace(deviceId, path, connectionId, sshHost);
      }
    })
  }

  private openWorkspacePicker(entry: DeviceDirectoryEntry): void {
    this.workspacePickerDeviceId = entry.deviceId;
    this.showWorkspacePicker = true;
    this.onAddWorkspace(entry.deviceId);
  }

  private workspacePickerDevice(): DeviceDirectoryEntry {
    const entry = this.deviceEntries().find((item: DeviceDirectoryEntry): boolean =>
      item.deviceId === this.workspacePickerDeviceId
    );
    return entry || this.transientEntry;
  }

  private workspacePickerSheetOptions(): SheetOptions {
    return AdaptiveSheetOptions.fromPlacement(this.workspacePickerPlacement, true);
  }

  private visibleDeviceEntries(): DeviceDirectoryEntry[] {
    const entries = this.deviceEntries();
    return entries.length <= this.visibleDeviceCount ? entries : entries.slice(0, this.visibleDeviceCount);
  }

  private selectedEntry(): DeviceDirectoryEntry | undefined {
    const entries = this.deviceEntries();
    const selectedId = this.directoryState.selectedDeviceId.trim();
    if (selectedId.length === 0) {
      return undefined;
    }
    return entries.find((entry: DeviceDirectoryEntry): boolean => entry.deviceId === selectedId);
  }

  private selectedEntries(): DeviceDirectoryEntry[] {
    const selected = this.selectedEntry();
    return selected ? [selected] : [];
  }

  private isSelected(entry: DeviceDirectoryEntry): boolean {
    const selected = this.selectedEntry();
    return !!selected && selected.deviceId === entry.deviceId;
  }

  private deviceKey(entry: DeviceDirectoryEntry): string {
    return this.isDirectoryEntry(entry) ? entry.deviceId : `transient:${entry.deviceId}`;
  }

  private updateTransientEntry(): void {
    const targetId = this.controlTargetDeviceId.trim();
    this.transientEntry.deviceId = targetId;
    this.transientEntry.deviceName = this.controlTargetDeviceName.trim() || targetId;
    this.transientEntry.online = this.isConnected();
    this.transientEntry.status = 'ready';
    this.transientEntry.workspaces = this.recentWorkspaces;
    this.transientEntry.sessions = this.sessions;
  }

  private isDirectoryEntry(entry: DeviceDirectoryEntry): boolean {
    return this.directoryState.find(entry.deviceId) === entry;
  }

  private usesLiveDirectory(entry: DeviceDirectoryEntry): boolean {
    return this.isActiveDevice(entry.deviceId) && this.isConnected();
  }

  private liveWorkspacePath(entry: DeviceDirectoryEntry): string {
    return this.usesLiveDirectory(entry) ? this.workspacePath : '';
  }

  private liveWorkspaceName(entry: DeviceDirectoryEntry): string {
    return this.liveWorkspacePath(entry).length > 0 ? this.workspaceName : '';
  }

  private liveWorkspaceKind(entry: DeviceDirectoryEntry): string {
    return this.usesLiveDirectory(entry) ? this.workspaceKind : 'normal';
  }

  private sessionsForDevice(entry: DeviceDirectoryEntry): RemoteSession[] {
    return this.usesLiveDirectory(entry) ?
      RemoteUiState.mergeSessions(this.sessions, entry.sessions) : entry.sessions;
  }

  private workspacesForDevice(entry: DeviceDirectoryEntry): RecentWorkspaceEntry[] {
    return entry.workspaces;
  }

  private selectedSessionIdFor(entry: DeviceDirectoryEntry): string {
    if (this.selectedSessionId.length === 0) {
      return '';
    }
    if (this.isActiveDevice(entry.deviceId)) {
      return this.selectedSessionId;
    }
    return entry.sessions.some((item: RemoteSession): boolean => item.id === this.selectedSessionId) ?
      this.selectedSessionId : '';
  }

  private isActiveDevice(deviceId: string): boolean {
    const activeId = this.controlTargetDeviceId;
    if (activeId.length === 0) {
      return this.directoryState.devices.length === 0;
    }
    return deviceId === activeId;
  }

  private canUseDevice(entry: DeviceDirectoryEntry): boolean {
    return entry.online || (this.isActiveDevice(entry.deviceId) && this.isConnected());
  }


  private isConnected(): boolean {
    return this.connectionState === 'connected' || this.connectionState === 'reconnecting';
  }
}
