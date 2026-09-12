import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { MiniAppActions, MiniAppSummary, emptyMiniAppActions } from '../../model/MiniAppModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MiniAppState } from '../state/MiniAppState';
import { MiniAppWebView } from './MiniAppWebView';
import { NavigationBackButton } from './NavigationBackButton';
import { PAGE_BG, INK, MUTED, SOFT, LINE, TRANSPARENT } from './Theme';

@ComponentV2
export struct MiniAppSurface {
  @Param state: MiniAppState = new MiniAppState();
  @Param actions: MiniAppActions = emptyMiniAppActions();
  @Local galleryWidth: number = 0;

  build() {
    Column() {
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
      }.width('100%').height(56).padding({ left: 12, right: 12 })
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
            }.columnsTemplate(this.galleryWidth >= 600 ? '1fr 1fr 1fr' : '1fr 1fr')
              .columnsGap(14).rowsGap(20).layoutWeight(1).width('100%').scrollBar(BarState.Off)
          }
        }.width('100%').constraintSize({ maxWidth: 1000 }).layoutWeight(1)
          .alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, bottom: 24 })
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
}
