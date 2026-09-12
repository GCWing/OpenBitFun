import { CARD, STATUS_SUCCESS, INK, MUTED } from './Theme';
import { TemplateIcon } from './TemplateIcon';

@ComponentV2
export struct SidebarGlyph {
  @Param kind: string = '';
  @Param connectionState: string = '';
  @Param tint: ResourceColor = INK;

  build() {
    if (this.kind === 'session_more') {
      this.MoreDots()
    } else if (this.kind === 'remote') {
      this.Remote()
    } else if (this.kind === 'search') {
      this.Search()
    } else if (this.kind === 'notebook') {
      this.Notebook()
    } else if (this.kind === 'clock') {
      this.Clock()
    } else if (this.kind === 'apps') {
      this.Apps()
    } else if (this.kind === 'code_flower') {
      this.CodeFlower()
    } else if (this.kind === 'more') {
      this.More()
    } else if (this.kind === 'edit') {
      this.Edit()
    } else if (this.kind === 'settings') {
      this.Settings()
    }
  }

  @Builder
  private MoreDots() {
    Row({ space: 3 }) {
      Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
      Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
      Text('').width(3.5).height(3.5).backgroundColor(MUTED).borderRadius(2)
    }
    .height(8)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private Remote() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.connectionState === 'connected' || this.connectionState === 'reconnecting') {
        TemplateIcon({ src: $r('app.media.remote_ref_sidebar_connected'), iconWidth: 35, iconHeight: 34 })
        Text('').width(8).height(8).backgroundColor(STATUS_SUCCESS).borderRadius(4)
          .position({ x: 24, y: 22 })
      } else {
        TemplateIcon({ src: $r('app.media.remote_logo'), iconWidth: 34, iconHeight: 34, tint: MUTED })
      }
    }
    .width(35).height(34)
  }

  @Builder
  private Search() {
    SymbolGlyph($r('sys.symbol.magnifyingglass'))
      .fontSize(22).fontColor([INK]).width(24).height(24)
  }

  @Builder
  private Notebook() {
    Stack() {
      Text('').width(22).height(24).borderRadius(5).border({ width: 1.5, color: INK })
        .position({ x: 8, y: 5 })
      Text('').width(4).height(4).borderRadius(2).backgroundColor(INK)
        .position({ x: 5, y: 11 })
      Text('').width(4).height(4).borderRadius(2).backgroundColor(INK)
        .position({ x: 5, y: 20 })
    }
    .width(34).height(34)
  }

  @Builder
  private Clock() {
    Stack() {
      Text('').width(26).height(26).borderRadius(13).border({ width: 1.5, color: INK })
        .position({ x: 4, y: 4 })
      Text('').width(1.5).height(9).backgroundColor(INK).borderRadius(2)
        .position({ x: 18, y: 10 })
      Text('').width(9).height(1.5).backgroundColor(INK).borderRadius(2)
        .position({ x: 18, y: 20 })
    }
    .width(34).height(34)
  }

  @Builder
  private Apps() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.square_grid_2x2'))
        .fontSize(24)
        .fontColor([this.tint])
    }
    .width(24).height(24)
  }

  @Builder
  private CodeFlower() {
    Stack() {
      Text('').width(16).height(16).borderRadius(8).border({ width: 1.5, color: INK })
        .backgroundColor(CARD).position({ x: 9, y: 1 })
      Text('').width(16).height(16).borderRadius(8).border({ width: 1.5, color: INK })
        .backgroundColor(CARD).position({ x: 17, y: 9 })
      Text('').width(16).height(16).borderRadius(8).border({ width: 1.5, color: INK })
        .backgroundColor(CARD).position({ x: 9, y: 17 })
      Text('').width(16).height(16).borderRadius(8).border({ width: 1.5, color: INK })
        .backgroundColor(CARD).position({ x: 1, y: 9 })
      Text('').width(14).height(14).borderRadius(7).backgroundColor(CARD)
        .position({ x: 10, y: 10 })
    }
    .width(34).height(34)
  }

  @Builder
  private More() {
    Row({ space: 5 }) { this.Dot(); this.Dot(); this.Dot(); }
      .width(30).height(22)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
  }

  @Builder
  private Dot() {
    Text('').width(5).height(5).borderRadius(3).backgroundColor(INK)
  }

  @Builder
  private Edit() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.square_and_pencil'))
        .fontSize(20)
        .fontColor([this.tint])
    }
    .width(22)
    .height(22)
  }

  @Builder
  private Settings() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.gearshape'))
        .fontSize(24)
        .fontColor([this.tint])
    }
    .width(26)
    .height(26)
  }
}
