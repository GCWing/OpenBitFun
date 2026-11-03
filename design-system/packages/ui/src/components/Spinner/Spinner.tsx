import { forwardRef, useEffect, useRef, type HTMLAttributes } from "react";
import { startBrandPlayback } from "../../brand/brandPlayback";
import { classNames } from "../../internal/classNames";
import { createSpinnerAnimations } from "./spinnerMotion";
import styles from "./Spinner.module.css";

export type SpinnerSize = "xs" | "sm" | "md" | "lg";
export type SpinnerVariant = "logo" | "bars" | "matrix";

export interface SpinnerProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  size?: SpinnerSize;
  /** `matrix` is a compatibility alias for the logo presentation. */
  variant?: SpinnerVariant;
  active?: boolean;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner({
  "aria-label": ariaLabel,
  className,
  size = "md",
  variant = "logo",
  active = true,
  ...props
}, ref) {
  const presentation = variant === "matrix" ? "logo" : variant;
  const glyphRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const glyph = glyphRef.current;
    if (!active || presentation !== "logo" || !glyph) return;
    return startBrandPlayback(glyph, () => createSpinnerAnimations(glyph));
  }, [active, presentation]);
  return (
    <span
      {...props}
      aria-hidden={ariaLabel ? undefined : "true"}
      aria-label={ariaLabel}
      className={classNames(styles.root, className)}
      data-openbitfun-component="spinner"
      data-size={size}
      data-variant={presentation}
      data-active={active}
      ref={ref}
      role={ariaLabel ? "status" : undefined}
    >
      {presentation === "logo" ? (
        <span aria-hidden="true" className={styles.glyph} ref={glyphRef}>
          <span className={styles.artwork} />
        </span>
      ) : Array.from({ length: 3 }, (_, index) => (
        <span aria-hidden="true" className={styles.cell} key={index} />
      ))}
    </span>
  );
});

export interface LoadingStateProps
  extends HTMLAttributes<HTMLDivElement> {
  size?: SpinnerSize;
}

export const LoadingState = forwardRef<HTMLDivElement, LoadingStateProps>(
  function LoadingState({ children, className, size = "md", ...props }, ref) {
    return (
      <div
        {...props}
        className={classNames(styles.loadingState, className)}
        data-openbitfun-component="loading-state"
        data-size={size}
        ref={ref}
      >
        <Spinner size={size} />
        {children ? <span className={styles.label} data-openbitfun-part="label">{children}</span> : null}
      </div>
    );
  },
);
