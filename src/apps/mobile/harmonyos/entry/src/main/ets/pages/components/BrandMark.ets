import { TemplateIcon } from './TemplateIcon';

/** The same contour mark used by the desktop splash, tinted for both themes. */
@ComponentV2
export struct BrandMark {
  @Param markSize: number = 96;

  build() {
    TemplateIcon({ src: $r('app.media.openbitfun_brand_mark'), iconWidth: this.markSize, iconHeight: this.markSize })
      .accessibilityLevel('no')
  }
}
