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
import { STATUS_SUCCESS, STATUS_DANGER, INK, MUTED, SUBTLE, SOFT, TRANSPARENT } from './Theme';
import { SidebarDeviceGroup } from './SidebarDeviceGroup';
import { SidebarDeviceIcon } from './SidebarNavigationIcons';
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
  /** Stable record ID of the active workspace; empty for pre-ID hosts. */
  @Param workspaceId: string = '';
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
  @Event onCreateInWorkspace: (deviceId: string, path: string, agentType: string, connectionId?: string, sshHost?: string,
    workspaceId?: string) => void = (_deviceId: string, _path: string, _agentType: string) => {};
  @Event onOpenWorkspace: (deviceId: string, path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_deviceId: string, _path: string) => {};
  @Event onExpandWorkspace: (deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string,
    workspaceId?: string) => Promise<void> = async (_deviceId: string, _path: string) => {};
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
    .margin({ top: 10 })
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
        tint: INK
      })
        .hitTestBehavior(HitTestMode.None)
      Text(entry.deviceName)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontWeight(this.isSelected(entry) ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(INK)
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
    }
    .width('100%')
    .height(52)
    .padding({ left: 8, right: 4 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.isSelected(entry) ? SOFT : TRANSPARENT)
    .borderRadius(10)
    .accessibilityText(`${entry.deviceName}, ${this.isActiveDevice(entry.deviceId) ? ConnectionStatusPresenter.label(this.connectionState) :
      RemoteI18n.t(entry.online ? 'sidebar.deviceOnline' : 'sidebar.deviceOffline')}`)
    .enabled(this.canUseDevice(entry) || this.canRetryDevice(entry))
    .onClick(() => {
      if (this.canRetryDevice(entry)) {
        this.onReconnect();
      } else if (this.canUseDevice(entry)) {
        this.onSelectDevice(entry.deviceId);
      }
    })
  }

  private canRetryDevice(entry: DeviceDirectoryEntry): boolean {
    return this.isActiveDevice(entry.deviceId) &&
      (this.connectionState === 'failed' || this.connectionState === 'disconnected');
  }

  private deviceHealthColor(entry: DeviceDirectoryEntry): ResourceColor {
    if (!this.isActiveDevice(entry.deviceId)) return entry.online ? STATUS_SUCCESS : SUBTLE;
    if (this.connectionState === 'connected') return STATUS_SUCCESS;
    if (this.connectionState === 'failed' || this.connectionState === 'disconnected') return STATUS_DANGER;
    return MUTED;
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
        workspaceId: this.isActiveDevice(entry.deviceId) ? this.workspaceId : '',
        workspaceKind: this.liveWorkspaceKind(entry),
        selectedSessionId: this.selectedSessionIdFor(entry),
        runningSessionId: this.isActiveDevice(entry.deviceId) ? this.runningSessionId : '',
        query: this.query,
        isActive: this.isActiveDevice(entry.deviceId),
        supportsHarnessProfiles: this.supportsHarnessProfiles,
        onRetry: () => {
          if (this.isDirectoryEntry(entry)) {
            this.onRetryDevice(entry.deviceId);
          }
        },
        onOpenSession: this.onOpenSession,
        onSessionActions: this.onSessionActions,
        onCreateInWorkspace: (path: string, agentType: string, connectionId?: string, sshHost?: string, workspaceId?: string) => {
          this.onCreateInWorkspace(entry.deviceId, path, agentType, connectionId, sshHost, workspaceId);
        },
        onOpenWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => {
          this.onOpenWorkspace(entry.deviceId, path, connectionId, sshHost, workspaceId);
        },
        onExpandWorkspace: async (path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): Promise<void> => {
          await this.onExpandWorkspace(entry.deviceId, path, remoteConnectionId, remoteSshHost, workspaceId);
        },
        onWorkspaceExpandedChange: (path: string, expanded: boolean, remoteConnectionId?: string, remoteSshHost?: string,
          workspaceId?: string): void => {
          this.directoryState.setWorkspaceExpanded(entry.deviceId, path, expanded, remoteConnectionId, remoteSshHost, workspaceId);
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
      selectedWorkspaceId: this.isActiveDevice(this.workspacePickerDevice().deviceId) ? this.workspaceId : '',
      selectedWorkspaceConnectionId: this.isActiveDevice(this.workspacePickerDevice().deviceId) ?
        this.workspaceConnectionId : '',
      selectedWorkspaceSshHost: this.isActiveDevice(this.workspacePickerDevice().deviceId) ? this.workspaceSshHost : '',
      loading: this.workspacePickerDevice().status === 'loading',
      onClose: () => {
        this.showWorkspacePicker = false;
      },
      onSelectWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => {
        const deviceId = this.workspacePickerDeviceId;
        this.showWorkspacePicker = false;
        this.onOpenWorkspace(deviceId, path, connectionId, sshHost, workspaceId);
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
