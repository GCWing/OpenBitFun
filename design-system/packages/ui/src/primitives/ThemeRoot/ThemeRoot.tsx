import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { retainScrollbarFocus } from "../../internal/scrollbarFocus";
import styles from "./ThemeRoot.module.css";

export type ColorScheme = "light" | "dark";
export type ContrastMode = "standard" | "high";
export type DensityMode = "compact" | "comfortable" | "touch";
export type TokenOverrideName = `--openbitfun-${string}`;
export type TokenOverrides = Partial<
  Record<TokenOverrideName, string | number>
>;

export interface ThemeRootProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  colorScheme?: ColorScheme;
  contrast?: ContrastMode;
  density?: DensityMode;
  tokenOverrides?: TokenOverrides;
}

export function ThemeRoot({
  children,
  className,
  colorScheme = "light",
  contrast = "standard",
  density = "comfortable",
  style,
  tokenOverrides,
  ...props
}: ThemeRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rootRef.current) return retainScrollbarFocus(rootRef.current.ownerDocument);
  }, []);
  const mergedStyle = {
    ...style,
    ...tokenOverrides,
  } as CSSProperties;

  return (
    <div
      {...props}
      ref={rootRef}
      className={classNames(styles.root, className)}
      data-openbitfun-design-system-root=""
      data-color-scheme={colorScheme}
      data-contrast={contrast}
      data-density={density}
      style={mergedStyle}
    >
      {children}
    </div>
  );
}
