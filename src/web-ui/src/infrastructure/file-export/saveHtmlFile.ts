import { downloadTextFileInBrowser } from '@/shared/utils/browserDownload';

export function safeHtmlFileName(title: string): string {
  let stem = title.trim().replace(/\.html?$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .slice(0, 96).replace(/[.\s]+$/g, '').trim();
  if (!stem) stem = 'OpenBitFun';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.html`;
}

/** Save on the viewing device, independently of workspace or peer transport. */
export async function saveHtmlFile(options: {
  html: string;
  title: string;
  dialogTitle: string;
}): Promise<boolean> {
  const fileName = safeHtmlFileName(options.title);
  if (!('__TAURI__' in window)) {
    downloadTextFileInBrowser(fileName, options.html, 'text/html;charset=utf-8');
    return true;
  }

  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({
    title: options.dialogTitle,
    defaultPath: fileName,
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (!path) return false;
  await writeFile(path, new TextEncoder().encode(options.html));
  return true;
}
