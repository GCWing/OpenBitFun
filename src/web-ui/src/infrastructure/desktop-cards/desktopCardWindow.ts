import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { api } from '@/infrastructure/api/service-api/ApiClient';

export function readDesktopCardIdFromLocation(search: string = window.location.search): string | null {
  const cardId = new URLSearchParams(search).get('cardId')?.trim();
  return cardId && /^[A-Za-z0-9_-]{1,64}$/.test(cardId) ? cardId : null;
}

/** Moves the borderless card window with the OS drag loop. */
export async function startDesktopCardWindowDrag(): Promise<void> {
  await getCurrentWindow().startDragging();
}

export type DesktopCardResizeDirection = Parameters<TauriWindow['startResizeDragging']>[0];

export const DESKTOP_CARD_RESIZE_DIRECTIONS: readonly DesktopCardResizeDirection[] = [
  'North',
  'South',
  'East',
  'West',
  'NorthEast',
  'NorthWest',
  'SouthEast',
  'SouthWest',
];

/** Resizes the borderless card window with the OS resize loop from one of its edges. */
export async function startDesktopCardWindowResize(direction: DesktopCardResizeDirection): Promise<void> {
  await getCurrentWindow().startResizeDragging(direction);
}

/** Opens the session that created a card in the main window. */
export async function openDesktopCardSourceSession(sessionId: string): Promise<void> {
  await emit('agent-companion://open-session', { sessionId });
  await api.invoke('show_main_window');
}
