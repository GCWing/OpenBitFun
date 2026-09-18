import { remoteWorkspaceIdentityMatches, remoteWorkspaceKey, remoteSessionBelongsToWorkspace } from '../../services/RemoteSessionIdentity';
import { WorkspaceToolsIntent } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RecentWorkspaceEntry, RemoteSession, RemoteWorkspaceIdentity } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  DeviceDirectoryEntry,
  DeviceDirectoryState,
  WorkspaceDirectoryStatus
} from '../state/DeviceDirectoryState';
import {
  SessionListInputs,
  SessionListProjection,
  SessionListProjectionCache
} from '../policy/SessionListProjection';
import { ConversationSessionFilterPolicy } from '../policy/ConversationSessionFilterPolicy';
import { SidebarDirectoryPreviewPolicy } from '../policy/SidebarDirectoryPreviewPolicy';
import { HarnessProfileMenu } from './HarnessProfileMenu';
import {
  INK,
  PAGE_BG,
  MUTED,
  SOFT,
  STATUS_SUCCESS,
  TRANSPARENT,
} from './Theme';

/**
 * One keyed disclosure boundary per workspace. Disclosure and request state
 * live on DeviceDirectoryEntry so navigation can rebuild this component without
 * collapsing the branch or forgetting an in-flight lazy load.
 */
@ComponentV2
struct SidebarWorkspaceGroup {
  @Param sshHost: string = '';
  @Param connectionId: string = '';
  /** Stable record ID of this row; empty only for rows from pre-ID hosts. */
  @Param workspaceId: string = '';
  @Event onWorkspaceTools: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  @Param deviceId: string = '';
  @Param path: string = '';
  @Param name: string = '';
  @Param sessions: RemoteSession[] = [];
  @Param selectedSessionId: string = '';
  @Param runningSessionId: string = '';
  @Param currentWorkspace: boolean = false;
  @Param activeDevice: boolean = false;
  @Param bodyIndent: number = 10;
  @Param expanded: boolean = false;
  @Param loadStatus: WorkspaceDirectoryStatus = 'idle';
  @Param hasLoadedSessions: boolean = false;
  @Param supportsHarnessProfiles: boolean = false;
  @Event onOpenWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void = (_path: string) => {};
  @Event onExpandWorkspace: (path: string) => Promise<void> = async (_path: string) => {};
  @Event onExpandedChange: (path: string, expanded: boolean) => void =
    (_path: string, _expanded: boolean) => {};
  @Event onCreateInWorkspace: (path: string, agentType: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string, _agentType: string) => {};
  @Event onOpenSession: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onSessionActions: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Local visibleSessionCount: number = SidebarDirectoryPreviewPolicy.PREVIEW_COUNT;
  @Local showCreateMenu: boolean = false;

  private workspaceIdOrUndefined(): string | undefined {
    return this.workspaceId.length > 0 ? this.workspaceId : undefined;
  }

  build() {
    Column() {
      this.WorkspaceRow()
      if (this.expanded) {
        if (this.loadStatus === 'loading' && !this.hasLoadedSessions && this.sessions.length === 0) {
          this.SessionLoadingRow()
        } else if (this.loadStatus === 'failed') {
          this.SessionRetryRow()
        }
        ForEach(this.visibleSessions(), (item: RemoteSession) => {
          this.SessionRow(item)
        }, (item: RemoteSession): string => `${item.deviceId || this.deviceId}:${item.id}`)
        if (this.hiddenSessionCount() > 0) {
          this.MoreSessionsRow()
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: 6 })
  }

  @Builder
  private WorkspaceRow() {
    Row({ space: 6 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(this.expanded ?
          $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_right'))
          .fontSize(13)
          .fontColor([MUTED])
          .hitTestBehavior(HitTestMode.None)
      }
      .width(24)
      .height(46)
      .accessibilityText(this.expanded ?
        RemoteI18n.t('chat.showLess') : RemoteI18n.t('chat.showMore'))
      .onClick(() => {
        void this.toggleExpanded();
      })

      Row({ space: 10 }) {
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(19)
          .fontColor([this.currentWorkspace ? INK : MUTED])
          .width(21)
          .height(21)
          .hitTestBehavior(HitTestMode.None)
        Text(this.name || this.basename(this.path))
          .fontSize(MobileDesignTypography.titleSmall.size)
          .fontWeight(this.currentWorkspace ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(INK)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .wordBreak(WordBreak.BREAK_ALL)
          .hitTestBehavior(HitTestMode.None)
      }
      .layoutWeight(1)
      .height(46)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        void this.toggleExpanded();
      })
      .gesture(LongPressGesture({ repeat: false }).onAction(() => {
        this.onOpenWorkspace(this.path, this.connectionId, this.sshHost, this.workspaceIdOrUndefined());
      }))

      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(17)
          .fontColor([INK])
          .hitTestBehavior(HitTestMode.None)
      }
      .width(30)
      .height(40)
      .accessibilityText(RemoteI18n.t('sidebar.newInWorkspace'))
      .bindPopup(this.showCreateMenu, {
        builder: () => {
          this.CreateModeMenu()
        },
        placement: Placement.Top,
        popupColor: TRANSPARENT,
        enableArrow: false,
        autoCancel: true,
        mask: false,
        targetSpace: 6,
        onStateChange: (event) => {
          if (!event.isVisible) {
            this.showCreateMenu = false;
          }
        }
      })
      .onClick(() => {
        this.showCreateMenu = !this.showCreateMenu;
      })
    }
    .width('100%')
    .height(46)
    .padding({ left: Math.max(0, this.bodyIndent - 4), right: 6 })
    .alignItems(VerticalAlign.Center)
    .borderRadius(10)
  }

