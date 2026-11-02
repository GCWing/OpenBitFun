/** Controller-owned file input; only normalized bytes cross the host boundary. */
export async function prepareWorkspaceIcon(file: File, crop: boolean, zoom = 1): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('invalidImage');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000) throw new Error('invalidImage');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('invalidImage');
    const scale = (crop ? Math.max(256 / bitmap.width, 256 / bitmap.height) : Math.min(256 / bitmap.width, 256 / bitmap.height)) * zoom;
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
    return canvas.toDataURL('image/png');
  } finally { bitmap.close(); }
}
