import { ColdStartPresentationState } from '../state/ColdStartPresentationState';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { RemoteCompactHomePolicy } from '../policy/RemoteCompactHomePolicy';
import { RemoteSession } from '../../model/RemoteModels';
import { INK, MUTED, SOFT, LINE, TRANSPARENT } from './Theme';

/** Current-device landing page. Session activation stays with the remote owner. */
@ComponentV2
export struct RecentRemoteHome {
  @Consumer() coldStartGeometry: ColdStartPresentationState = new ColdStartPresentationState();
  @Param connected: boolean = false;
  @Param busy: boolean = false;
  @Param sessions: RemoteSession[] = [];
  @Param desktopName: string = '';
  @Event onOpen: (session: RemoteSession) => void = () => {};
  @Event onBrowse: () => void = () => {};
  @Event onConnect: () => void = () => {};

  // Keyed rows keep their identity; resolve their content from the latest snapshot.
  @Computed
  get sessionIndex(): Map<string, RemoteSession> {
    const index = new Map<string, RemoteSession>();
    this.sessions.forEach((item: RemoteSession) => { index.set(`${item.deviceId || ''}:${item.id}`, item); });
    return index;
  }

  private currentSession(item: RemoteSession): RemoteSession {
    return this.sessionIndex.get(`${item.deviceId || ''}:${item.id}`) || item;
  }

  private sessionContext(session: RemoteSession): string {
    const workspace = session.workspaceName || (session.workspacePath || '').replace(/\/+$/, '').split('/').pop() || '';
    return [this.desktopName, workspace].filter((value: string): boolean => value.length > 0).join(' · ');
  }

  aboutToDisappear(): void { this.coldStartGeometry.targetSize = 0; }

  build() {
    Scroll() {
      Column() {
        Column() {
          WelcomeBrandFlow({ markSize: MobileDesignGeometry.recentHomeMarkSize, sweep: true })
            .onAreaChange((_old: Area, area: Area) => {
              this.coldStartGeometry.targetX = Number(area.globalPosition.x) + Number(area.width) / 2;
              this.coldStartGeometry.targetY = Number(area.globalPosition.y) + Number(area.height) / 2;
              this.coldStartGeometry.targetSize = Number(area.width);
            })
            .margin({ top: 20, bottom: 8 })
          Text(RemoteI18n.t('home.recent_title')).fontSize(MobileDesignTypography.headlineLarge.size)
            .fontWeight(FontWeight.Medium).fontColor(INK).textAlign(TextAlign.Center)
        }.width('100%').margin({ bottom: 32 })
        if (this.busy) {
          LoadingProgress().width(24).height(24).color(MUTED).margin({ bottom: 16 })
        }
        if (!RemoteCompactHomePolicy.shouldShowRecentSessions(this.connected, this.sessions.length)) {
          Text(RemoteI18n.t('home.recent_connect')).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED).margin({ bottom: 16 })
          Button(RemoteI18n.t('home.connectComputer')).onClick(this.onConnect)
            .backgroundColor(SOFT).fontColor(INK).height(48).width('100%').margin({ bottom: 16 })
        }
        if (RemoteCompactHomePolicy.shouldShowRecentSessions(this.connected, this.sessions.length)) {
          Row() {
            Text(RemoteI18n.t('home.recent_recent')).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED).layoutWeight(1)
            Button(RemoteI18n.t('home.recent_all')).fontSize(MobileDesignTypography.labelSmall.size).fontColor(INK)
              .backgroundColor(TRANSPARENT).height(44).onClick(this.onBrowse)
          }.width('100%')
          ForEach(this.sessions, (row: RemoteSession) => {
            Column({ space: 6 }) {
              Text(this.currentSession(row).title).fontSize(MobileDesignTypography.titleSmall.size).fontColor(INK).maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
              Text(this.sessionContext(this.currentSession(row))).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
            }.width('100%').alignItems(HorizontalAlign.Start)
              .padding({ top: MobileDesignGeometry.recentHomeRowPadding, bottom: MobileDesignGeometry.recentHomeRowPadding })
              .onClick(() => { if (this.connected) this.onOpen(this.currentSession(row)); })
              .accessibilityGroup(true).accessibilityText(this.currentSession(row).title)
            Divider().color(LINE)
          }, (session: RemoteSession): string => `${session.deviceId || ''}:${session.id}`)
          if (this.sessions.length === 0 && !this.busy) {
            Text(RemoteI18n.t('home.recent_empty')).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED)
              .padding({ top: 18, bottom: 18 })
          }
        }

      }.alignItems(HorizontalAlign.Start).width('100%')
        .constraintSize({ maxWidth: MobileDesignGeometry.recentHomeMaxWidth })
        .padding({ left: MobileDesignGeometry.recentHomeGutter, right: MobileDesignGeometry.recentHomeGutter, bottom: 28 })
    }.width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Off)
  }
}
