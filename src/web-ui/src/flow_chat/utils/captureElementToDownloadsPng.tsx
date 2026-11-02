import { Button } from '@openbitfun/ui';
import { downloadDir, join } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';
import { notificationService } from '@/shared/notification-system';
import { i18nService } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { getBuiltinAppearanceThemeToken } from '@/infrastructure/appearance/builtins/catalog';
import { captureExportCanvas } from './exportImageCapture';

const log = createLogger('captureElementToDownloadsPng');

export async function captureElementToDownloadsPng(
  element: HTMLElement,
  fileNamePrefix: string,
): Promise<void> {
  const computedStyle = getComputedStyle(document.documentElement);
  const bgColor = computedStyle.getPropertyValue('--openbitfun-color-surface-scene').trim()
    || getBuiltinAppearanceThemeToken('--openbitfun-color-surface-scene');

  await new Promise((resolve) => setTimeout(resolve, 0));

  const canvas = await captureExportCanvas(element, bgColor);
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  if (!blob) {
    throw new Error(i18nService.t('flow-chat:exportImage.generateFailed'));
  }

  const timestampStr = i18nService
    .formatDate(new Date(), {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/[/:\s]/g, '-');
  const fileName = `${fileNamePrefix}_${timestampStr}.png`;
  const downloadsPath = await downloadDir();
  const filePath = await join(downloadsPath, fileName);

  const arrayBuffer = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(arrayBuffer));

  const plainSuccessMessage = i18nService.t('flow-chat:exportImage.exportSuccess', { filePath });
  const successPrefix = i18nService.t('flow-chat:exportImage.exportSuccessPrefix');

  const revealExportedFile = async () => {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) {
      return;
    }
    try {
      await workspaceAPI.revealInExplorer(filePath);
    } catch (error) {
      log.error('Failed to reveal export path in file manager', { filePath, error });
    }
  };

  notificationService.success(plainSuccessMessage, {
    messageNode: (
      <>
        {successPrefix}
        <Button labelBehavior="static" variant="text"
          type="button"
          className="notification-item__path-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void revealExportedFile();
          }}
        >
          {filePath}
        </Button>
      </>
    ),
  });
}
