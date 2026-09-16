import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { RemoteCompactHomePolicy } from '../policy/RemoteCompactHomePolicy';
import { RemoteSession } from '../../model/RemoteModels';
import { INK, MUTED, SOFT, LINE, TRANSPARENT } from './Theme';

/** Current-device landing page. Session activation stays with the remote owner. */
@ComponentV2
export struct RecentRemoteHome {
  @Param connected: boolean = false;
  @Param busy: boolean = false;
  @Param sessions: RemoteSession[] = [];
  @Param desktopName: string = '';
  @Event onOpen: (session: RemoteSession) => void = () => {};
  @Event onBrowse: () => void = () => {};
  @Event onConnect: () => void = () => {};

  private sessionContext(session: RemoteSession): string {
    const workspace = session.workspaceName || (session.workspacePath || '').replace(/\/+$/, '').split('/').pop() || '';
    return [this.desktopName, workspace].filter((value: string): boolean => value.length > 0).join(' · ');
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          WelcomeBrandFlow({ markSize: MobileDesignGeometry.recentHomeMarkSize, sweep: true })
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
          ForEach(this.sessions, (session: RemoteSession) => {
            Column({ space: 6 }) {
              Text(session.title).fontSize(MobileDesignTypography.titleSmall.size).fontColor(INK).maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
              Text(this.sessionContext(session)).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
            }.width('100%').alignItems(HorizontalAlign.Start)
              .padding({ top: MobileDesignGeometry.recentHomeRowPadding, bottom: MobileDesignGeometry.recentHomeRowPadding })
              .onClick(() => { if (this.connected && !this.busy) this.onOpen(session); })
              .accessibilityGroup(true).accessibilityText(session.title)
            Divider().color(LINE)
          }, (session: RemoteSession): string => session.id)
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
