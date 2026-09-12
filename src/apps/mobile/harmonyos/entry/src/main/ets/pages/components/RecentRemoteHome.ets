import { RemoteSession } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { TimeFormat } from '../../services/TimeFormat';
import { MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { INK, MUTED, LINE, SOFT, TRANSPARENT } from './Theme';

/** Current-device landing page. Session activation stays with the remote owner. */
@ComponentV2
export struct RecentRemoteHome {
  @Param sessions: RemoteSession[] = [];
  @Param desktopName: string = '';
  @Param connected: boolean = false;
  @Param busy: boolean = false;
  @Event onBrowse: () => void = () => {};
  @Event onConnect: () => void = () => {};
  @Event onOpen: (session: RemoteSession) => void = () => {};

  private recent(): RemoteSession[] {
    return this.sessions.filter((s: RemoteSession) => s.status !== 'archived')
      .sort((a: RemoteSession, b: RemoteSession) => this.timestamp(b) - this.timestamp(a)).slice(0, 3);
  }
  private timestamp(session: RemoteSession): number {
    const updated = TimeFormat.timestampMs(session.updatedAt);
    const created = TimeFormat.timestampMs(session.createdAt);
    return Number.isFinite(updated) && updated > 0 ? updated : Number.isFinite(created) ? created : 0;
  }
  private context(session: RemoteSession): string {
    const workspace = session.workspaceName || (session.workspacePath || '').split('/').filter((p: string) => p.length > 0).pop() || '';
    return [this.desktopName, workspace].filter((s: string) => s.length > 0).join(' · ');
  }
  build() {
    Scroll() {
      Column() {
        Column() {
          WelcomeBrandFlow({ markSize: 156, sweep: true })
            .margin({ top: 20, bottom: 8 })
          Text(RemoteI18n.t('home.recent_title')).fontSize(21)
            .fontWeight(FontWeight.Medium).fontColor(INK).textAlign(TextAlign.Center)
        }.width('100%').margin({ bottom: 32 })
        if (this.busy) {
          LoadingProgress().width(24).height(24).color(MUTED).margin({ bottom: 16 })
        }
        if (!this.connected) {
          Text(RemoteI18n.t('home.recent_connect')).fontSize(13).fontColor(MUTED).margin({ bottom: 16 })
          Button(RemoteI18n.t('home.connectComputer')).onClick(this.onConnect)
            .backgroundColor(SOFT).fontColor(INK).height(48).width('100%').margin({ bottom: 16 })
        }
        Row() {
          Text(RemoteI18n.t('home.recent_recent')).fontSize(12).fontColor(MUTED).layoutWeight(1)
          Button(RemoteI18n.t('home.recent_all')).fontSize(12).fontColor(MUTED)
            .backgroundColor(TRANSPARENT).onClick(this.onBrowse)
        }.width('100%')
        ForEach(this.recent(), (session: RemoteSession) => {
          Button({ type: ButtonType.Normal }) {
            Row({ space: 12 }) {
              Column({ space: 6 }) {
                Text(session.title).fontSize(15).fontColor(INK).maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(this.context(session)).fontSize(11).fontColor(MUTED).maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }.alignItems(HorizontalAlign.Start).layoutWeight(1)
              SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14).fontColor([MUTED])
            }.width('100%').padding({ top: MobileDesignGeometry.recentHomeRowPadding, bottom: MobileDesignGeometry.recentHomeRowPadding })
          }.width('100%').backgroundColor(TRANSPARENT).borderRadius(0)
            .border({ width: { bottom: 1 }, color: LINE }).onClick(() => this.onOpen(session))
        }, (session: RemoteSession) => (session.deviceId || '') + ':' + session.id)
        if (this.recent().length === 0 && !this.busy) {
          Text(RemoteI18n.t('home.recent_empty')).fontSize(13).fontColor(MUTED).margin({ top: 18, bottom: 18 })
        }

      }.alignItems(HorizontalAlign.Start).width('100%')
        .constraintSize({ maxWidth: MobileDesignGeometry.recentHomeMaxWidth })
        .padding({ left: MobileDesignGeometry.recentHomeGutter, right: MobileDesignGeometry.recentHomeGutter, bottom: 28 })
    }.width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Off)
  }
}
