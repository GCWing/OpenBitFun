import { supportsNativeWindowControls } from '@/infrastructure/runtime';

/** Explicit export belongs to the viewing device; workspace saves use the host upload port. */
export async function savePdfFile(fileName: string, bytes: Uint8Array, title: string): Promise<boolean> {
  if (supportsNativeWindowControls()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ title, defaultPath: fileName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
