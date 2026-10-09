import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteSession } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { TimeFormat } from '../../services/TimeFormat';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { CARD, INK, LINE, MUTED, PAGE_BG, SOFT } from './Theme';

@ComponentV2
export struct SessionDetailsView {
  @Param session: RemoteSession = {
    id: '',
    title: '',
    agentType: '',
    status: '',
    updatedAt: '',
    createdAt: '',
    messageCount: 0
  };
  @Event onClose: () => void = () => {};
  // The sheet is a bottom sheet under the immersive shell, so the scrolling
  // column reads the strip itself and ends in a tail that rests the last row
  // above the navigation bar.
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
      Row({ space: 12 }) {
        Column({ space: 3 }) {
          Text(RemoteI18n.t('session.details'))
            .width('100%')
            .fontSize(MobileDesignTypography.bodySmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(MUTED)
          Text(this.session.title || RemoteI18n.t('sidebar.untitled'))
            .width('100%')
            .fontSize(MobileDesignTypography.headlineSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(17)
            .fontColor([MUTED])
        }
        .width(44)
        .height(44)
        .backgroundColor(SOFT)
        .borderRadius(22)
        .accessibilityText(RemoteI18n.t('common.close'))
        .onClick(() => this.onClose())
      }
      .width('100%')
      .padding({ left: 20, right: 16, top: 18, bottom: 16 })

      Divider().color(LINE)

      Scroll() {
        Column() {
          this.DetailRow(RemoteI18n.t('session.agentType'), this.agentTypeLabel())
          if ((this.session.workspaceName || '').length > 0) {
            this.DetailRow(RemoteI18n.t('session.workspace'), this.session.workspaceName || '')
          }
          if ((this.session.workspacePath || '').length > 0) {
            this.PathRow(RemoteI18n.t('session.workspacePath'), this.session.workspacePath || '')
          }
          if (this.validTime(this.session.createdAt)) {
            this.DetailRow(RemoteI18n.t('session.createdAt'), TimeFormat.relative(this.session.createdAt))
          }
          if (this.validTime(this.session.updatedAt)) {
            this.DetailRow(RemoteI18n.t('session.updatedAt'), TimeFormat.relative(this.session.updatedAt))
          }
          this.DetailRow(RemoteI18n.t('session.messageCount'), `${Math.max(0, this.session.messageCount)}`)
          if (this.session.status.length > 0) {
            this.DetailRow(RemoteI18n.t('session.status'), this.statusLabel())
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 8, bottom: this.insets.tailSpacing(24) })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .borderRadius(16)
  }

  @Builder
  private DetailRow(label: string, value: string) {
    Row({ space: 16 }) {
      Text(label)
        .width(104)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
      Text(value)
        .layoutWeight(1)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
        .textAlign(TextAlign.End)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .constraintSize({ minHeight: 52 })
    .padding({ top: 8, bottom: 8 })
    .border({ width: { bottom: 1 }, color: LINE })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private PathRow(label: string, value: string) {
    Column({ space: 8 }) {
      Text(label)
        .width('100%')
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
      Text(value)
        .width('100%')
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(INK)
        .padding({ left: 10, right: 10, top: 8, bottom: 8 })
        .backgroundColor(CARD)
        .border({ width: 1, color: LINE })
        .borderRadius(6)
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 })
    .border({ width: { bottom: 1 }, color: LINE })
    .alignItems(HorizontalAlign.Start)
  }

  private validTime(value: string): boolean {
    return !Number.isNaN(TimeFormat.timestampMs(value));
  }

  private agentTypeLabel(): string {
    return this.session.agentType.length > 0 ? this.session.agentType : RemoteI18n.t('common.unknown');
  }

  private statusLabel(): string {
    if (this.session.status === 'archived') {
      return RemoteI18n.t('sidebar.archived');
    }
    if (this.session.status === 'active') {
      return RemoteI18n.t('chat.executing');
    }
    return this.session.status;
  }
}
