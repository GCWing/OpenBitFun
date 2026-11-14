import type { PageViewport } from 'pdfjs-dist';

export function selectionQuads(rectangles: DOMRect[], page: DOMRect, viewport: PageViewport): number[] {
  const quads: number[] = [];
  for (const rectangle of rectangles) {
    const left = Math.max(0, rectangle.left - page.left);
    const top = Math.max(0, rectangle.top - page.top);
    const right = Math.min(page.width, rectangle.right - page.left);
    const bottom = Math.min(page.height, rectangle.bottom - page.top);
    if (right - left < 1 || bottom - top < 1) continue;
    quads.push(...viewport.convertToPdfPoint(left, top), ...viewport.convertToPdfPoint(right, top),
      ...viewport.convertToPdfPoint(left, bottom), ...viewport.convertToPdfPoint(right, bottom));
  }
  return quads;
}
