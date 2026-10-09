import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { MiniAppActions, MiniAppSummary, emptyMiniAppActions } from '../../model/MiniAppModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MiniAppState } from '../state/MiniAppState';
import { MiniAppWebView } from './MiniAppWebView';
import { NavigationBackButton } from './NavigationBackButton';
import { PAGE_BG, INK, MUTED, SOFT, LINE, TRANSPARENT } from './Theme';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

@ComponentV2
export struct MiniAppSurface {
  @Param state: MiniAppState = new MiniAppState();
  @Param actions: MiniAppActions = emptyMiniAppActions();
  @Local galleryWidth: number = 0;
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

  build() {
    Column() {
      // The gallery is a full-screen surface, so its header band owns the top
      // edge of the window: the box grows by the status bar strip and the
      // controls keep the 56 the design gives them below it, instead of sitting
      // under the clock and the indicators. The band spans the window
      // horizontally, so it reserves the side strips too — a rotated device puts
      // the camera cutout on the back control's edge.
      Row({ space: 8 }) {
        NavigationBackButton({ onBack: (): void => {
          if (this.state.appId) this.actions.back();
          else this.actions.close();
        } })
        Text(this.state.appId ? this.state.name : RemoteI18n.t('miniapp.title'))
          .fontSize(MobileDesignTypography.bodyLarge.size).fontWeight(FontWeight.Medium)
          .fontColor(INK).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Center).layoutWeight(1)
        Blank().width(48)
      }.width('100%').height(56 + this.insets.top)
        .padding({ left: this.insets.leftPadding(12), right: this.insets.rightPadding(12), top: this.insets.top })
      if (this.state.document) {
        MiniAppWebView({ document: this.state.document, revision: this.state.revision, request: this.actions.request })
          .layoutWeight(1)
      } else {
        Column() {
          Row() {
            Text(RemoteI18n.t('miniapp.allApps'))
              .fontSize(MobileDesignTypography.titleSmall.size).fontWeight(FontWeight.Medium).fontColor(INK)
              .padding({ left: 16, right: 16, top: 10, bottom: 10 }).backgroundColor(SOFT).borderRadius(24)
            Blank()
            Text(RemoteI18n.t('miniapp.availableOffline'))
              .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
          }.width('100%').padding({ top: 16, bottom: 20 })
          if (this.state.loading) {
            LoadingProgress().width(32).height(32).margin(24)
          } else if (this.state.error) {
            Text(this.state.error).fontSize(MobileDesignTypography.bodyMedium.size)
              .fontColor(MUTED).padding({ top: 16, bottom: 16 }).copyOption(CopyOptions.InApp)
            Button(RemoteI18n.t('miniapp.refresh'))
              .fontColor(INK).backgroundColor(SOFT).onClick(() => this.actions.refresh())
          } else if (this.state.apps.length === 0) {
            Text(RemoteI18n.t('miniapp.empty')).fontSize(MobileDesignTypography.bodyMedium.size)
              .fontColor(MUTED).padding(24)
          } else {
            Grid() {
              ForEach(this.state.apps, (app: MiniAppSummary) => {
                GridItem() { this.PreviewTile(app) }
              }, (app: MiniAppSummary) => app.id)
              // The gallery's tail spacer: the strip plus the design's own
              // breathing, as one full-width, untouchable row. The grid's
              // viewport runs to the screen edge — tiles roll under the
              // navigation indicator while they are moving — and the last row
              // of tiles still rests above the bar.
              GridItem() {
                Column()
                  .width('100%')
                  .height(this.insets.tailSpacing(24))
              }
              .columnStart(0)
              .columnEnd(this.galleryColumns() - 1)
              .hitTestBehavior(HitTestMode.None)
            }.columnsTemplate(this.galleryColumnsTemplate())
              .columnsGap(14).rowsGap(20).layoutWeight(1).width('100%').scrollBar(BarState.Off)
          }
        }.width('100%').constraintSize({ maxWidth: 1000 }).layoutWeight(1)
          // The gallery is the surface's bottom edge: its scrolling viewport
          // runs to the screen edge, and the grid's own tail spacer is what
          // keeps the last row of tiles out of the navigation bar.
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 16, right: 16 })
          .onAreaChange((_oldArea: Area, area: Area) => { this.galleryWidth = Number(area.width); })
      }
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }

  @Builder
  private PreviewTile(app: MiniAppSummary) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 10 }) {
        Image(this.preview(app.id)).width('100%').aspectRatio(1).objectFit(ImageFit.Cover)
          .backgroundColor(SOFT).borderRadius(24).border({ width: 0.5, color: LINE })
          .draggable(false).accessibilityLevel('no')
        Text(app.name).fontSize(MobileDesignTypography.titleSmall.size)
          .fontWeight(FontWeight.Medium).fontColor(INK).maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%').padding({ left: 4, right: 4 })
      }.width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').padding(0).backgroundColor(TRANSPARENT).borderRadius(24)
      .stateEffect(true).accessibilityText(`${app.name}, ${app.description}`)
      .onClick(() => this.actions.select(app.id))
  }

  private preview(id: string): Resource {
    if (id === 'builtin-gomoku') return $r('app.media.miniapp_gomoku_preview');
    if (id === 'builtin-regex-playground') return $r('app.media.miniapp_regex_preview');
    return $r('app.media.miniapp_divination_preview');
  }

  /** Columns of the gallery grid: 3 once it is wide, 2 on a phone. */
  private galleryColumns(): number {
    return this.galleryWidth >= 600 ? 3 : 2;
  }

  private galleryColumnsTemplate(): string {
    return this.galleryColumns() === 3 ? '1fr 1fr 1fr' : '1fr 1fr';
  }
}
