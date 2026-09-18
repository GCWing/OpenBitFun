import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  SCRIM,
  SHADOW_SUBTLE,
  SOFT,
  TRANSPARENT,
} from './Theme';
import { SessionActionPresentation, SessionActionSurface } from './SessionActionSurface';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { SessionActionCapabilities, SessionActionPolicy, SessionActionScope } from '../policy/SessionActionPolicy';
import { SessionDetailsView } from './SessionDetailsView';
import { RemoteSessionRow } from './RemoteSessionRow';
import { HarnessProfileMenu } from './HarnessProfileMenu';
import {
  SessionListInputs,
  SessionListProjection,
  SessionListProjectionCache,
  SessionListProjector
} from '../policy/SessionListProjection';

@ComponentV2
export struct RemoteSessionList {
  @Param sessions: RemoteSession[] = [];
  @Param query: string = '';
  @Param sortMode: string = 'project';
  @Param hasMoreSessions: boolean = false;
  @Param isBusy: boolean = false;
  @Param selectedSessionId: string = '';
  @Param workspaceName: string = '';
  @Param workspacePath: string = '';
  /** Stable record ID of the active workspace; empty for pre-ID hosts. */
  @Param workspaceId: string = '';
  @Param workspaceConnectionId: string = '';
  @Param workspaceSshHost: string = '';
  @Param workspaceKind: string = 'normal';
  @Param recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Param actionPresentation: SessionActionPresentation = SessionActionPresentation.BottomSheet;
  @Param sessionDetailsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.SessionDetails);
  @Param workspaceFilter: string = '';
  @Param agentFilter: string = '';
  @Param statusFilter: string = '';
  @Param showWorkspaceMetadata: boolean = false;
  @Param showUpdatedMetadata: boolean = false;
  @Param showStatusMetadata: boolean = false;
  @Param supportsHarnessProfiles: boolean = false;
  @Event onCreate: () => void = () => {};
  @Event onOpenSession: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onDeleteSession: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onLoadMore: () => void = () => {};
  @Event onCreateAssistantSession: () => void = () => {};
  /** Project rows report their catalog identity; the ID is what the host resolves by. */
  @Event onCreateInWorkspace: (path: string, agentType: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string, _agentType: string) => {};
  @Event onSelectWorkspace: (path: string, connectionId?: string, sshHost?: string, workspaceId?: string) => void =
    (_path: string) => {};
  // Disclosure state is keyed by the project's section key: its workspace ID
  // when the catalog supplies one, the legacy triple otherwise.
  @Local collapsedWorkspaceKeys: string[] = [];
  @Local projectVisibleSteps: string[] = [];
  @Local visibleProjectCount: number = 3;
  @Local chatsCollapsed: boolean = false;
  @Local chatVisibleCount: number = 3;
  @Local todayCollapsed: boolean = false;
  @Local yesterdayCollapsed: boolean = false;
  @Local earlierCollapsed: boolean = false;
  @Local createMenuKey: string = '';
  @Local activeActionSessionId: string = '';
  @Local showSessionActionSheet: boolean = false;
  @Local detailsSessionId: string = '';
  @Local showSessionDetails: boolean = false;
  @Local optimisticSelectedSessionId: string = '';
  // Selecting a row reruns this whole builder tree, and the tree asks for the
  // grouped lists far more often than it changes them. The cache answers from
  // the last projection unless the sessions, the workspaces or a filter moved —
  // none of which a selection touches.
  private readonly projectionCache: SessionListProjectionCache = new SessionListProjectionCache();

  @Monitor('isBusy', 'workspacePath')
  onWorkspaceContextChanged(): void {
    this.createMenuKey = '';
  }

  @Monitor('selectedSessionId')
  onSelectedSessionChanged(): void {
    this.optimisticSelectedSessionId = '';
  }

  build() {
    Column() {
      Scroll() {
        Column() {
          if (this.filteredSessions().length === 0) {
            if (this.hasActiveListFilter()) {
              this.FilteredEmptySessions()
            } else {
              this.EmptySessions()
            }
          } else if (this.sortMode === 'time') {
            this.TimeSection()
          } else if (this.sortMode === 'chat') {
            if (this.visibleChatSessions().length > 0) {
              this.ChatSection()
            }
            if (this.projectEntries().length > 0) {
              this.ProjectSection()
            }
          } else {
            if (this.projectEntries().length > 0) {
              this.ProjectSection()
            }
            if (this.visibleChatSessions().length > 0) {
              this.ChatSection()
            }
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
      .scrollable(ScrollDirection.Vertical)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .bindSheet($$this.showSessionActionSheet, this.SessionActionSheet(), this.sessionActionSheetOptions())
    .bindSheet($$this.showSessionDetails, this.SessionDetailsSheet(), this.sessionDetailsSheetOptions())
  }

  @Builder
  private TimeSection() {
    Column() {
      if (this.sessionsByTime().length === 0) {
        this.EmptySessions()
      } else {
        if (this.sessionsForTimeBucket('today').length > 0) {
          this.TodayGroup()
        }
        if (this.sessionsForTimeBucket('yesterday').length > 0) {
          this.YesterdayGroup()
        }
        if (this.sessionsForTimeBucket('earlier').length > 0) {
          this.EarlierGroup()
        }
      }
    }
    .width('100%')
    .margin({ top: 10, bottom: 16 })
  }

  @Builder
  private TodayGroup() {
    Column() {
      this.TimeGroupHeader(RemoteI18n.t('remote.time.today'), this.todayCollapsed, () => {
        this.todayCollapsed = !this.todayCollapsed;
      })
      if (!this.todayCollapsed) {
        ForEach(this.sessionsForTimeBucket('today'), (item: RemoteSession) => {
          this.SessionRow(item)
        }, (item: RemoteSession) => item.id)
      }
    }
    .width('100%')
    .margin({ bottom: 8 })
  }

  @Builder
  private YesterdayGroup() {
    Column() {
      this.TimeGroupHeader(RemoteI18n.t('remote.time.yesterday'), this.yesterdayCollapsed, () => {
        this.yesterdayCollapsed = !this.yesterdayCollapsed;
      })
      if (!this.yesterdayCollapsed) {
        ForEach(this.sessionsForTimeBucket('yesterday'), (item: RemoteSession) => {
          this.SessionRow(item)
        }, (item: RemoteSession) => item.id)
      }
    }
    .width('100%')
    .margin({ bottom: 8 })
  }

  @Builder
  private EarlierGroup() {
    Column() {
      this.TimeGroupHeader(RemoteI18n.t('remote.time.earlier'), this.earlierCollapsed, () => {
        this.earlierCollapsed = !this.earlierCollapsed;
      })
      if (!this.earlierCollapsed) {
        ForEach(this.sessionsForTimeBucket('earlier'), (item: RemoteSession) => {
          this.SessionRow(item)
        }, (item: RemoteSession) => item.id)
      }
    }
    .width('100%')
    .margin({ bottom: 8 })
  }

  @Builder
  private TimeGroupHeader(title: string, collapsed: boolean, action: () => void) {
    Row({ space: 8 }) {
      Text(title)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(MUTED)
      if (collapsed) {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(14)
          .fontColor([MUTED])
          .opacity(0.55)
      } else {
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(14)
          .fontColor([MUTED])
          .opacity(0.55)
      }
    }
    .width('100%')
    .height(42)
    .alignItems(VerticalAlign.Center)
    .onClick(action)
  }

  @Builder
  private ProjectSection() {
    Column({ space: 4 }) {
      Row() {
        Row({ space: 8 }) {
          Text(RemoteI18n.t('sidebar.projects'))
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(MUTED)
          Text(`${this.projectEntries().length}`)
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(MUTED)
        }
        Blank()
      }
      .width('100%')
      .height(44)
      .alignItems(VerticalAlign.Center)
      ForEach(this.visibleProjectEntries(), (project: RecentWorkspaceEntry) => {
        Column({ space: 2 }) {
          Row({ space: 10 }) {
            SymbolGlyph($r('sys.symbol.folder'))
              .fontSize(22)
              .fontColor([INK])
              .width(24)
              .height(24)
            Text(project.name || this.basename(project.path))
              .fontSize(MobileDesignTypography.titleSmall.size)
              .fontColor(INK)
              .layoutWeight(1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            // The Stack keeps the 18vp slot stable across both states; the
            // glyph stays unsized because a chevron_right is drawn against
            // the left edge of any box forced wider than its natural,
            // half-width advance box.
            Stack({ alignContent: Alignment.Center }) {
              SymbolGlyph(this.isWorkspaceCollapsed(this.sectionKey(project)) ?
                $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down'))
                .fontSize(14)
                .fontColor([MUTED])
            }
            .width(18)
            .height(18)
            if (project.path.length > 0) {
              SymbolGlyph($r('sys.symbol.square_and_pencil'))
                .fontSize(18)
                .fontColor([MUTED])
                .width(22)
                .height(22)
                .opacity(0.52)
                .bindPopup(this.createMenuKey.length > 0 && this.createMenuKey === this.sectionKey(project), {
                  builder: () => {
                    this.ProjectCreateMenu(project)
                  },
                  placement: Placement.Top,
                  popupColor: TRANSPARENT,
                  enableArrow: false,
                  autoCancel: true,
                  mask: false,
                  targetSpace: 6,
                  onStateChange: (event) => {
                    if (!event.isVisible) {
                      this.createMenuKey = '';
                    }
                  }
                })
                .onClick(() => {
                  const key = this.sectionKey(project);
                  this.createMenuKey = this.createMenuKey === key ? '' : key;
                })
            }
          }
          .width('100%')
          .height(44)
          .onClick(() => {
            this.toggleWorkspace(this.sectionKey(project));
          })
          if (!this.isWorkspaceCollapsed(this.sectionKey(project))) {
            this.projectPreview(project)
          }
        }
        .width('100%')
        .margin({ bottom: 8 })
      }, (project: RecentWorkspaceEntry): string => this.sectionKey(project))
      if (this.visibleProjectCount < this.projectEntries().length) {
        Text(RemoteI18n.f('remote.projects.showMore', String(this.nextProjectEntryBatchSize())))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(MUTED)
          .height(40)
          .width('100%')
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.visibleProjectCount += 3;
          })
      }
    }
    .width('100%')
    .margin({ top: 12 })
  }

  @Builder
  private ProjectCreateMenu(project: RecentWorkspaceEntry) {
    if (this.supportsHarnessProfiles) {
      HarnessProfileMenu({
        includeCowork: true,
        onSelect: (agentType: string) => {
          this.createMenuKey = '';
          this.onCreateInWorkspace(project.path, agentType, project.remoteConnectionId, project.remoteSshHost, project.workspaceId);
        }
      })
    } else {
      Column({ space: 2 }) {
        this.ProjectCreateMenuItem('Code', 'code', project)
        this.ProjectCreateMenuItem('Cowork', 'Cowork', project)
      }
      .width(150)
      .padding({ top: 8, bottom: 8 })
      .backgroundColor(CARD)
      .borderRadius(14)
      .border({ width: 0.5, color: LINE })
      .shadow({ radius: 20, color: SHADOW_SUBTLE, offsetY: 8 })
    }
  }

  @Builder
  private ProjectCreateMenuItem(label: string, agentType: string, project: RecentWorkspaceEntry) {
    Row() {
      Text(label)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
        .fontWeight(FontWeight.Medium)
    }
    .width('100%')
    .height(42)
    .padding({ left: 18, right: 18 })
    .onClick(() => {
      this.createMenuKey = '';
      this.onCreateInWorkspace(project.path, agentType, project.remoteConnectionId, project.remoteSshHost, project.workspaceId);
    })
  }

  @Builder
  private ChatSection() {
    Column() {
      Row() {
        Row({ space: 8 }) {
          Text(RemoteI18n.t('remote.chats'))
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(MUTED)
          Stack({ alignContent: Alignment.Center }) {
            SymbolGlyph(this.chatsCollapsed ?
              $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_down'))
              .fontSize(14)
              .fontColor([MUTED])
          }
          .width(18)
          .height(18)
        }
        .onClick(() => {
          this.chatsCollapsed = !this.chatsCollapsed;
        })
        Blank()
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.square_and_pencil'))
            .fontSize(18)
            .fontColor([MUTED])
            .opacity(0.52)
        }
        .width(40)
        .height(40)
        .accessibilityText(RemoteI18n.t('remote.newChat'))
        .onClick(() => {
          this.onCreateAssistantSession();
        })
      }
      .width('100%')
      .height(44)
      .alignItems(VerticalAlign.Center)
      if (this.visibleChatSessions().length === 0) {
        this.EmptySessions()
      } else if (!this.chatsCollapsed) {
        ForEach(this.visibleChatSessions().slice(0, this.chatVisibleCount), (item: RemoteSession) => {
          this.SessionRow(item)
        })
        if (this.chatVisibleCount < this.visibleChatSessions().length) {
          Text(RemoteI18n.f('remote.sessions.showMore', String(this.nextChatBatchSize())))
            .fontSize(MobileDesignTypography.bodySmall.size)
            .fontColor(MUTED)
            .height(40)
            .width('100%')
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.chatVisibleCount += 3;
            })
        }
      }
    }
    .width('100%')
    .margin({ top: 8, bottom: 16 })
  }

  @Builder
  private projectPreview(project: RecentWorkspaceEntry) {
    ForEach(this.visibleProjectSessions(project), (item: RemoteSession) => {
      this.SessionRow(item, true)
    })
    if (this.projectVisibleCount(project) < this.projectSessions(project).length) {
      Text(RemoteI18n.f('remote.sessions.showMore', String(this.nextProjectBatchSize(project))))
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(MUTED)
        .height(44)
        .width('100%')
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.projectVisibleSteps = this.projectVisibleSteps.concat([this.sectionKey(project)]);
        })
    }
  }

  /**
   * The grouped session list, computed at most once per change to its inputs.
   *
   * Every derived accessor below reads through here rather than deriving
   * anything itself, so calling them repeatedly across the builder tree — which
   * is what the tree does — costs a map lookup instead of a full scan.
   */
  private view(): SessionListProjection {
    const inputs: SessionListInputs = {
      sessions: this.sessions,
      query: this.query,
      sortMode: this.sortMode,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      workspaceId: this.workspaceId,
      workspaceConnectionId: this.workspaceConnectionId,
      workspaceSshHost: this.workspaceSshHost,
      workspaceKind: this.workspaceKind,
      recentWorkspaces: this.recentWorkspaces,
      workspaceFilter: this.workspaceFilter,
      agentFilter: this.agentFilter,
      statusFilter: this.statusFilter,
      showWorkspaceMetadata: this.showWorkspaceMetadata,
      showUpdatedMetadata: this.showUpdatedMetadata,
      showStatusMetadata: this.showStatusMetadata
    };
    return this.projectionCache.get(inputs);
  }

  private projectEntries(): RecentWorkspaceEntry[] {
    return this.view().projects;
  }

  private visibleProjectEntries(): RecentWorkspaceEntry[] {
    return this.projectEntries().slice(0, this.visibleProjectCount);
  }

  private nextProjectEntryBatchSize(): number {
    return Math.min(3, this.projectEntries().length - this.visibleProjectCount);
  }

  private basename(path: string): string {
    const parts = path.split('/');
    return parts.length > 0 ? parts[parts.length - 1] : path;
  }

  private visibleChatSessions(): RemoteSession[] {
    return this.view().chats;
  }

  private sessionsByTime(): RemoteSession[] {
    return this.view().byTime;
  }

  private sessionsForTimeBucket(bucket: string): RemoteSession[] {
    const projection = this.view();
    if (bucket === 'today') {
      return projection.today;
    }
    return bucket === 'yesterday' ? projection.yesterday : projection.earlier;
  }

  private sectionKey(project: RecentWorkspaceEntry): string {
    return SessionListProjector.sectionKeyFor(project);
  }

  private projectSessions(project: RecentWorkspaceEntry): RemoteSession[] {
    return SessionListProjector.sessionsForProject(this.view(), project);
  }

  private filteredSessions(): RemoteSession[] {
    return this.view().filtered;
  }

  private hasActiveListFilter(): boolean {
    return this.view().hasActiveFilter;
  }

  private visibleProjectSessions(project: RecentWorkspaceEntry): RemoteSession[] {
    return this.projectSessions(project).slice(0, this.projectVisibleCount(project));
  }

  private projectVisibleCount(project: RecentWorkspaceEntry): number {
    const key = this.sectionKey(project);
    const additionalSteps = this.projectVisibleSteps.filter((item: string) => item === key).length;
    return 3 + additionalSteps * 3;
  }

  private nextProjectBatchSize(project: RecentWorkspaceEntry): number {
    return Math.min(3, this.projectSessions(project).length - this.projectVisibleCount(project));
  }

  private nextChatBatchSize(): number {
    return Math.min(3, this.visibleChatSessions().length - this.chatVisibleCount);
  }

  private isWorkspaceCollapsed(key: string): boolean {
    return this.collapsedWorkspaceKeys.indexOf(key) >= 0;
  }

  private toggleWorkspace(key: string): void {
    if (this.isWorkspaceCollapsed(key)) {
      this.collapsedWorkspaceKeys = this.collapsedWorkspaceKeys.filter((item: string) => item !== key);
    } else {
      this.collapsedWorkspaceKeys = this.collapsedWorkspaceKeys.concat([key]);
    }
  }

  @Builder
  private SessionRow(item: RemoteSession, nested: boolean = false) {
    RemoteSessionRow({
      session: item,
      metadata: this.metadataText(item),
      nested,
      selected: this.isSessionSelected(item.id),
      busy: this.isBusy,
      actionPresentation: this.actionPresentation,
      showActionPopover: this.activeActionSessionId === item.id,
      actionsPopup: () => { this.SessionActionPopover() },
      onPressStateChange: (pressed: boolean) => {
        this.optimisticSelectedSessionId = pressed ? item.id : '';
      },
      onOpen: (session: RemoteSession) => {
        this.optimisticSelectedSessionId = session.id;
        this.onOpenSession(session);
      },
      onOpenActions: (session: RemoteSession) => this.openSessionActions(session),
      onCloseActions: () => this.closeSessionActions()
    })
  }

  private isSessionSelected(sessionId: string): boolean {
    const selectedSessionId = this.optimisticSelectedSessionId.length > 0 ?
      this.optimisticSelectedSessionId : this.selectedSessionId;
    return selectedSessionId === sessionId;
  }

  @Builder
  private SessionActionSheet() {
    this.SessionActionContent(SessionActionPresentation.BottomSheet)
  }

  @Builder
  private SessionActionPopover() {
    this.SessionActionContent(SessionActionPresentation.Popover)
  }

  @Builder
  private SessionActionContent(presentation: SessionActionPresentation) {
    SessionActionSurface({
      presentation,
      sessionTitle: this.actionSessionTitle(),
      canViewDetails: this.actionCapabilities().canViewDetails,
      canDelete: this.actionCapabilities().canDelete,
      onViewDetails: () => this.openActionSessionDetails(),
      onDelete: () => this.deleteActionSession(),
      onClose: () => this.closeSessionActions()
    })
  }

  @Builder
  private SessionDetailsSheet() {
    SessionDetailsView({
      session: this.detailsSession(),
      onClose: () => this.closeSessionDetails()
    })
  }

  @Builder
  private EmptySessions() {
    Column({ space: 8 }) {
      Text(this.isBusy ? RemoteI18n.t('home.emptyLoadingTitle') : RemoteI18n.t('remote.emptyTitle'))
        .fontSize(MobileDesignTypography.titleMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text(this.isBusy ? RemoteI18n.t('home.emptyLoadingText') : RemoteI18n.t('remote.emptyText'))
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 36, right: 36, bottom: 80 })
  }

  @Builder
  private FilteredEmptySessions() {
    Column({ space: 8 }) {
      Text(this.isBusy ? RemoteI18n.t('home.emptyLoadingTitle') : RemoteI18n.t('remote.emptyTitle'))
        .fontSize(MobileDesignTypography.titleMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text(this.isBusy ? RemoteI18n.t('home.emptyLoadingText') : RemoteI18n.t('remote.emptyText'))
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ left: 24, right: 24, top: 24, bottom: 16 })
  }

  private openSessionActions(item: RemoteSession): void {
    if (this.isBusy || item.id.length === 0) {
      return;
    }
    this.activeActionSessionId = item.id;
    if (this.actionPresentation === SessionActionPresentation.BottomSheet) {
      this.showSessionActionSheet = true;
    }
  }

  private closeSessionActions(): void {
    this.showSessionActionSheet = false;
    this.activeActionSessionId = '';
  }

  private actionSession(): RemoteSession | undefined {
    return this.sessions.find((item: RemoteSession) => item.id === this.activeActionSessionId);
  }

  private actionSessionTitle(): string {
    const session = this.actionSession();
    return session ? session.title : '';
  }

  private metadataText(item: RemoteSession): string {
    return SessionListProjector.metadataFor(this.view(), item.id);
  }

  private actionCapabilities(): SessionActionCapabilities {
    const session = this.actionSession();
    return SessionActionPolicy.resolve(
      SessionActionScope.Remote,
      session ? session.agentType : '',
      this.isBusy || session === undefined
    );
  }

  private deleteActionSession(): void {
    const session = this.actionSession();
    if (session) {
      this.onDeleteSession(session);
    }
  }

  private openActionSessionDetails(): void {
    const session = this.actionSession();
    if (session) {
      this.detailsSessionId = session.id;
      this.showSessionDetails = true;
    }
  }

  private closeSessionDetails(): void {
    this.showSessionDetails = false;
    this.detailsSessionId = '';
  }

  private detailsSession(): RemoteSession {
    const session = this.sessions.find((item: RemoteSession) => item.id === this.detailsSessionId);
    return session || {
      id: '', title: '', agentType: '', status: '', updatedAt: '', createdAt: '', messageCount: 0
    };
  }

  private sessionActionSheetOptions(): SheetOptions {
    return {
      height: 300,
      backgroundColor: TRANSPARENT,
      maskColor: SCRIM,
      showClose: false,
      dragBar: false
    };
  }

  private sessionDetailsSheetOptions(): SheetOptions {
    return AdaptiveSheetOptions.fromPlacement(this.sessionDetailsPlacement);
  }
}
