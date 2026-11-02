import type { ImgHTMLAttributes } from "react";
import { classNames } from "../internal/classNames";
import solidMark from "./assets/openbitfun-app-mark.png";
import appIcon16 from "./assets/openbitfun-app-icon-16.png";
import appIcon32 from "./assets/openbitfun-app-icon-32.png";
import appIcon128 from "./assets/openbitfun-app-icon-128.png";
import appIcon256 from "./assets/openbitfun-app-icon-256.png";
import appIcon512 from "./assets/openbitfun-app-icon-512.png";
import styles from "./brand.module.css";

export interface OpenBitFunArtworkProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes" | "width" | "height" | "alt" | "children"> {
  /** Omit when adjacent text already identifies OpenBitFun. */
  label?: string;
  /** Display size in CSS pixels; the original square proportions are preserved. */
  size?: number;
}

/** The original silver material on a transparent canvas, without an app tile. */
export function OpenBitFunSolidMark({ label, size, className, style, ...props }: OpenBitFunArtworkProps) {
  return <img {...props} src={solidMark} alt={label ?? ""} width={512} height={512}
    className={classNames(styles.artwork, className)} style={{ width: size, ...style }}
    data-openbitfun-component="openbitfun-solid-mark" data-openbitfun-part="root" />;
}

/** The same generated silver-on-black artwork used by installed applications. */
export function OpenBitFunAppIcon({ label, size, className, style, ...props }: OpenBitFunArtworkProps) {
  return <img {...props} src={appIcon256}
    srcSet={`${appIcon16} 16w, ${appIcon32} 32w, ${appIcon128} 128w, ${appIcon256} 256w, ${appIcon512} 512w`}
    sizes={size === undefined ? "64px" : `${size}px`} alt={label ?? ""} width={256} height={256}
    className={classNames(styles.artwork, className)} style={{ width: size, ...style }}
    data-openbitfun-component="openbitfun-app-icon" data-openbitfun-part="root" />;
}
