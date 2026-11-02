import { ColdStartPresentationState } from '../state/ColdStartPresentationState';
import { ColdStartHomeTransition } from '../components/ColdStartHomeTransition';
import { RecentRemoteHome } from '../components/RecentRemoteHome';
import { PAGE_BG, INK } from '../components/Theme';

/** Isolated native geometry fixture; never loads account or remote state. */
@ComponentV2
export struct ColdStartHomePreview {
  @Provider() coldStartGeometry: ColdStartPresentationState = new ColdStartPresentationState();
  @Local playing: boolean = false;
  @Local compact: boolean = false;

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('Replay').id('launch-replay').onClick(() => { this.playing = true; })
        Button('Resize').id('launch-resize').onClick(() => { this.compact = !this.compact; })
        Text(this.playing ? 'Playing' : 'Home').fontColor(INK)
      }.height(60)
      Stack() {
        RecentRemoteHome()
        if (this.playing) {
          ColdStartHomeTransition({ geometry: this.coldStartGeometry, onFinished: () => { this.playing = false; } })
        }
      }.width(this.compact ? 360 : '100%').layoutWeight(1)
        .onAreaChange((_old: Area, area: Area) => {
          this.coldStartGeometry.originX = Number(area.globalPosition.x);
          this.coldStartGeometry.originY = Number(area.globalPosition.y);
        })
    }.width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
