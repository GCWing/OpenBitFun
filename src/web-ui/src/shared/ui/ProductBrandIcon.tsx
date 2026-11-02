import { getProductBrandIcon } from './productBrandIcons';
import styles from './ProductBrandIcon.module.scss';

/** Shared decorative product identity; the surrounding control owns its label. */
export function ProductBrandIcon({ productId, size = 24 }: {
  productId: string;
  size?: number | string;
}) {
  const icon = getProductBrandIcon(productId);
  if (!icon) return null;
  return <span
    className={`${styles.icon}${icon.monochrome ? ` ${styles.monochrome}` : ''}`}
    aria-hidden="true" data-product-logo={productId}
    style={{ width: size, height: size, ...(icon.monochrome ? { maskImage: `url("${icon.src}")` } : {}) }}
    data-openbitfun-component="product-brand-icon" data-openbitfun-part="root">
    {!icon.monochrome && <>
      <img className={icon.darkSrc ? styles.light : undefined} src={icon.src} alt="" draggable={false} />
      {icon.darkSrc && <img className={styles.dark} src={icon.darkSrc} alt="" draggable={false} />}
    </>}
  </span>;
}
