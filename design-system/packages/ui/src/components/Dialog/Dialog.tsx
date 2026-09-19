import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "../Icon";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { Portal, resolvePortalTarget } from "../../overlay/Portal";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import { useDismissibleLayer } from "../../overlay/useDismissibleLayer";
import { useFocusScope } from "../../overlay/useFocusScope";
import { usePresence } from "../../overlay/usePresence";
import { IconButton, type IconButtonProps } from "../IconButton";
import styles from "./Dialog.module.css";

const EXIT_DURATION_MS = 180;

export type DialogCloseReason = "close-button" | "escape-key" | "pointer-outside";
export type DialogFooterAppearance = "attached" | "floating";
export type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl";
export type SheetPlacement = "left" | "right" | "bottom";
export type SheetSize = "sm" | "md" | "lg";

interface DialogContextValue {
  close: (reason: DialogCloseReason) => void;
  descriptionId: string;
  titleId: string;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const context = useContext(DialogContext);
  if (!context) throw new Error(`${component} must be rendered inside Dialog or Sheet.`);
  return context;
}

function containsType(children: ReactNode, type: unknown): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false;
    if (child.type === type) return true;
    const nested = (child.props as { children?: ReactNode }).children;
    return nested !== undefined && containsType(nested, type);
  });
}

interface OverlaySurfaceProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  autoFocus?: boolean;
  restoreFocus?: boolean;
  portalTarget?: HTMLElement | null;
  overlayProps?: HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: string | number | boolean | undefined };
  children: ReactNode;
  closeOnEscape?: boolean;
  closeOnPointerOutside?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  kind: "dialog" | "sheet";
  onOpenChange: (open: false, reason: DialogCloseReason) => void;
  /** Called after the closed surface has finished exiting and unmounted. */
  onExitComplete?: () => void;
  open: boolean;
  placement?: SheetPlacement;
  preventScroll?: boolean;
  role?: "dialog" | "alertdialog";
  size: DialogSize | SheetSize;
  trapFocus?: boolean;
}

const OverlaySurface = forwardRef<HTMLDivElement, OverlaySurfaceProps>(function OverlaySurface({
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  autoFocus = true,
  restoreFocus = true,
  portalTarget,
  overlayProps,
  children,
  className,
  closeOnEscape = true,
  closeOnPointerOutside = true,
  initialFocusRef,
  kind,
  onOpenChange,
  onExitComplete,
  open,
  placement,
  preventScroll = true,
  role = "dialog",
  size,
  trapFocus = true,
  ...surfaceProps
}, forwardedRef) {
  const designSystem = useDesignSystem();
  const resolvedPortalHost = resolvePortalTarget(portalTarget ?? designSystem.portalHost);
  const ownerDocument = resolvedPortalHost?.ownerDocument
    ?? (typeof document === "undefined" ? null : document);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const titleId = `openbitfun-dialog-title-${useId()}`;
  const descriptionId = `openbitfun-dialog-description-${useId()}`;
  const { present, state } = usePresence(open, EXIT_DURATION_MS);
  const lastOpenChildren = useRef<ReactNode>(null);
  const wasPresent = useRef(present);
  // Owners often clear selection or form state in the same update as closing.
  // Keep the last committed content until the exit finishes to preserve geometry.
  useLayoutEffect(() => {
    if (open) lastOpenChildren.current = children;
    else if (!present) lastOpenChildren.current = null;
  }, [children, open, present]);
  useEffect(() => {
    const completed = wasPresent.current && !present && !open;
    wasPresent.current = present;
    if (completed) onExitComplete?.();
  }, [onExitComplete, open, present]);
  const renderedChildren = open ? children : lastOpenChildren.current;
  const hasTitle = containsType(renderedChildren, DialogTitle);
  const hasDescription = containsType(renderedChildren, DialogDescription);

  const close = useCallback((reason: DialogCloseReason) => {
    if (open) onOpenChange(false, reason);
  }, [onOpenChange, open]);

  const context = useMemo<DialogContextValue>(() => ({
    close,
    descriptionId,
    titleId,
  }), [close, descriptionId, titleId]);

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
    onDismiss: (reason) => close(reason === "escape-key" ? "escape-key" : "pointer-outside"),
    ownerDocument,
  });
  useFocusScope({
    // A closed dialog mounts its surface on the presence commit. Start the
    // focus scope only once that ref exists, including every subsequent open.
    active: open && present,
    autoFocus,
    containerRef: surfaceRef,
    initialFocusRef,
    ownerDocument,
    trapFocus,
    restoreFocus,
  });

  if (!present || !resolvedPortalHost) return null;
  const exiting = state === "exiting";

  return (
    <Portal target={resolvedPortalHost} open={open} modal preventScroll={preventScroll}>
      <div
        {...overlayProps}
        className={classNames(styles.overlay, overlayProps?.className)}
        data-openbitfun-component={kind}
        data-openbitfun-part="overlay"
        data-openbitfun-native-webview-occlusion
        data-placement={placement}
        data-state={exiting ? "exiting" : "open"}
      >
        <DialogContext.Provider value={context}>
          <div
            {...surfaceProps}
            {...(!open ? { inert: "" } : {})}
            aria-describedby={ariaDescribedBy ?? (hasDescription ? descriptionId : undefined)}
            aria-hidden={exiting || undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy ?? (!ariaLabel && hasTitle ? titleId : undefined)}
            aria-modal="true"
            className={classNames(styles.surface, className)}
            data-openbitfun-component={kind}
            data-openbitfun-part="surface"
            data-placement={placement}
            data-size={size}
            data-state={exiting ? "exiting" : "open"}
            ref={setSurfaceRef}
            role={role}
            tabIndex={-1}
          >
            {renderedChildren}
          </div>
        </DialogContext.Provider>
      </div>
    </Portal>
  );
});

