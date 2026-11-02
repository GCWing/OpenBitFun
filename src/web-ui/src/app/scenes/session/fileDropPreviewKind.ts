export type FilePreviewKind = 'image' | 'pdf' | 'spreadsheet' | 'presentation' | 'document' | 'code' | 'archive' | 'audio' | 'video' | 'file';

const extensions: Record<string, FilePreviewKind> = Object.fromEntries(
  (Object.entries({
    image: 'png jpg jpeg gif webp bmp ico svg avif heic heif tif tiff',
    pdf: 'pdf',
    spreadsheet: 'xls xlsx xlsm csv tsv ods numbers',
    presentation: 'ppt pptx odp key',
    document: 'doc docx odt rtf txt md markdown pages',
    code: 'js jsx ts tsx py rs go java c h cpp hpp cs rb php swift kt vue svelte html css scss json yaml yml toml xml sql sh ps1 ipynb cj',
    archive: 'zip rar 7z tar gz bz2 xz tgz',
    audio: 'mp3 wav flac aac m4a ogg opus',
    video: 'mp4 mov mkv avi webm m4v wmv',
  }) as [FilePreviewKind, string][]).flatMap(([kind, values]) => values.split(' ').map(extension => [extension, kind])),
);

export function getFileDropPreviewKind(name: string): { kind: FilePreviewKind; extension: string } {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return { kind: extensions[extension] ?? 'file', extension: extension.length <= 8 ? extension.toUpperCase() : '' };
}
