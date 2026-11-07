import { beforeEach, describe, expect, it } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import {
  confirmDanger,
  confirmDialog,
  confirmDialogChoice,
  useConfirmDialogStore,
} from './confirmDialogService';

describe('confirmDialogService', () => {
  beforeEach(() => {
    useConfirmDialogStore.getState().cancel();
    resetDeviceSurfaceForTest();
    useConfirmDialogStore.setState({ isOpen: false, options: null, resolve: null });
  });

  it('cancels a pending choice when the device changes, including a switch back', async () => {
    const result = confirmDialogChoice({ title: 'Delete on this device?' });
    const oldReply = useConfirmDialogStore.getState().resolve!;
    activateSurface('peer-a');
    activateSurface('local');
    oldReply('confirm');
    await expect(result).resolves.toBe('cancel');
    expect(useConfirmDialogStore.getState().isOpen).toBe(false);
    expect(useConfirmDialogStore.getState().options).toBeNull();
  });

  it('resolves boolean confirmations through the shared renderer state', async () => {
    const result = confirmDialog({ title: 'Save?', message: 'Continue' });

    expect(useConfirmDialogStore.getState().isOpen).toBe(true);
    useConfirmDialogStore.getState().confirm();

    await expect(result).resolves.toBe(true);
    expect(useConfirmDialogStore.getState().options).toBeNull();
  });

  it('preserves secondary choices independently from confirmation', async () => {
    const result = confirmDialogChoice({
      title: 'Run commands?',
      secondaryText: 'Always allow',
    });

    useConfirmDialogStore.getState().secondary();

    await expect(result).resolves.toBe('secondary');
  });

  it('cancels an active request before replacing it', async () => {
    const first = confirmDialogChoice({ title: 'First' });
    const second = confirmDialogChoice({ title: 'Second' });

    await expect(first).resolves.toBe('cancel');
    expect(useConfirmDialogStore.getState().options?.title).toBe('Second');
    useConfirmDialogStore.getState().cancel();
    await expect(second).resolves.toBe('cancel');
  });

  it('applies destructive defaults without overriding explicit options', async () => {
    const result = confirmDanger('Delete?', 'Cannot undo', { confirmDanger: false });

    expect(useConfirmDialogStore.getState().options).toMatchObject({
      confirmDanger: false,
      title: 'Delete?',
      type: 'error',
    });
    useConfirmDialogStore.getState().cancel();
    await expect(result).resolves.toBe(false);
  });
});
