import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { SavedRuntimeConnection, RecentWorkspaceEntry, RemoteWorkspaceIdentity } from '../../model/RemoteModels';
import { remoteWorkspaceIdentityMatches, remoteWorkspaceKey } from '../../services/RemoteSessionIdentity';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, CONTENT_ON_ACTION, INK, LINE, MUTED, PAGE_BG, PRIMARY_ACTION, SOFT, TRANSPARENT } from './Theme';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

@ComponentV2
export struct SidebarWorkspacePicker {
  @Local browsing: boolean = false;
  @Param tools: WorkspaceToolsState = new WorkspaceToolsState();
  @Param canBrowse: boolean = false;
  @Event onBrowse: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  @Local targetPath: string = '';
  @Local connectionId: string = '';
  @Param savedConnections: SavedRuntimeConnection[] = [];
  @Param deviceName: string = '';
  @Param workspaces: RecentWorkspaceEntry[] = [];
  @Param selectedWorkspacePath: string = '';
  /** Identity of the active workspace; the ID wins over the path when present. */
  @Param selectedWorkspaceId: string = '';
  @Param selectedWorkspaceConnectionId: string = '';
  @Param selectedWorkspaceSshHost: string = '';
  @Param loading: boolean = false;
  @Event onClose: () => void = () => {};
  /**
   * The sheet's own bottom edge, in vp. The picker is a full-height sheet and
   * its confirm button is the fixed control at that edge, so the button keeps
   * the navigation bar clear itself.
   */
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }
  /**
   * Catalog rows report their stable `workspaceId`; the manual path entry has
   * none, which is the only case where the host may resolve by path.
   */
  @Event onSelectWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string, _connectionId?: string) => {};

  // Keyed rows keep their identity; resolve their content from the latest snapshot.
  @Computed
  get workspaceIndex(): Map<string, RecentWorkspaceEntry> {
    const index = new Map<string, RecentWorkspaceEntry>();
    this.workspaces.forEach((item: RecentWorkspaceEntry) => { index.set(remoteWorkspaceKey(item), item); });
    return index;
  }

  private currentWorkspace(item: RecentWorkspaceEntry): RecentWorkspaceEntry {
    return this.workspaceIndex.get(remoteWorkspaceKey(item)) || item;
  }

  private isSelected(workspace: RecentWorkspaceEntry): boolean {
    if (this.selectedWorkspacePath.length === 0 && this.selectedWorkspaceId.length === 0) {
      return false;
    }
    const selected: RemoteWorkspaceIdentity = {
      workspaceId: this.selectedWorkspaceId.length > 0 ? this.selectedWorkspaceId : undefined,
      path: this.selectedWorkspacePath,
      remoteConnectionId: this.selectedWorkspaceConnectionId.length > 0 ? this.selectedWorkspaceConnectionId : undefined,
      remoteSshHost: this.selectedWorkspaceSshHost.length > 0 ? this.selectedWorkspaceSshHost : undefined
    };
    return remoteWorkspaceIdentityMatches(workspace, selected, this.workspaces);
  }

  private connectionOptions(): SelectOption[] {
    const options: SelectOption[] = [{ value: this.deviceName }];
    this.savedConnections.forEach((connection: SavedRuntimeConnection) => { options.push({ value: connection.name }); });
    return options;
  }

  private selectedConnectionIndex(): number {
    if (this.connectionId.length === 0) return 0;
    const index = this.savedConnections.findIndex((connection: SavedRuntimeConnection): boolean => connection.id === this.connectionId);
    return index >= 0 ? index + 1 : 0;
  }

  private visibleWorkspaces(): RecentWorkspaceEntry[] {
    if (this.connectionId.length === 0) {
      return this.workspaces.filter((item: RecentWorkspaceEntry): boolean => !this.isRemoteRoot(item))
        .concat(this.workspaces.filter((item: RecentWorkspaceEntry): boolean => this.isRemoteRoot(item)));
    }
    // A saved SSH profile is not a live connection. Do not keep showing the
    // host catalog while the selected profile is still probing or unavailable.
    if (this.tools.browseBusy || this.tools.browseError.length > 0 ||
      this.tools.browsePath.length === 0 || this.tools.browseEntries.length === 0) return [];
    const connection = this.savedConnections.find((item: SavedRuntimeConnection): boolean => item.id === this.connectionId);
    const rows = this.workspaces.filter((item: RecentWorkspaceEntry): boolean =>
      item.remoteConnectionId === this.connectionId ||
      (connection !== undefined && connection.host.length > 0 && item.remoteSshHost === connection.host)
    );
    // Keep a persisted remote root available for browsing, but put concrete
    // project folders first so the root cannot masquerade as the project.
    return rows.filter((item: RecentWorkspaceEntry): boolean => !this.isRemoteRoot(item))
      .concat(rows.filter((item: RecentWorkspaceEntry): boolean => this.isRemoteRoot(item)));
  }

  private isRemoteRoot(workspace: RecentWorkspaceEntry): boolean {
    const path = (workspace.path || '').trim();
    return path === '/' && (workspace.workspaceKind || '').toLowerCase() === 'remote';
  }

  private canOpenTargetPath(): boolean {
    const path = this.targetPath.trim();
    return !this.loading && path.length > 0 && !(this.connectionId.length > 0 && path === '/');
  }

  private openRemoteRootForBrowsing(workspace: RecentWorkspaceEntry): void {
    const connection = workspace.remoteConnectionId || this.connectionId;
    if (connection.length === 0) return;
    this.connectionId = connection;
    this.targetPath = '/';
    this.browsing = true;
    this.onBrowse({ type: 'browse-workspace', path: '/', text: connection });
  }

  private workspaceTitle(workspace: RecentWorkspaceEntry): string {
    if (this.isRemoteRoot(workspace)) return RemoteI18n.t('sidebar.browseRemoteRoot');
    return workspace.name || this.basename(workspace.path);
  }

  private workspaceSubtitle(workspace: RecentWorkspaceEntry): string {
    const connectionId = workspace.remoteConnectionId?.trim() || '';
    const savedConnection = connectionId.length > 0 ?
      this.savedConnections.find((connection: SavedRuntimeConnection): boolean => connection.id === connectionId) : undefined;
    const remoteLabel = savedConnection?.name?.trim() || workspace.remoteSshHost?.trim() || '';
    return remoteLabel.length > 0 ? `${remoteLabel} · ${workspace.path}` : workspace.path;
  }

  private selectConnection(index: number): void {
    this.connectionId = index > 0 ? this.savedConnections[index - 1].id : '';
    this.browsing = this.connectionId.length > 0;
    if (this.connectionId.length > 0) {
      this.targetPath = '/';
      this.onBrowse({ type: 'browse-workspace', path: '/', text: this.connectionId });
    }
  }

  build() {
    Column({ space: 0 }) {
      this.Header()
      Divider().color(LINE)
      if (this.savedConnections.length > 0 || this.deviceName.length > 0) {
        Column({ space: 7 }) {
          Text(RemoteI18n.t('sidebar.controlledDevice')).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
          Select(this.connectionOptions())
            .selected(this.selectedConnectionIndex())
            .value(this.connectionId.length > 0 ? this.savedConnections.find((connection: SavedRuntimeConnection): boolean => connection.id === this.connectionId)?.name || this.deviceName : this.deviceName)
            .fontColor(INK).width('100%').height(54).enabled(!this.loading)
            .backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(16)
            .onSelect((index: number) => this.selectConnection(index))
        }.width('100%').padding({ top: 14, bottom: 12 })
      }
      Column({ space: 7 }) {
        Text(RemoteI18n.t('sidebar.currentPath')).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
        Row({ space: 10 }) {
          Stack({ alignContent: Alignment.Center }) {
            SymbolGlyph($r('sys.symbol.folder')).fontSize(19).fontColor([INK])
          }.width(38).height(38).borderRadius(11).backgroundColor(CARD)
          TextInput({ text: this.targetPath, placeholder: RemoteI18n.t('sidebar.targetWorkspacePath') })
            .fontColor(INK).fontSize(MobileDesignTypography.bodySmall.size).layoutWeight(1)
            .height(38).padding({ left: 0, right: 0 }).backgroundColor(TRANSPARENT).border({ width: 0, color: TRANSPARENT })
            .onChange((value: string) => { this.targetPath = value; })
            .enabled(!this.loading)
          SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(16).fontColor([MUTED])
        }.width('100%').height(64).padding({ left: 12, right: 12 }).backgroundColor(SOFT).borderRadius(16)
      }.width('100%').padding({ bottom: 12 })
      Button(RemoteI18n.t('workspaceTools.browse'))
        .fontColor(INK).fontSize(MobileDesignTypography.bodySmall.size).height(44).width('100%')
        .backgroundColor(SOFT).borderRadius(13).enabled(this.canBrowse && !this.tools.browseBusy && !this.loading)
        .onClick(() => { this.browsing = true; this.onBrowse({ type: 'browse-workspace', path: this.targetPath || (this.connectionId.length === 0 ? this.selectedWorkspacePath : '') || '/', text: this.connectionId }); })
      if (this.browsing) { this.FolderBrowser() }
      if (this.connectionId.length > 0 && this.targetPath.trim() === '/') {
        Text(RemoteI18n.t('sidebar.remoteRootBrowseOnly'))
          .fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
          .maxLines(2).width('100%').padding({ top: 2 })
      }
      Row({ space: 8 }) {
        Text(RemoteI18n.t('sidebar.recentWorkspaces')).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size).fontWeight(FontWeight.Medium).layoutWeight(1)
        Text(RemoteI18n.t('sidebar.tapToSwitch')).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
      }.width('100%').padding({ top: 14, bottom: 7 })
      if ((this.loading || this.tools.browseBusy) && this.visibleWorkspaces().length === 0) {
        this.LoadingState()
      } else if (this.visibleWorkspaces().length === 0) {
        this.EmptyState()
      } else {
        Scroll() {
          Column({ space: 4 }) {
            ForEach(this.visibleWorkspaces(), (row: RecentWorkspaceEntry) => {
              this.WorkspaceRow(row)
            }, (workspace: RecentWorkspaceEntry): string => remoteWorkspaceKey(workspace))
          }
          .width('100%')
          .padding({ top: 10, bottom: 18 })
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
      Row() {
        Button(RemoteI18n.t('sidebar.openWorkspacePath'))
          .fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.bodyMedium.size).fontWeight(FontWeight.Medium)
          .backgroundColor(PRIMARY_ACTION).height(48).width('100%').borderRadius(14)
          .enabled(this.canOpenTargetPath())
          .onClick(() => this.onSelectWorkspace(this.targetPath.trim(), this.connectionId.length > 0 ? this.connectionId : undefined))
        // The sheet's fixed confirm button: the strip, or the design's own
        // spacing where the strip is already clear, so it never sits in it.
      }.width('100%').padding({ top: 12, bottom: this.insets.bottomPadding(16) }).backgroundColor(PAGE_BG)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 10 })
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private FolderBrowser() {
    Column({ space: 8 }) {
      if (this.tools.browseBusy) {
        Row({ space: 8 }) {
          LoadingProgress().width(18).height(18).color(MUTED)
          Text(RemoteI18n.t('common.loading')).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size)
        }.width('100%')
      } else if (this.tools.browseError.length > 0) {
        Text(this.tools.browseError).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size).maxLines(3)
      } else {
        Text(this.tools.browsePath).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size).maxLines(2)
      }
      Row({ space: 8 }) {
        Button(RemoteI18n.t('workspaceTools.up'))
          .fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size).height(40).layoutWeight(1)
          .backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(12)
          .onClick(() => {
          const current = this.tools.browsePath.replace(/\/+$/, '');
          this.onBrowse({ type: 'browse-workspace', path: current.slice(0, current.lastIndexOf('/')) || '/', text: this.connectionId });
        })
        Button(RemoteI18n.t('workspaceTools.selectFolder'))
          .fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.labelSmall.size).height(40).layoutWeight(1)
          .backgroundColor(INK).borderRadius(12)
          .onClick(() => { this.targetPath = this.tools.browsePath; this.browsing = false; })
      }.enabled(!this.tools.browseBusy && this.tools.browseError.length === 0 && this.tools.browsePath.length > 0)
      List() {
        ForEach(this.tools.browseEntries, (entry: WorkspaceFileEntry) => {
          if (entry.isDirectory) {
            ListItem() { Text(entry.name).fontColor(INK).padding(10).width('100%')
              .onClick(() => this.onBrowse({ type: 'browse-workspace', path: entry.path, text: this.connectionId })) }
          }
        }, (entry: WorkspaceFileEntry): string => entry.path)
        if (this.tools.browseHasMore) { ListItem() { Button(RemoteI18n.t('workspaceTools.more')).onClick(() => this.onBrowse({ type: 'browse-more', path: this.tools.browsePath, text: this.connectionId })) } }
      }.height(200).enabled(!this.tools.browseBusy)
    }.width('100%')
  }

  @Builder
  private Header() {
    Row({ space: 12 }) {
      Column({ space: 2 }) {
        Text(RemoteI18n.t('sidebar.selectWorkspace'))
          .width('100%')
          .fontSize(MobileDesignTypography.headlineMedium.size)
          .fontWeight(FontWeight.Bold)
          .fontColor(INK)
        Text(this.deviceName)
          .width('100%')
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.xmark'))
          .fontSize(17)
          .fontColor([MUTED])
      }
      .width(40)
      .height(40)
      .borderRadius(20)
      .backgroundColor(SOFT)
      .accessibilityText(RemoteI18n.t('common.close'))
      .onClick(() => this.onClose())
    }
    .width('100%')
    .height(66)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private WorkspaceRow(row: RecentWorkspaceEntry) {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.folder'))
          .fontSize(20)
          .fontColor([INK])
      }
      .width(34)
      .height(34)
      .borderRadius(10)
      .backgroundColor(CARD)
      Column({ space: 3 }) {
        Text(this.workspaceTitle(this.currentWorkspace(row)))
          .width('100%')
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(this.isSelected(this.currentWorkspace(row)) ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.workspaceSubtitle(this.currentWorkspace(row)))
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(this.isRemoteRoot(this.currentWorkspace(row)) ?
          $r('sys.symbol.questionmark_circle') : this.isSelected(this.currentWorkspace(row)) ?
          $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.chevron_right'))
          .fontSize(this.isRemoteRoot(this.currentWorkspace(row)) ? 17 : this.isSelected(this.currentWorkspace(row)) ? 19 : 15)
          .fontColor([this.isRemoteRoot(this.currentWorkspace(row)) ? MUTED : this.isSelected(this.currentWorkspace(row)) ? PRIMARY_ACTION : MUTED])
      }
      .width(40)
      .height(40)
    }
    .width('100%')
    .height(68)
    .padding({ left: 10, right: 8 })
    .borderRadius(14)
    .backgroundColor(this.isSelected(this.currentWorkspace(row)) ? SOFT : PAGE_BG)
    .onClick(() => {
      const workspace = this.currentWorkspace(row);
      if (this.isRemoteRoot(workspace)) {
        this.openRemoteRootForBrowsing(workspace);
      } else {
        this.onSelectWorkspace(workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId);
      }
    })
  }

  @Builder
  private LoadingState() {
    Column({ space: 12 }) {
      LoadingProgress().width(22).height(22).color(MUTED)
      Text(RemoteI18n.t('common.loading')).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(MUTED)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  private EmptyState() {
    Column({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.folder')).fontSize(30).fontColor([MUTED])
      Text(this.connectionId.length > 0 ? RemoteI18n.t('status.remoteUnavailable') : RemoteI18n.t('sidebar.emptyWorkspaces'))
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  private basename(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.substring(index + 1) : normalized;
  }
}
