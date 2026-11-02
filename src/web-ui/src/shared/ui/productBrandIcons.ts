interface ProductBrandIconSource {
  src: string;
  monochrome?: boolean;
  darkSrc?: string;
}

const zcodeIcon: ProductBrandIconSource = {
  src: '/assets/ecosystem-compatibility/zcode-icon.svg',
  monochrome: true,
};

/** One offline asset catalog for product identities across the Web UI. */
const PRODUCT_BRAND_ICONS: Record<string, ProductBrandIconSource> = {
  'claude-code': { src: '/assets/ecosystem-compatibility/claude-code.svg' },
  codex: { src: '/assets/ecosystem-compatibility/codex-icon.svg', monochrome: true },
  antigravity: { src: '/assets/ecosystem-compatibility/antigravity.png' },
  opencode: {
    src: '/assets/ecosystem-compatibility/opencode-icon-light.png',
    darkSrc: '/assets/ecosystem-compatibility/opencode-icon-dark.png',
  },
  grok: { src: '/assets/ecosystem-compatibility/grok-icon.svg', monochrome: true },
  hermes: { src: '/assets/ecosystem-compatibility/hermes.png', monochrome: true },
  zcode: zcodeIcon,
  zcode_cn: zcodeIcon,
  pi: { src: '/assets/ecosystem-compatibility/pi.svg' },
  dsh: { src: '/assets/ecosystem-compatibility/deepseek-harness.svg' },
  cursor: { src: '/assets/ecosystem-compatibility/cursor.svg', monochrome: true },
};

export function getProductBrandIcon(productId: string): Readonly<ProductBrandIconSource> | undefined {
  return Object.prototype.hasOwnProperty.call(PRODUCT_BRAND_ICONS, productId)
    ? PRODUCT_BRAND_ICONS[productId] : undefined;
}
