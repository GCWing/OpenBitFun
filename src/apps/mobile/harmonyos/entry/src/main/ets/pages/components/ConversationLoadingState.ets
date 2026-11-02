import { LINE, SOFT } from './Theme';

@ComponentV2
export struct ConversationLoadingState {
  @Param maxContentWidth: number = 0;
  @Param topInset: number = 0;

  build() {
    Row() {
      Column({ space: 18 }) {
        this.AssistantSkeleton(78, '72%')
        this.UserSkeleton(42, '46%')
        this.AssistantSkeleton(112, '84%')
      }
      .width('100%')
      .constraintSize({ maxWidth: this.maxContentWidth > 0 ? this.maxContentWidth : '100%' })
      .padding({ left: 22, right: 22, top: this.topInset + 28, bottom: 28 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  private AssistantSkeleton(height: number, width: string) {
    Row() {
      Column({ space: 9 }) {
        Text('').width('74%').height(10).backgroundColor(LINE).borderRadius(5)
        Text('').width('92%').height(10).backgroundColor(LINE).borderRadius(5)
        Text('').width('58%').height(10).backgroundColor(LINE).borderRadius(5)
      }
      .width(width)
      .height(height)
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Start)
      .backgroundColor(SOFT)
      .borderRadius(10)
      Blank().layoutWeight(1)
    }
    .width('100%')
    .height(height)
  }

  @Builder
  private UserSkeleton(height: number, width: string) {
    Row() {
      Blank().layoutWeight(1)
      Text('')
        .width(width)
        .height(height)
        .backgroundColor(SOFT)
        .borderRadius(10)
    }
    .width('100%')
    .height(height)
  }
}
