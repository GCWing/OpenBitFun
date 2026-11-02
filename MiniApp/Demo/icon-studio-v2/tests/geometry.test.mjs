import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ Uint8Array, Uint32Array, setTimeout });
for (const name of ['geometry', 'trace']) vm.runInContext(fs.readFileSync(new URL(`../source/ui/${name}.js`, import.meta.url), 'utf8'), context);
const G = context.IconGeometry, T = context.IconTrace;
const plain = value => JSON.parse(JSON.stringify(value));
function raster(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const gray = [148, 148, 148, 255], paper = [248, 248, 248, 255], transparent = [0, 0, 0, 0];
function inside(contours, x, y) {
  let fill = false;
  for (const contour of contours) for (let i = 0, j = contour.nodes.length - 1; i < contour.nodes.length; j = i++) {
    const a = contour.nodes[i], b = contour.nodes[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) fill = !fill;
  }
  return fill;
}

test('traces gray-on-pale-gray raster as vector silhouettes with a real hole', async () => {
  const image = raster(16, 16, (x, y) => x >= 3 && x < 13 && y >= 3 && y < 13 && !(x >= 6 && x < 10 && y >= 6 && y < 10) ? gray : paper);
  const result = await T.trace(image, { minArea: 1, simplify: .25, smoothing: 0 });
  assert.equal(result.shape.fill, true); assert.equal(result.shape.stroke, false);
  assert.equal(result.shape.contours.length, 2);
  assert.equal(inside(result.shape.contours, 12, 12), false);
  assert.equal(inside(result.shape.contours, 6, 6), true);
  const svg = G.exportSVG({ name: 'logo', shapes: [result.shape] });
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /currentColor/);
  assert.doesNotMatch(svg, /<image|data:|<script|<pattern|<rect/);
});

test('tight opaque ring on transparent interior uses alpha instead of erasing the whole mark', async () => {
  const result = await T.trace(raster(8, 8, (x, y) => x === 0 || y === 0 || x === 7 || y === 7 ? [0, 0, 0, 255] : transparent), { minArea: 1, smoothing: 0 });
  assert.equal(result.alphaMode, true);
  assert.equal(result.shape.contours.length, 2);
  assert.equal(inside(result.shape.contours, 12, 12), false);
  assert.equal(inside(result.shape.contours, 1, 1), true);
});

test('diagonal contacts stay separate; evenodd fill matches every input pixel', async () => {
  const image = raster(6, 6, (x, y) => x > 0 && x < 5 && y > 0 && y < 5 && (x + y) % 2 ? gray : transparent);
  const result = await T.trace(image, { minArea: 1, simplify: 0, smoothing: 0 });
  assert.equal(result.shape.contours.length, 8);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    assert.equal(inside(result.shape.contours, (x + .5) * 4, (y + .5) * 4), image.data[(y * 6 + x) * 4 + 3] !== 0);
  }
});

test('simplification does not silently fill a tiny enclosed hole', async () => {
  const result = await T.trace(raster(16, 16, (x, y) => x >= 2 && x <= 13 && y >= 2 && y <= 13 && !(x === 8 && y === 8) ? gray : transparent), { minArea: 1, simplify: 4, smoothing: 0 });
  assert.equal(result.shape.contours.length, 2);
  assert.equal(inside(result.shape.contours, 12.75, 12.75), false);
});

test('noise filtering removes small islands without dropping main contours', async () => {
  const result = await T.trace(raster(12, 12, (x, y) => x >= 4 && x <= 8 && y >= 4 && y <= 8 || x === 1 && y === 1 ? gray : transparent), { minArea: 3, smoothing: 0 });
  assert.equal(result.shape.contours.length, 1);
  assert.equal(inside(result.shape.contours, 3, 3), false);
});

test('uniform backgrounds and cancelled work return explicit failures', async () => {
  const image = raster(4, 4, () => paper);
  await assert.rejects(T.trace(image), /noForeground/);
  await assert.rejects(T.trace(image, {}, () => true), /cancelled/);
  await assert.rejects(T.trace({ width: 1, height: 1, data: [] }), /invalidImage/);
});

test('straight-line insertion lands at the clicked location', () => {
  const shape = G.primitive('line', { x: 0, y: 0 }, { x: 24, y: 0 });
  const nearest = G.nearestSegment(shape, 6, 0);
  assert.equal(nearest.t, .25);
  G.splitSegment(shape.contours[0], nearest.index, nearest.t);
  assert.equal(shape.contours[0].nodes[1].x, 6);
});

test('de Casteljau insertion preserves the original cubic curve', () => {
  const a = { x: 2, y: 4, in: null, out: [3, 20] }, b = { x: 20, y: 8, in: [18, 1], out: null };
  const contour = { closed: false, nodes: [plain(a), plain(b)] };
  const split = .35;
  G.splitSegment(contour, 0, split);
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const expected = G.evaluate(a, b, t);
    const actual = t <= split ? G.evaluate(contour.nodes[0], contour.nodes[1], t / split) : G.evaluate(contour.nodes[1], contour.nodes[2], (t - split) / (1 - split));
    assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-9);
  }
});

test('moving anchors carries both handles, and transforms retain stroke weight', () => {
  const shape = G.primitive('ellipse', { x: 2, y: 4 }, { x: 20, y: 18 });
  const n = shape.contours[0].nodes[0], before = plain(n);
  G.moveNode(n, n.x + 1, n.y + 2);
  assert.deepEqual(plain(n.in), [before.in[0] + 1, before.in[1] + 2]);
  assert.deepEqual(plain(n.out), [before.out[0] + 1, before.out[1] + 2]);
  G.transform(shape, 2, 2, 3, 4);
  assert.equal(shape.width, 2);
  assert.match(G.pathData(shape), /C/);
});

test('legacy project defaults and current-project round trips preserve editable data', () => {
  const legacy = { schemaVersion: 1, name: 'old', shapes: [{ id: 'a', fill: true, contours: [{ closed: true, nodes: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 3 }] }] }] };
  const loaded = G.normalizeProject(legacy);
  assert.equal(loaded.release, '2.0.2'); assert.equal(loaded.shapes[0].width, 2);
  assert.equal(loaded.shapes[0].cap, 'round'); assert.equal(loaded.shapes[0].contours[0].nodes[0].in, null);
  assert.deepEqual(plain(G.normalizeProject(JSON.parse(JSON.stringify(loaded)))), plain(loaded));
  assert.equal(legacy.shapes[0].width, undefined);
});

test('untrusted projects reject invalid geometry and export names without executable markup', () => {
  assert.throws(() => G.normalizeProject({ schemaVersion: 20, shapes: [] }), /invalidProject/);
  const shape = G.primitive('rect', { x: 2, y: 2 }, { x: 20, y: 20 }); shape.id = 'valid';
  const project = { schemaVersion: 1, name: '\"><script>alert(1)</script>', shapes: [shape] };
  const loaded = G.normalizeProject(project);
  const svg = G.exportSVG(loaded);
  assert.doesNotMatch(svg, /<script/); assert.match(svg, /&lt;script&gt;/);
  project.shapes[0].contours[0].nodes[0].x = NaN;
  assert.throws(() => G.normalizeProject(project), /invalidProject/);
});
