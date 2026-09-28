import { useEffect, useRef, type RefObject } from 'react';
import { createLogger } from '@/shared/utils/logger';
import type { WorkspaceInfo } from '@/shared/types';
import {
  isDragPositionOverElement,
  resolveDropTargetDirectoryFromDragPosition,
  uploadLocalPathsToWorkspaceDirectory,
  type TransferProgressState,
} from '@/tools/file-system/services/workspaceFileTransfer';

const log = createLogger('useWorkspaceFileDrop');

const DROP_DEDUPE_MS = 500;

export interface UseWorkspaceFileDropOptions {
  workspace: WorkspaceInfo | null;
  workspacePath?: string;
  panelRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  onProgress: (state: TransferProgressState | null, transferId: string) => void;
  onDragOver?: (overPanel: boolean) => void;
  onComplete: (targetDirectory: string, transferId: string) => void;
  onError: (error: unknown, transferId: string) => void;
}

export function useWorkspaceFileDrop({
  workspace: currentWorkspace,
  workspacePath,
  panelRef,
  enabled = true,
  onProgress,
  onDragOver,
  onComplete,
  onError,
}: UseWorkspaceFileDropOptions): void {
  const lastEnterPathsRef = useRef<string[]>([]);
  const lastDropTargetRef = useRef<string | null>(null);
  const isDragOverPanelRef = useRef(false);
  const dropProcessingRef = useRef(false);
  const lastDropSignatureRef = useRef<{ signature: string; at: number } | null>(null);

  useEffect(() => {
    if (
      typeof window === 'undefined'
      || !('__TAURI__' in window)
      || !workspacePath
      || !enabled
    ) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        if (cancelled) {
          return;
        }

        unlisten = await webview.onDragDropEvent(async (event) => {
          if (cancelled) {
            return;
          }

          const payload = event.payload;

          if (payload.type === 'leave') {
            isDragOverPanelRef.current = false;
            onDragOver?.(false);
            return;
          }

          if (payload.type === 'enter') {
            lastEnterPathsRef.current = [...payload.paths];
            return;
          }

          if (payload.type === 'over') {
            const factor = await webview.window.scaleFactor();
            const panelEl = panelRef.current;
            const overPanel = isDragPositionOverElement(payload.position, factor, panelEl);
            isDragOverPanelRef.current = overPanel;

            if (overPanel) {
              lastDropTargetRef.current = resolveDropTargetDirectoryFromDragPosition(
                payload.position,
                factor,
                workspacePath,
                panelEl
              );
            }
            onDragOver?.(overPanel);
            return;
          }

          if (payload.type !== 'drop') {
            return;
          }

          const factor = await webview.window.scaleFactor();
          const panelEl = panelRef.current;
          const overPanel = isDragPositionOverElement(payload.position, factor, panelEl)
            || isDragOverPanelRef.current;

          if (!overPanel) {
            lastEnterPathsRef.current = [];
            lastDropTargetRef.current = null;
            isDragOverPanelRef.current = false;
            return;
          }

          const paths = payload.paths.length > 0
            ? payload.paths
            : [...lastEnterPathsRef.current];

          if (paths.length === 0) {
            log.warn('Ignoring file drop with empty paths');
            return;
          }

          const signature = `${paths.join('\0')}->${lastDropTargetRef.current ?? workspacePath}`;
          const now = Date.now();
          const lastDrop = lastDropSignatureRef.current;
          if (
            lastDrop
            && lastDrop.signature === signature
            && now - lastDrop.at < DROP_DEDUPE_MS
          ) {
            return;
          }
          lastDropSignatureRef.current = { signature, at: now };

          if (dropProcessingRef.current) {
            return;
          }

          const targetDir = lastDropTargetRef.current
            ?? resolveDropTargetDirectoryFromDragPosition(
              payload.position,
              factor,
              workspacePath,
              panelEl
            );

          lastEnterPathsRef.current = [];
          lastDropTargetRef.current = null;
          isDragOverPanelRef.current = false;

          dropProcessingRef.current = true;
          // One id per drop session: it keys the progress card and reaches the
          // backend, so the card's stop action cancels this upload instead of
          // sending an id no transfer ever registered.
          const transferId = crypto.randomUUID();
          try {
            await uploadLocalPathsToWorkspaceDirectory(
              paths,
              targetDir,
              currentWorkspace,
              (state) => onProgress(state, transferId),
              undefined,
              transferId
            );
            onComplete(targetDir, transferId);
          } catch (error) {
            log.error('Failed to upload dropped files', error);
            onError(error, transferId);
          } finally {
            dropProcessingRef.current = false;
          }
        });
      } catch (error) {
        log.warn('File drag-drop listener not available', error);
      }
    };

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
      lastEnterPathsRef.current = [];
      lastDropTargetRef.current = null;
      isDragOverPanelRef.current = false;
    };
  }, [
    workspacePath,
    enabled,
    currentWorkspace,
    panelRef,
    onProgress,
    onDragOver,
    onComplete,
    onError,
  ]);
}
