import { expect, it } from 'vitest';
import { fitPreview, pointerInPreview, previewToImage } from './previewGeometry';
import type { ComputerUseSharedFrame } from '@/infrastructure/api/service-api/ComputerUseControlAPI';
const frame: ComputerUseSharedFrame = { screenshot_id: 'original', image_base64: '', mime_type: 'image/jpeg', width: 1000, height: 500,
  content: { left: 100, top: 50, width: 800, height: 400 }, bounds: { left: -1200, top: 20, width: 400, height: 300 } };
it('excludes letterbox and image padding, maps negative monitor origins and keeps the exact frame identity', () => {
  const box = { left: 20, top: 10, width: 500, height: 500 };
  expect(fitPreview(frame, box)).toEqual({ left: 20, top: 135, width: 500, height: 250 });
  expect(previewToImage(frame, box, 30, 150)).toBeNull();
  expect(previewToImage(frame, box, 300, 100)).toBeNull();
  expect(previewToImage(frame, box, 270, 260)).toEqual({ kind: 'image_xy', x: 500, y: 250, screenshot_id: 'original' });
  expect(pointerInPreview(frame, -1000, 170)).toEqual({ x: 0.5, y: 0.5 });
  expect(pointerInPreview(frame, -800, 170)).toBeNull();
});
it('rejects malformed capture geometry without clamping it to a valid click', () => {
  const box = { left: 0, top: 0, width: 500, height: 500 };
  expect(previewToImage({ ...frame, width: 0 }, box, 1, 1)).toBeNull();
  expect(previewToImage(frame, box, NaN, 1)).toBeNull();
  expect(fitPreview({ ...frame, content: { ...frame.content, width: 1000 } }, box)).toBeNull();
});
