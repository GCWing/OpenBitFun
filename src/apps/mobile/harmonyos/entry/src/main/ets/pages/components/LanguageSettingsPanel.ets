import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { AppLocale } from '../../i18n/AppLocale';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ModelServiceSettingsPolicy } from '../policy/ModelServiceSettingsPolicy';
import { INK } from './Theme';
import { SheetCloseHeader } from './SheetCloseHeader';

@ComponentV2
export struct LanguageSettingsPanel {
  @Param selectedLanguage: string = AppLocale.DEFAULT;
  @Event onClose: () => void = () => {};
  @Event onSelect: (language: string) => Promise<void> = async (_language: string) => {};
  @Local pendingLanguage: string = '';

  aboutToAppear(): void {
    this.pendingLanguage = '';
  }

  build() {
    Column({ space: 0 }) {
      this.Header()
      this.LanguageList()
    }
    .width('100%')
    .height('100%')
    // No fill and no top radius: this page is the Settings sheet's content while
    // the language step is open, so the sheet the platform presents carries both.
    // The header below stays, and it is not sheet chrome: it is this page's own
    // back to the settings home.
  }

  @Builder
  Header() {
    SheetCloseHeader({
      title: RemoteI18n.t('settings.language.choose'),
      showDivider: true,
      isEnabled: this.pendingLanguage.length === 0,
      onClose: (): void => {
        if (this.pendingLanguage.length === 0) {
          this.onClose();
        }
      }
    })
  }

  @Builder
  LanguageList() {
    Column() {
      ForEach(AppLocale.supported(), (language: string) => {
        this.LanguageRow(language)
      }, (language: string) => `${language}:${RemoteI18n.revision()}`)
    }
    .width('100%')
    .padding({
      top: ModelServiceSettingsPolicy.LANGUAGE_LIST_TOP_PADDING,
      bottom: ModelServiceSettingsPolicy.LANGUAGE_LIST_BOTTOM_PADDING
    })
  }

  @Builder
  LanguageRow(language: string) {
    Row() {
      Text(RemoteI18n.translate(language, AppLocale.nativeNameKey(language)))
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .layoutWeight(1)
      if (language === this.selectedLanguage) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(18)
          .fontColor([INK])
      }
    }
    .width('100%')
    .height(ModelServiceSettingsPolicy.LANGUAGE_ROW_HEIGHT)
    .padding({ left: 16, right: 16 })
    .alignItems(VerticalAlign.Center)
    .opacity(this.pendingLanguage.length > 0 && this.pendingLanguage !== language ? 0.45 : 1)
    .onClick(() => {
      void this.select(language);
    })
  }

  private async select(language: string): Promise<void> {
    if (language === this.selectedLanguage || this.pendingLanguage.length > 0) {
      return;
    }
    this.pendingLanguage = language;
    try {
      await this.onSelect(language);
      this.onClose();
    } finally {
      this.pendingLanguage = '';
    }
  }
}
