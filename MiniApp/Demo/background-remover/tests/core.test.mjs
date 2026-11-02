import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ Uint8ClampedArray, Uint8Array, Uint32Array, setTimeout });
vm.runInContext(fs.readFileSync(new URL('../source/ui/core.js', import.meta.url), 'utf8'), context);
const { detectBackground, removeBackground } = context.IconCutout;
const immediate = { yieldControl: async () => {} };
const paper = [255, 255, 255, 255];
const ink = [20, 40, 60, 255];
function raster(width, height, pixel = () => paper) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}
const pixelAt = (image, x, y) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4));
const key = { color: [255, 255, 255], tolerance: 24, feather: 0 };

test('finds the dominant edge background even when a corner contains foreground', () => {
  const image = raster(9, 9, (x, y) => x < 2 && y < 2 ? ink : [242, 240, 238, 255]);
  assert.deepEqual(Array.from(detectBackground(image).color), [242, 240, 238]);
});

test('transparent padding does not cause the visible subject to become the automatic key', () => {
  const image = raster(5, 5, (x, y) => x === 2 && y === 2 ? ink : [180, 90, 30, 0]);
  assert.equal(detectBackground(image), null);
});

test('edge-connected removal keeps enclosed areas and never mutates the source', async () => {
  const image = raster(7, 7, (x, y) => (x === 2 || x === 4) && y >= 2 && y <= 4
    || (y === 2 || y === 4) && x >= 2 && x <= 4 ? ink : paper);
  const before = new Uint8ClampedArray(image.data);
  const output = await removeBackground(image, key, immediate);
  assert.equal(pixelAt(output, 0, 0)[3], 0);
  assert.deepEqual(pixelAt(output, 3, 3), paper);
  assert.deepEqual(pixelAt(output, 2, 3), ink);
  assert.deepEqual(image.data, before);
  assert.equal(output.changedPixels, 40);
  assert.equal(output.visiblePixels, 9);
});

test('global mode removes enclosed background inside logo holes', async () => {
  const image = raster(5, 5, (x, y) => x === 0 || y === 0 || x === 4 || y === 4 || x === 2 && y === 2 ? paper : ink);
  const output = await removeBackground(image, { ...key, connected: false }, immediate);
  assert.equal(pixelAt(output, 2, 2)[3], 0);
  assert.deepEqual(pixelAt(output, 1, 1), ink);
});

test('handles dark and colored backgrounds, JPEG-like variation, and one-pixel dimensions', async () => {
  for (const color of [[0, 0, 0], [40, 130, 75]]) {
    const image = raster(5, 1, x => x === 2 ? paper : [...color.map(c => c + x), 255]);
    const output = await removeBackground(image, { color, tolerance: 4, feather: 0 }, immediate);
    assert.deepEqual(Array.from(output.data.filter((_, index) => index % 4 === 3)), [0, 0, 255, 0, 0]);
  }
  const vertical = raster(1, 3, (_, y) => y === 1 ? ink : paper);
  const output = await removeBackground(vertical, key, immediate);
  assert.equal(output.visiblePixels, 1);
});

test('existing transparency and subject partial alpha are preserved', async () => {
  const image = raster(5, 1, x => x === 2 ? [10, 30, 70, 128] : x === 4 ? [150, 70, 30, 0] : paper);
  const output = await removeBackground(image, { ...key, feather: 20 }, immediate);
  assert.deepEqual(pixelAt(output, 2, 0), [10, 30, 70, 128]);
  assert.deepEqual(pixelAt(output, 4, 0), [150, 70, 30, 0]);
});

test('softness produces partial alpha and decontamination reduces a white halo', async () => {
  const image = raster(1, 1, () => [235, 235, 235, 255]);
  const options = { color: [255, 255, 255], tolerance: 10, feather: 20 };
  const soft = await removeBackground(image, { ...options, decontaminate: false }, immediate);
  const clean = await removeBackground(image, { ...options, decontaminate: true }, immediate);
  assert.equal(soft.data[3], 128);
  assert.equal(clean.data[3], 128);
  assert.equal(soft.data[0], 235);
  assert.equal(clean.data[0], 215);
});

test('removal multiplies rather than replaces existing partial alpha', async () => {
  const image = raster(1, 1, () => [235, 235, 235, 100]);
  const output = await removeBackground(image, { color: [255, 255, 255], tolerance: 10, feather: 20 }, immediate);
  assert.deepEqual(Array.from(output.data), [235, 235, 235, 50]);
});

test('reports a fully removed image and an unmatched key without fake success', async () => {
  const empty = await removeBackground(raster(3, 3), key, immediate);
  assert.equal(empty.visiblePixels, 0);
  assert.equal(empty.changedPixels, 9);
  const unchanged = await removeBackground(raster(3, 3, () => ink), key, immediate);
  assert.equal(unchanged.visiblePixels, 9);
  assert.equal(unchanged.changedPixels, 0);
});

test('transparent border pixels allow a manually selected background to flood inward', async () => {
  const image = raster(5, 5, (x, y) => x === 0 || y === 0 || x === 4 || y === 4 ? [0, 0, 0, 0] : x === 2 && y === 2 ? ink : paper);
  const output = await removeBackground(image, key, immediate);
  assert.equal(output.visiblePixels, 1);
  assert.deepEqual(pixelAt(output, 2, 2), ink);
});

test('large jobs yield and cancel obsolete previews', async () => {
  let cancelled = false;
  let yields = 0;
  await assert.rejects(removeBackground(raster(512, 512), key, {
    cancelled: () => cancelled,
    yieldControl: async () => { yields++; cancelled = true; },
  }), error => error.name === 'AbortError');
  assert.equal(yields, 1);
});

test('rejects malformed dimensions and options', async () => {
  await assert.rejects(removeBackground({ width: 2, height: 1, data: new Uint8ClampedArray(4) }, key), /dimensions/);
  await assert.rejects(removeBackground(raster(1, 1), { color: [NaN, 0, 0] }), /options/);
});
