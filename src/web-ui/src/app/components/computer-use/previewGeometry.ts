import type { ComputerUseSharedFrame, PreviewPoint } from '@/infrastructure/api/service-api/ComputerUseControlAPI';
export interface PreviewRect { left: number; top: number; width: number; height: number }
/** Same aspect-fit and content boundaries as CaptureGeometry::fit_preview. */
export function fitPreview(frame: ComputerUseSharedFrame, box: PreviewRect): PreviewRect | null {
  const c = frame.content;
  if (![frame.width, frame.height, box.width, box.height, c.width, c.height].every(v => Number.isFinite(v) && v > 0)
    || ![box.left, box.top, c.left, c.top].every(Number.isFinite) || c.left < 0 || c.top < 0
    || c.left + c.width > frame.width || c.top + c.height > frame.height) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale, height = frame.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}
export function previewToImage(frame: ComputerUseSharedFrame, box: PreviewRect, clientX: number, clientY: number): PreviewPoint | null {
  const fit = fitPreview(frame, box);
  if (!fit || ![clientX, clientY].every(Number.isFinite)) return null;
  const x = (clientX - fit.left) * frame.width / fit.width, y = (clientY - fit.top) * frame.height / fit.height;
  const c = frame.content;
  if (x < c.left || x >= c.left + c.width || y < c.top || y >= c.top + c.height) return null;
  return { kind: 'image_xy', x: Math.floor(x), y: Math.floor(y), screenshot_id: frame.screenshot_id };
}
export function pointerInPreview(frame: ComputerUseSharedFrame, x: number, y: number): { x: number; y: number } | null {
  const b = frame.bounds, c = frame.content;
  if (!b || ![x, y, b.left, b.top, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
  const rx = (x - b.left) / b.width, ry = (y - b.top) / b.height;
  return rx >= 0 && rx < 1 && ry >= 0 && ry < 1 ? { x: (c.left + rx * c.width) / frame.width, y: (c.top + ry * c.height) / frame.height } : null;
}
