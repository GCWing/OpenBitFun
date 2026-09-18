import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { SavedRuntimeConnection, RecentWorkspaceEntry, RemoteWorkspaceIdentity } from '../../model/RemoteModels';
import { remoteWorkspaceIdentityMatches, remoteWorkspaceKey } from '../../services/RemoteSessionIdentity';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, LINE, MUTED, PAGE_BG, SOFT } from './Theme';

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
   * Catalog rows report their stable `workspaceId`; the manual path entry has
   * none, which is the only case where the host may resolve by path.
   */
  @Event onSelectWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string, _connectionId?: string) => {};

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

  build() {
    Column() {
      this.Header()
      Divider().color(LINE)
      TextInput({ text: this.targetPath, placeholder: RemoteI18n.t('sidebar.targetWorkspacePath') })
        .onChange((value: string) => { this.targetPath = value; })
        .enabled(!this.loading)
      Select(this.connectionOptions())
        .selected(0)
        .onSelect((index: number) => { this.connectionId = index > 0 ? this.savedConnections[index - 1].id : ''; this.browsing = false; })
      Button(RemoteI18n.t('workspaceTools.browse')).enabled(this.canBrowse && !this.tools.browseBusy)
        .onClick(() => { this.browsing = true; this.onBrowse({ type: 'browse-workspace', path: this.targetPath || (this.connectionId.length === 0 ? this.selectedWorkspacePath : '') || '/', text: this.connectionId }); })
      if (this.browsing) { this.FolderBrowser() }
      Button(RemoteI18n.t('sidebar.openWorkspacePath'))
        .enabled(!this.loading && this.targetPath.trim().length > 0)
        .onClick(() => this.onSelectWorkspace(this.targetPath.trim(), this.connectionId.length > 0 ? this.connectionId : undefined))
      if (this.loading && this.workspaces.length === 0) {
        this.LoadingState()
      } else if (this.workspaces.length === 0) {
        this.EmptyState()
      } else {
        Scroll() {
          Column({ space: 4 }) {
            ForEach(this.workspaces, (workspace: RecentWorkspaceEntry) => {
              this.WorkspaceRow(workspace)
            }, (workspace: RecentWorkspaceEntry): string => remoteWorkspaceKey(workspace))
          }
          .width('100%')
          .padding({ top: 10, bottom: 18 })
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 10 })
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private FolderBrowser() {
    Column({ space: 8 }) {
      Text(this.tools.browseError || this.tools.browsePath).fontColor(MUTED).maxLines(2)
      Row({ space: 8 }) {
        Button(RemoteI18n.t('workspaceTools.up')).onClick(() => {
          const current = this.tools.browsePath.replace(/\/+$/, '');
          this.onBrowse({ type: 'browse-workspace', path: current.slice(0, current.lastIndexOf('/')) || '/', text: this.connectionId });
        })
        Button(RemoteI18n.t('workspaceTools.selectFolder')).onClick(() => { this.targetPath = this.tools.browsePath; this.browsing = false; })
      }.enabled(!this.tools.browseBusy && this.tools.browsePath.length > 0)
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
  private WorkspaceRow(workspace: RecentWorkspaceEntry) {
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
        Text((workspace.name || this.basename(workspace.path)) + (workspace.remoteSshHost?.trim() ? ` · ${workspace.remoteSshHost.trim()}` : ''))
          .width('100%')
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(this.isSelected(workspace) ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(workspace.path)
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(this.isSelected(workspace) ?
          $r('sys.symbol.checkmark') : $r('sys.symbol.chevron_right'))
          .fontSize(this.isSelected(workspace) ? 17 : 15)
          .fontColor([this.isSelected(workspace) ? INK : MUTED])
      }
      .width(40)
      .height(40)
    }
    .width('100%')
    .height(68)
    .padding({ left: 10, right: 8 })
    .borderRadius(14)
    .backgroundColor(this.isSelected(workspace) ? SOFT : PAGE_BG)
    .onClick(() => this.onSelectWorkspace(workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId))
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
      Text(RemoteI18n.t('sidebar.emptyWorkspaces'))
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