export interface DialogProps
  extends Omit<OverlaySurfaceProps, "kind" | "placement" | "size"> {
  size?: DialogSize;
}

export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog({
  size = "md",
  ...props
}, ref) {
  return <OverlaySurface {...props} kind="dialog" ref={ref} size={size} />;
});

export interface SheetProps
  extends Omit<OverlaySurfaceProps, "kind" | "placement" | "size"> {
  placement?: SheetPlacement;
  size?: SheetSize;
}

export const Sheet = forwardRef<HTMLDivElement, SheetProps>(function Sheet({
  placement = "right",
  size = "md",
  ...props
}, ref) {
  return (
    <OverlaySurface
      {...props}
      kind="sheet"
      placement={placement}
      ref={ref}
      size={size}
    />
  );
});

export interface DialogHeaderProps extends HTMLAttributes<HTMLDivElement> {
  separator?: boolean;
}

export const DialogHeader = forwardRef<HTMLDivElement, DialogHeaderProps>(
  function DialogHeader({ className, separator = false, ...props }, ref) {
    return <header {...props} className={classNames(styles.header, className)} data-openbitfun-part="header" data-separator={separator} ref={ref} />;
  },
);

export const DialogHeading = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogHeading({ className, ...props }, ref) {
    return <div {...props} className={classNames(styles.heading, className)} data-openbitfun-part="heading" ref={ref} />;
  },
);

export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ children, className, id, ...props }, ref) {
    const context = useDialogContext("DialogTitle");
    return (
      <h2 {...props} className={classNames(styles.title, className)} data-openbitfun-part="title" id={id ?? context.titleId} ref={ref}>
        <OverflowText>{children}</OverflowText>
      </h2>
    );
  },
);

export const DialogDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function DialogDescription({ className, id, ...props }, ref) {
    const context = useDialogContext("DialogDescription");
    return <p {...props} className={classNames(styles.description, className)} data-openbitfun-part="description" id={id ?? context.descriptionId} ref={ref} />;
  },
);

export const DialogHeaderActions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogHeaderActions({ className, ...props }, ref) {
    return <div {...props} className={classNames(styles.headerActions, className)} data-openbitfun-part="header-actions" ref={ref} />;
  },
);

export interface DialogCloseProps
  extends Omit<IconButtonProps, "aria-label" | "icon" | "onClick"> {
  "aria-label"?: string;
  icon?: ReactNode;
}

export const DialogClose = forwardRef<HTMLButtonElement, DialogCloseProps>(
  function DialogClose({ "aria-label": ariaLabel, className, icon, ...props }, ref) {
    const context = useDialogContext("DialogClose");
    const designSystem = useDesignSystem();
    return (
      <IconButton
        {...props}
        aria-label={ariaLabel ?? designSystem.messages.dialogClose}
        className={classNames(styles.close, className)}
        data-openbitfun-part="close"
        icon={icon ?? <Icon name="xmark" />}
        onClick={() => context.close("close-button")}
        ref={ref}
        size="sm"
        variant="quiet"
      />
    );
  },
);

export interface DialogBodyProps extends HTMLAttributes<HTMLDivElement> {
  inset?: "none" | "standard";
}

export const DialogBody = forwardRef<HTMLDivElement, DialogBodyProps>(
  function DialogBody({ className, inset = "standard", ...props }, ref) {
    return (
      <div
        {...props}
        className={classNames(styles.body, className)}
        data-openbitfun-part="body"
        data-inset={inset}
        ref={ref}
      />
    );
  },
);

export interface DialogFooterProps extends HTMLAttributes<HTMLElement> {
  appearance?: DialogFooterAppearance;
  separator?: boolean;
}

export const DialogFooter = forwardRef<HTMLElement, DialogFooterProps>(
  function DialogFooter({ appearance = "attached", className, separator = false, ...props }, ref) {
    return (
      <footer
        {...props}
        className={classNames(styles.footer, className)}
        data-appearance={appearance}
        data-separator={separator}
        data-openbitfun-part="footer"
        ref={ref}
      />
    );
  },
);
