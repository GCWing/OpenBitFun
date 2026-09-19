import {
  forwardRef,
  useCallback,
  useId,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { classNames } from "../../internal/classNames";
import { Portal, resolvePortalTarget } from "../../overlay/Portal";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import { useDismissibleLayer } from "../../overlay/useDismissibleLayer";
import { useFocusScope } from "../../overlay/useFocusScope";
import { usePresence } from "../../overlay/usePresence";
import type { OverlayDismissReason } from "../../overlay/types";
import styles from "./MobileSheet.module.css";

const EXIT_DURATION_MS = 180;

export type MobileSheetCloseReason = OverlayDismissReason;

export interface MobileSheetProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  autoFocus?: boolean;
  children: ReactNode;
  closeOnEscape?: boolean;
  closeOnPointerOutside?: boolean;
  description?: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange: (open: false, reason: MobileSheetCloseReason) => void;
  open: boolean;
  preventScroll?: boolean;
  showHandle?: boolean;
  title: ReactNode;
  trapFocus?: boolean;
}

export const MobileSheet = forwardRef<HTMLDivElement, MobileSheetProps>(
  function MobileSheet({
    "aria-describedby": ariaDescribedBy,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    autoFocus = true,
    children,
    className,
    closeOnEscape = true,
    closeOnPointerOutside = true,
    description,
    footer,
    headerAction,
    initialFocusRef,
    onOpenChange,
    open,
    preventScroll = true,
    showHandle = true,
    title,
    trapFocus = true,
    ...surfaceProps
  }, forwardedRef) {
    const designSystem = useDesignSystem();
    const portalTarget = resolvePortalTarget(designSystem.portalHost);
    const ownerDocument = portalTarget?.ownerDocument
      ?? (typeof document === "undefined" ? null : document);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const titleId = `openbitfun-mobile-sheet-title-${useId()}`;
    const descriptionId = `openbitfun-mobile-sheet-description-${useId()}`;
    const { present, state } = usePresence(open, EXIT_DURATION_MS);

    const close = useCallback((reason: MobileSheetCloseReason) => {
      if (open) onOpenChange(false, reason);
    }, [onOpenChange, open]);

    const setSurfaceRef = useCallback((node: HTMLDivElement | null) => {
      surfaceRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);

    useDismissibleLayer({
      dismissOnEscape: closeOnEscape,
      dismissOnPointerOutside: closeOnPointerOutside,
      enabled: open,
      layerRef: surfaceRef,
      onDismiss: close,
      ownerDocument,
    });
    useFocusScope({
      active: open && present,
      autoFocus,
      containerRef: surfaceRef,
      initialFocusRef,
      ownerDocument,
      trapFocus,
    });

    if (!present || !portalTarget) return null;
    const exiting = state === "exiting";

    return (
      <Portal target={portalTarget} open={open} modal preventScroll={preventScroll}>
        <div
          className={styles.overlay}
          data-openbitfun-component="mobile-sheet"
          data-openbitfun-part="overlay"
          data-state={exiting ? "exiting" : "open"}
        >
          <div
            {...surfaceProps}
            {...(!open ? { inert: "" } : {})}
            aria-describedby={ariaDescribedBy ?? (description ? descriptionId : undefined)}
            aria-hidden={exiting || undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy ?? (!ariaLabel ? titleId : undefined)}
            aria-modal="true"
            className={classNames(styles.root, className)}
            data-openbitfun-component="mobile-sheet"
            data-openbitfun-part="surface"
            data-state={exiting ? "exiting" : "open"}
            ref={setSurfaceRef}
            role="dialog"
            tabIndex={-1}
          >
            {showHandle && <div aria-hidden="true" className={styles.handle} data-openbitfun-part="handle" />}
            <header className={styles.header} data-openbitfun-part="header">
              <div className={styles.heading} data-openbitfun-part="heading">
                <h2 className={styles.title} id={titleId}>{title}</h2>
                {description !== undefined && description !== null && (
                  <p className={styles.description} id={descriptionId}>{description}</p>
                )}
              </div>
              {headerAction !== undefined && headerAction !== null && (
                <div className={styles.headerAction} data-openbitfun-part="header-action">{headerAction}</div>
              )}
            </header>
            <div className={styles.body} data-openbitfun-part="body">{children}</div>
            {footer !== undefined && footer !== null && (
              <footer className={styles.footer} data-openbitfun-part="footer">{footer}</footer>
            )}
          </div>
        </div>
      </Portal>
    );
  },
);
