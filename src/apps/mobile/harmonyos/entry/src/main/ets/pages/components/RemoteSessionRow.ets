import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteSession } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { SessionActionPresentation } from './SessionActionSurface';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';
import {
  INK,
  MUTED,
  SOFT,
  TRANSPARENT,
} from './Theme';

@ComponentV2
export struct RemoteSessionRow {
  @Param session: RemoteSession = {
    id: '',
    title: '',
    workspacePath: '',
    agentType: 'code',
    status: '',
    updatedAt: '',
    createdAt: '',
    messageCount: 0
  };
  @Param metadata: string = '';
  @Param nested: boolean = false;
  @Param selected: boolean = false;
  @Param busy: boolean = false;
  @Param actionPresentation: SessionActionPresentation = SessionActionPresentation.BottomSheet;
  @Param showActionPopover: boolean = false;
  @Event onOpen: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onPressStateChange: (pressed: boolean) => void = (_pressed: boolean) => {};
  @Event onOpenActions: (session: RemoteSession) => void = (_session: RemoteSession) => {};
  @Event onCloseActions: () => void = () => {};
  @BuilderParam actionsPopup: () => void = this.EmptyPopup;

  build() {
    Row({ space: 8 }) {
      Column({ space: 2 }) {
        Text(this.session.title || RemoteI18n.t('sidebar.untitled'))
          .width('100%')
          .fontSize(MobileDesignTypography.titleSmall.size)
          .fontWeight(this.selected ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.metadata.length > 0) {
          Text(this.metadata)
            .width('100%')
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(MUTED)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      this.MoreButton()
    }
    .width('100%')
    .height(this.metadata.length > 0 ? 56 : 46)
    .padding({ left: this.nested ? 0 : 10, right: 4 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.selected ? SOFT : TRANSPARENT)
    .borderRadius(10)
    .onTouch((event: TouchEvent) => {
      if (this.busy) return;
      if (event.type === TouchType.Down) this.onPressStateChange(true);
      if (event.type === TouchType.Cancel) this.onPressStateChange(false);
    })
    .onClick(() => {
      if (!this.busy) this.onOpen(this.session);
    })
    .gesture(LongPressGesture({ repeat: false }).onAction(() => this.onOpenActions(this.session)))
    .bindPopup(this.actionPresentation === SessionActionPresentation.Popover && this.showActionPopover,
      ImmersiveSurfaceSupport.popupOptions(ImmersiveSurfaceScene.FLOATING_MENU, {
        builder: () => { this.actionsPopup() },
        placement: Placement.Right,
        popupColor: TRANSPARENT,
        enableArrow: false,
        autoCancel: true,
        mask: false,
        targetSpace: 6,
        onStateChange: (event) => {
          if (!event.isVisible) this.onCloseActions();
        }
      }))
  }

  @Builder
  private MoreButton() {
    Stack({ alignContent: Alignment.Center }) {
      Row({ space: 3 }) {
        Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
        Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
        Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
      }
      .height(8)
      .alignItems(VerticalAlign.Center)
    }
    .width(34)
    .height(40)
    .opacity(0.62)
    .accessibilityText(RemoteI18n.t('session.actions'))
    .onClick(() => this.onOpenActions(this.session))
  }

  @Builder
  private EmptyPopup() {}
}
