import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { ConfirmationAnchor, ConfirmDialogProps, ConfirmDialogType } from '@openbitfun/ui';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

export type ConfirmDialogChoice = 'confirm' | 'secondary' | 'cancel';

export interface ConfirmDialogOptions {
  anchor?: ConfirmationAnchor;
  cancelText?: ReactNode;
  confirmDanger?: boolean;
  confirmText?: ReactNode;
  message?: ReactNode;
  preview?: ReactNode;
  secondaryActionPlacement?: ConfirmDialogProps['secondaryActionPlacement'];
  secondaryText?: ReactNode;
  showCancel?: boolean;
  title: ReactNode;
  type?: ConfirmDialogType;
}

interface ConfirmDialogState {
  cancel: () => void;
  confirm: () => void;
  isOpen: boolean;
  options: ConfirmDialogOptions | null;
  resolve: ((value: ConfirmDialogChoice) => void) | null;
  secondary: () => void;
  show: (options: ConfirmDialogOptions) => Promise<boolean>;
  showChoice: (options: ConfirmDialogOptions) => Promise<ConfirmDialogChoice>;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => {
  let stopWatchingSurface: (() => void) | undefined;
  const settle = (choice: ConfirmDialogChoice) => {
    stopWatchingSurface?.();
    stopWatchingSurface = undefined;
    const { resolve } = get();
    set({ isOpen: false, options: null, resolve: null });
    resolve?.(choice);
  };

  return {
    cancel: () => settle('cancel'),
    confirm: () => settle('confirm'),
    isOpen: false,
    options: null,
    resolve: null,
    secondary: () => settle('secondary'),
    show: async (options) => (await get().showChoice(options)) === 'confirm',
    showChoice: (options) => new Promise<ConfirmDialogChoice>((resolve) => {
      const previousResolve = get().resolve;
      if (previousResolve) previousResolve('cancel');
      stopWatchingSurface?.();
      const scope = getActiveSurfaceScope();
      stopWatchingSurface = onSurfaceActivated(() => get().cancel());
      set({ isOpen: true, options, resolve: choice => resolve(scope.isCurrent() ? choice : 'cancel') });
    }),
  };
});

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return useConfirmDialogStore.getState().show(options);
}

export function confirmDialogChoice(
  options: ConfirmDialogOptions,
): Promise<ConfirmDialogChoice> {
  return useConfirmDialogStore.getState().showChoice(options);
}

export function confirmWarning(
  title: ReactNode,
  message: ReactNode,
  options?: Partial<ConfirmDialogOptions>,
): Promise<boolean> {
  return confirmDialog({ title, message, type: 'warning', ...options });
}

export function confirmDanger(
  title: ReactNode,
  message: ReactNode,
  options?: Partial<ConfirmDialogOptions>,
): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    type: 'error',
    confirmDanger: true,
    ...options,
  });
}

export function confirmInfo(
  title: ReactNode,
  message: ReactNode,
  options?: Partial<ConfirmDialogOptions>,
): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    type: 'info',
    showCancel: false,
    ...options,
  });
}
