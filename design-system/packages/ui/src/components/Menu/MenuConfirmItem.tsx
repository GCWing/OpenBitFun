import { useLayoutEffect, useRef, useState } from "react";
import { MenuItem, MenuList, type MenuItemProps } from "./Menu";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import styles from "./Menu.module.css";

export interface MenuConfirmation {
  description: string;
  confirmText?: string;
  cancelText?: string;
}

export interface MenuConfirmItemProps extends Omit<MenuItemProps, "onClick"> {
  confirmation: MenuConfirmation;
  onConfirm: (trigger: HTMLButtonElement) => void | Promise<void>;
  onActionError?: (error: unknown) => void;
}

/** The action stays in its menu row until the user explicitly confirms it. */
export function MenuConfirmItem({ confirmation, onConfirm, onActionError, disabled, ...props }: MenuConfirmItemProps) {
  const { messages } = useDesignSystem();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (confirming) cancelRef.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      triggerRef.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [confirming]);
  const cancel = () => {
    if (pendingRef.current) return;
    restoreFocus.current = true;
    setConfirming(false);
  };
  const confirm = async (trigger: HTMLButtonElement) => {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { await onConfirm(trigger); }
    catch (error) { onActionError?.(error); }
    finally {
      pendingRef.current = false;
      setPending(false);
      setConfirming(false);
    }
  };
  if (!confirming) return <MenuItem {...props} disabled={disabled} ref={triggerRef} title={confirmation.description}
    onClick={event => { event.stopPropagation(); setConfirming(true); }} />;

  return <div data-openbitfun-component="menu" data-openbitfun-part="items" data-openbitfun-menu-confirmation="">
    <MenuList className={styles.confirmation} role="group" aria-label={confirmation.description} aria-busy={pending}
      onKeyDown={event => {
        if (event.key === "Escape" && !pending) { event.preventDefault(); event.stopPropagation(); cancel(); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); event.stopPropagation();
          (event.key === "ArrowLeft" ? cancelRef : confirmRef).current?.focus({ preventScroll: true });
        }
      }}>
      <MenuItem ref={cancelRef} disabled={disabled || pending} triggerClassName={styles.confirmationButton}
        data-openbitfun-menu-confirmation-cancel="" onClick={event => { event.stopPropagation(); cancel(); }}>
        {confirmation.cancelText ?? messages.confirmCancel}
      </MenuItem>
      <span className={styles.confirmationDivider} aria-hidden="true" />
      <MenuItem ref={confirmRef} disabled={disabled || pending} tone="danger" title={confirmation.description}
        triggerClassName={styles.confirmationButton} onClick={event => { event.stopPropagation(); void confirm(event.currentTarget); }}>
        {confirmation.confirmText ?? messages.confirmAction}
      </MenuItem>
    </MenuList>
  </div>;
}
