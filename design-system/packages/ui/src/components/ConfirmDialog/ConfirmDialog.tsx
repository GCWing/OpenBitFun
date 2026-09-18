import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  TriangleAlert,
} from "lucide-react";
import { Icon } from "../Icon";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import { Button } from "../Button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  type DialogCloseReason,
} from "../Dialog";
import styles from "./ConfirmDialog.module.css";

export type ConfirmDialogCloseReason = DialogCloseReason | "cancel-button";
export type ConfirmDialogType = "info" | "warning" | "error" | "success";
export type ConfirmDialogAction = () => void | Promise<void>;

export interface ConfirmDialogProps {
  cancelText?: ReactNode;
  closeOnEscape?: boolean;
  closeOnPointerOutside?: boolean;
  confirmDanger?: boolean;
  confirmText?: ReactNode;
  icon?: ReactNode | false;
  message?: ReactNode;
  onActionError?: (error: unknown, action: "confirm" | "secondary") => void;
  onConfirm: ConfirmDialogAction;
  onOpenChange: (open: false, reason: ConfirmDialogCloseReason) => void;
  onSecondary?: ConfirmDialogAction;
  open: boolean;
  pendingAction?: "confirm" | "secondary" | null;
  preview?: ReactNode;
  secondaryText?: ReactNode;
  showCancel?: boolean;
  showCloseButton?: boolean;
  testId?: string;
  title: ReactNode;
  type?: ConfirmDialogType;
}

const defaultIcons: Record<ConfirmDialogType, ReactNode> = {
  error: <Icon glyph={AlertCircle} />,
  info: <Icon name="info" />,
  success: <Icon name="check-circle" />,
  warning: <Icon glyph={TriangleAlert} />,
};

export const ConfirmDialog = forwardRef<HTMLDivElement, ConfirmDialogProps>(
  function ConfirmDialog({
    cancelText,
    closeOnEscape = true,
    closeOnPointerOutside = true,
    confirmDanger = false,
    confirmText,
    icon,
    message,
    onActionError,
    onConfirm,
    onOpenChange,
    onSecondary,
    open,
    pendingAction: controlledPendingAction,
    preview,
    secondaryText,
    showCancel = true,
    showCloseButton = false,
    testId,
    title,
    type = "warning",
  }, ref) {
    const designSystem = useDesignSystem();
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const mountedRef = useRef(true);
    const [internalPendingAction, setInternalPendingAction] = useState<"confirm" | "secondary" | null>(null);
    const pendingAction = controlledPendingAction ?? internalPendingAction;
    const busy = pendingAction !== null;
    const resolvedIcon = icon === false ? null : icon ?? defaultIcons[type];
    const hasMessage = message !== undefined && message !== null && message !== "";
    const hasPreview = preview !== undefined && preview !== null && preview !== "";
    const resolvedCancelText = cancelText ?? designSystem.messages.confirmCancel;
    const resolvedConfirmText = confirmText ?? designSystem.messages.confirmAction;

    useEffect(() => () => {
      mountedRef.current = false;
    }, []);

    useEffect(() => {
      if (!open) setInternalPendingAction(null);
    }, [open]);

    const runAction = useCallback(async (
      actionName: "confirm" | "secondary",
      action: ConfirmDialogAction | undefined,
    ) => {
      if (!action || busy) return;
      try {
        const result = action();
        if (result && typeof result.then === "function") {
          setInternalPendingAction(actionName);
          await result;
        }
      } catch (error) {
        onActionError?.(error, actionName);
      } finally {
        if (mountedRef.current) setInternalPendingAction(null);
      }
    }, [busy, onActionError]);

    const requestClose = useCallback((reason: ConfirmDialogCloseReason) => {
      if (busy) return;
      onOpenChange(false, reason);
    }, [busy, onOpenChange]);

    return (
      <Dialog
        closeOnEscape={!busy && closeOnEscape}
        closeOnPointerOutside={!busy && closeOnPointerOutside}
        data-testid={testId}
        initialFocusRef={confirmButtonRef}
        onOpenChange={(_nextOpen, reason) => requestClose(reason)}
        open={open}
        ref={ref}
        role="alertdialog"
        size="sm"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeading>
          {showCloseButton ? <DialogClose disabled={busy} /> : null}
        </DialogHeader>
        {hasMessage || hasPreview ? (
          <DialogBody>
            <div className={styles.content} data-openbitfun-component="confirm-dialog" data-openbitfun-part="content">
              {hasMessage ? (
                <div
                  className={styles.messageRow}
                  data-openbitfun-component="confirm-dialog"
                  data-openbitfun-part="messageRow"
                >
                  {resolvedIcon !== null ? (
                    <span
                      aria-hidden="true"
                      className={styles.icon}
                      data-openbitfun-component="confirm-dialog"
                      data-openbitfun-icon-slot="true"
                      data-openbitfun-part="icon"
                      data-openbitfun-status={type === "error" ? "danger" : type}
                    >
                      {resolvedIcon}
                    </span>
                  ) : null}
                  <div
                    className={styles.message}
                    data-openbitfun-component="confirm-dialog"
                    data-openbitfun-part="message"
                  >
                    {message}
                  </div>
                </div>
              ) : null}
              {hasPreview ? (
                <div
                  className={styles.preview}
                  data-openbitfun-component="confirm-dialog"
                  data-openbitfun-part="preview"
                >
                  {typeof preview === "string" ? <pre>{preview}</pre> : preview}
                </div>
              ) : null}
            </div>
          </DialogBody>
        ) : null}
        <DialogFooter>
          {showCancel ? (
            <Button disabled={busy} onClick={() => requestClose("cancel-button")} variant="fill">
              {resolvedCancelText}
            </Button>
          ) : null}
          {secondaryText !== undefined && secondaryText !== null ? (
            <Button
              disabled={busy}
              loading={pendingAction === "secondary"}
              onClick={() => void runAction("secondary", onSecondary)}
              variant="outline"
            >
              {secondaryText}
            </Button>
          ) : null}
          <Button
            disabled={busy}
            loading={pendingAction === "confirm"}
            onClick={() => void runAction("confirm", onConfirm)}
            ref={confirmButtonRef}
            tone={confirmDanger || type === "error" ? "danger" : "neutral"}
            variant="primary"
          >
            {resolvedConfirmText}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  },
);