  @Builder
  private CreateModeMenu() {
    HarnessProfileMenu({ showTitle: false, onSelect: (agentType: string) => {
      this.showCreateMenu = false;
      this.onCreateInWorkspace(this.path, agentType, this.connectionId, this.sshHost, this.workspaceIdOrUndefined());
    } })
  }

  @Builder
  private SessionLoadingRow() {
    Row({ space: 8 }) {
      LoadingProgress()
        .width(13)
        .height(13)
        .color(MUTED)
      Text(RemoteI18n.t('common.loading'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(40)
    .padding({ left: this.bodyIndent + 34, right: 10 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private SessionRetryRow() {
    Row({ space: 8 }) {
      Text(RemoteI18n.t('sidebar.deviceLoadFailed'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
        .layoutWeight(1)
      Text(RemoteI18n.t('common.retry'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(INK)
    }
    .width('100%')
    .height(40)
    .padding({ left: this.bodyIndent + 34, right: 10 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      void this.loadSessions();
    })
  }

  @Builder
  private SessionRow(item: RemoteSession) {
    Row({ space: 8 }) {
      Stack({ alignContent: Alignment.BottomStart }) {
        SymbolGlyph(this.sessionGlyph(item))
          .fontSize(17)
          .fontColor([MUTED])
          .width(19)
          .height(19)
        if (this.activeDevice && item.id === this.runningSessionId) {
          Text('')
            .width(7)
            .height(7)
            .backgroundColor(STATUS_SUCCESS)
            .borderRadius(4)
        }
      }
      .width(19)
      .height(19)
      Text(item.title || RemoteI18n.t('sidebar.untitled'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontWeight(item.id === this.selectedSessionId ? FontWeight.Bold : FontWeight.Regular)
        .fontColor(INK)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .wordBreak(WordBreak.BREAK_ALL)
    }
    .width('100%')
    .height(44)
    .padding({ left: this.bodyIndent + 34, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(item.id === this.selectedSessionId ? SOFT : TRANSPARENT)
    .borderRadius(10)
    .onClick(() => {
      this.onOpenSession(item);
    })
    .gesture(LongPressGesture({ repeat: false }).onAction(() => {
      this.onSessionActions(item);
    }))
  }

  @Builder
  private MoreSessionsRow() {
    Row({ space: 8 }) {
      Text('···')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
      Text(RemoteI18n.f('sidebar.moreSessions', String(this.hiddenSessionCount())))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(40)
    .padding({ left: this.bodyIndent + 34 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.visibleSessionCount = SidebarDirectoryPreviewPolicy.nextVisibleCount(
        this.visibleSessionCount,
        this.sessions.length
      );
    })
  }

  private visibleSessions(): RemoteSession[] {
    return SidebarDirectoryPreviewPolicy.visibleSlice(this.sessions, this.visibleSessionCount);
  }

  private async toggleExpanded(): Promise<void> {
    const expanded = !this.expanded;
    this.onExpandedChange(this.path, expanded);
    if (!expanded || this.sessions.length > 0 || this.loadStatus === 'ready' ||
      this.loadStatus === 'loading') {
      return;
    }
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      await this.onExpandWorkspace(this.path);
    } catch (_err) {
      // The request owner records failure without clearing cached rows.
    }
  }

  private hiddenSessionCount(): number {
    return SidebarDirectoryPreviewPolicy.hiddenCount(this.sessions.length, this.visibleSessionCount);
  }

  private sessionGlyph(item: RemoteSession): Resource {
    const agentType = (item.agentType ? item.agentType : '').toLowerCase();
    if (agentType === 'code') {
      return $r('sys.symbol.code_square');
    }
    if (agentType === 'claw' || agentType === 'assistant' || agentType === 'chat') {
      return $r('sys.symbol.message');
    }
    return $r('sys.symbol.doc_text');
  }

  private basename(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.substring(index + 1) : normalized;
  }
}

/**
 * One desktop's workspaces and sessions.
 *
 * The projection cache is a single slot whose key includes the current
 * workspace path, so one instance cannot serve two devices without missing
 * every rebuild. Its parent therefore keys this component boundary by device.
 */
@ComponentV2
export struct SidebarDeviceGroup {
  @Event onWorkspaceTools: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  @Param device: DeviceDirectoryEntry = new DeviceDirectoryEntry();
  @Param directoryState: DeviceDirectoryState = new DeviceDirectoryState();
  @Param sessions: RemoteSession[] = [];
  @Param recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Param workspaceName: string = '';
  @Param workspacePath: string = '';
  @Param workspaceConnectionId: string = '';
  @Param workspaceSshHost: string = '';
  /** Stable record ID of the desktop's active workspace; empty for pre-ID hosts. */
  @Param workspaceId: string = '';
  @Param workspaceKind: string = 'normal';
  @Param selectedSessionId: string = '';
  @Param runningSessionId: string = '';
  @Param query: string = '';
  @Param isActive: boolean = false;
  @Param supportsHarnessProfiles: boolean = false;
  @Event onRetry: () => void = () => {};
  @Event onOpenSession: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onSessionActions: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onCreateInWorkspace: (path: string, agentType: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string, _agentType: string) => {};
  @Event onOpenWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void = (_path: string) => {};
  @Event onExpandWorkspace: (path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string) => Promise<void> = async (_path: string) => {};
  @Event onWorkspaceExpandedChange: (path: string, expanded: boolean, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string) => void =
    (_path: string, _expanded: boolean) => {};
  @Local visibleWorkspaceCount: number = SidebarDirectoryPreviewPolicy.PREVIEW_COUNT;
  private readonly projectionCache: SessionListProjectionCache = new SessionListProjectionCache();

  build() {
    Column() {
      if (this.device.status === 'failed') {
        this.FailedRow()
      } else if (this.workspaceEntries().length === 0) {
        if (this.device.status === 'ready') {
          this.EmptyWorkspaces()
        } else if (this.device.status === 'cached') {
          this.EmptyWorkspaces()
        } else {
          this.LoadingRow()
        }
      } else {
        ForEach(this.visibleWorkspaceEntries(), (entry: RecentWorkspaceEntry) => {
          SidebarWorkspaceGroup({
            connectionId: entry.remoteConnectionId || '',
            sshHost: entry.remoteSshHost || '',
            workspaceId: entry.workspaceId || '',
            onWorkspaceTools: this.onWorkspaceTools,
            deviceId: this.device.deviceId,
            path: entry.path,
            name: entry.remoteSshHost?.trim() ? `${entry.name} · ${entry.remoteSshHost.trim()}` : entry.name,
            sessions: this.sessionsFor(entry),
            selectedSessionId: this.selectedSessionId,
            runningSessionId: this.runningSessionId,
            currentWorkspace: this.isCurrentWorkspace(entry),
            activeDevice: this.isActive,
            supportsHarnessProfiles: this.supportsHarnessProfiles,
            bodyIndent: 10,
            expanded: this.directoryState.workspaceExpanded(
              this.device.deviceId, entry.path, entry.remoteConnectionId, entry.remoteSshHost, entry.workspaceId),
            loadStatus: this.directoryState.workspaceStatus(
              this.device.deviceId, entry.path, entry.remoteConnectionId, entry.remoteSshHost, entry.workspaceId),
            hasLoadedSessions: this.directoryState.workspaceHasLoadedSessions(
              this.device.deviceId, entry.path, entry.remoteConnectionId, entry.remoteSshHost, entry.workspaceId),
            onOpenWorkspace: this.onOpenWorkspace,
            onExpandWorkspace: (path: string): Promise<void> =>
              this.onExpandWorkspace(path, entry.remoteConnectionId, entry.remoteSshHost, entry.workspaceId),
            onExpandedChange: (path: string, expanded: boolean): void =>
              this.onWorkspaceExpandedChange(path, expanded, entry.remoteConnectionId, entry.remoteSshHost, entry.workspaceId),
            onCreateInWorkspace: this.onCreateInWorkspace,
            onOpenSession: this.onOpenSession,
            onSessionActions: this.onSessionActions
          })
        }, (entry: RecentWorkspaceEntry): string =>
          `${this.device.deviceId}:${remoteWorkspaceKey(entry)}`)
        if (this.hiddenWorkspaceCount() > 0) {
          this.MoreWorkspacesRow()
        }
        if (this.device.status === 'loading') {
          this.LoadingRow()
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private LoadingRow() {
    Row({ space: 8 }) {
      LoadingProgress()
        .width(14)
        .height(14)
        .color(MUTED)
      Text(RemoteI18n.t('common.loading'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(40)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private FailedRow() {
    Row({ space: 8 }) {
      Text(this.device.errorText.length > 0 ?
        this.device.errorText : RemoteI18n.t('sidebar.deviceLoadFailed'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
        .layoutWeight(1)
      Text(RemoteI18n.t('common.retry'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(INK)
        .onClick(() => {
          this.onRetry();
        })
    }
    .width('100%')
    .height(40)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private EmptyWorkspaces() {
    Text(RemoteI18n.t('sidebar.emptyWorkspaces'))
      .fontSize(MobileDesignTypography.bodyMedium.size)
      .fontColor(MUTED)
      .width('100%')
      .padding({ left: 10, top: 6, bottom: 6 })
  }

  @Builder
  private MoreWorkspacesRow() {
    Row({ space: 8 }) {
      Text('···')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
      Text(RemoteI18n.f('sidebar.moreWorkspaces', String(this.hiddenWorkspaceCount())))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .height(40)
    .padding({ left: 10 })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.visibleWorkspaceCount = SidebarDirectoryPreviewPolicy.nextVisibleCount(
        this.visibleWorkspaceCount,
        this.workspaceEntries().length
      );
    })
  }

  private projection(): SessionListProjection {
    const inputs: SessionListInputs = {
      sessions: this.sessions,
      query: this.query,
      sortMode: 'project',
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      workspaceConnectionId: this.workspaceConnectionId,
      workspaceSshHost: this.workspaceSshHost,
      workspaceKind: this.workspaceKind,
      recentWorkspaces: this.recentWorkspaces,
      workspaceFilter: '',
      agentFilter: '',
      statusFilter: '',
      showWorkspaceMetadata: false,
      showUpdatedMetadata: false,
      showStatusMetadata: false
    };
    return this.projectionCache.get(inputs);
  }

  private workspaceEntries(): RecentWorkspaceEntry[] {
    // Device catalog membership is authoritative, even when empty. Selection
    // and historical sessions cannot reopen a workspace in the sidebar.
    const entries = this.recentWorkspaces.slice();
    const query = this.query.trim().toLowerCase();
    if (query.length === 0) {
      return entries;
    }
    return entries.filter((entry: RecentWorkspaceEntry): boolean => {
      const label = (entry.name || this.basename(entry.path)).toLowerCase();
      return label.indexOf(query) >= 0 || entry.path.toLowerCase().indexOf(query) >= 0 ||
        this.sessionsFor(entry).length > 0;
    });
  }

  private visibleWorkspaceEntries(): RecentWorkspaceEntry[] {
    return SidebarDirectoryPreviewPolicy.visibleSlice(
      this.workspaceEntries(),
      this.visibleWorkspaceCount
    );
  }

  private hiddenWorkspaceCount(): number {
    return SidebarDirectoryPreviewPolicy.hiddenCount(
      this.workspaceEntries().length,
      this.visibleWorkspaceCount
    );
  }

  private sessionsFor(entry: RecentWorkspaceEntry): RemoteSession[] {
    return this.projection().filtered.filter((item: RemoteSession): boolean =>
      remoteSessionBelongsToWorkspace(item, entry, this.workspaceEntries()));
  }

  private isCurrentWorkspace(entry: RecentWorkspaceEntry): boolean {
    if (!this.isActive || entry.path.length === 0) {
      return false;
    }
    const current: RemoteWorkspaceIdentity = {
      workspaceId: this.workspaceId.length > 0 ? this.workspaceId : undefined,
      path: this.workspacePath,
      remoteConnectionId: this.workspaceConnectionId.length > 0 ? this.workspaceConnectionId : undefined,
      remoteSshHost: this.workspaceSshHost.length > 0 ? this.workspaceSshHost : undefined
    };
    return remoteWorkspaceIdentityMatches(entry, current, this.recentWorkspaces);
  }

  private basename(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.substring(index + 1) : normalized;
  }

}
