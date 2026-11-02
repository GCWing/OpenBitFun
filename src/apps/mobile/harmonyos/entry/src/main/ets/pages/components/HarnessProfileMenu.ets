import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { HarnessProfilePolicy } from '../policy/HarnessProfilePolicy';
import { CARD, INK, LINE, MUTED, SHADOW_SUBTLE, TRANSPARENT } from './Theme';

/** Compact creation-time selector for the supported Harness profiles. */
@ComponentV2
export struct HarnessProfileMenu {
  @Param showTitle: boolean = true;
  @Param includeCowork: boolean = false;
  @Param menuWidth: number = 160;
  @Event onSelect: (agentType: string) => void = (_agentType: string) => {};

  build() {
    Column({ space: 2 }) {
      if (this.showTitle) {
        Text(RemoteI18n.t('remote.harness.title'))
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
          .width('100%')
          .height(30)
          .padding({ left: 14, right: 14 })
      }
      this.ProfileRow('minimal', RemoteI18n.t('remote.harness.minimal'))
      this.ProfileRow('standard', RemoteI18n.t('remote.harness.standard'))
      this.ProfileRow('ultimate', RemoteI18n.t('remote.harness.ultimate'))
      this.ProfileRow('creative', RemoteI18n.t('remote.harness.creative'))
      if (this.includeCowork) {
        Divider().strokeWidth(0.5).color(LINE).margin({ top: 4, bottom: 4 })
        this.AgentRow('Cowork', 'Cowork')
      }
    }
    .width(this.menuWidth)
    .padding({ top: 8, bottom: 8 })
    .backgroundColor(CARD)
    .borderRadius(16)
    .border({ width: 0.5, color: LINE })
    .shadow({ radius: 20, color: SHADOW_SUBTLE, offsetY: 8 })
  }

  @Builder
  private ProfileRow(profileId: string, label: string) {
    Row({ space: 12 }) {
      this.ProfileIcon(profileId)
      Text(label)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
    }
    .width('100%')
    .height(46)
    .padding({ left: 14, right: 14 })
    .borderRadius(10)
    .backgroundColor(TRANSPARENT)
    .onClick(() => {
      this.onSelect(HarnessProfilePolicy.agentType(profileId));
    })
  }

  @Builder
  private AgentRow(label: string, agentType: string) {
    Row({ space: 12 }) {
      SymbolGlyph($r('sys.symbol.person_2'))
        .fontSize(17)
        .fontColor([INK])
        .width(22)
        .height(22)
      Text(label)
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
    }
    .width('100%')
    .height(46)
    .padding({ left: 14, right: 14 })
    .borderRadius(10)
    .backgroundColor(TRANSPARENT)
    .onClick(() => this.onSelect(agentType))
  }

  @Builder
  private ProfileIcon(profileId: string) {
    if (profileId === 'minimal') {
      Image($r('app.media.harness_minimal')).width(22).height(22).objectFit(ImageFit.Contain).draggable(false)
    } else if (profileId === 'standard') {
      Image($r('app.media.harness_standard')).width(22).height(22).objectFit(ImageFit.Contain).draggable(false)
    } else if (profileId === 'ultimate') {
      Image($r('app.media.harness_ultimate')).width(22).height(22).objectFit(ImageFit.Contain).draggable(false)
    } else {
      Image($r('app.media.harness_creative')).width(22).height(22).objectFit(ImageFit.Contain).draggable(false)
    }
  }
}
