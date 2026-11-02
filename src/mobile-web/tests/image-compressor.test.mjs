import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/services/imageCompressor.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { compressImageDataUrl } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function browserImages({ width = 100, height = 60, invalid = false, encode } = {}) {
  globalThis.Image = class {
    width = width;
    height = height;
    set src(_) { queueMicrotask(() => invalid ? this.onerror(new Error('decode failed')) : this.onload()); }
  };
  let draws = 0;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage: () => { draws += 1; } }),
      toDataURL(type, quality) { return encode?.(this.width, this.height, quality) ?? `data:${type};base64,YQ==`; },
    }),
  };
  return () => draws;
}

test('small supported screenshots retain original pixels', async () => {
  const draws = browserImages();
  const dataUrl = 'data:image/png;base64,YQ==';
  assert.deepEqual(await compressImageDataUrl(dataUrl, 'screen.png'), { dataUrl, name: 'screen.png' });
  assert.equal(draws(), 0);
});

test('small camera formats are decoded and converted instead of passed to providers', async () => {
  const draws = browserImages();
  const result = await compressImageDataUrl('data:image/heic;base64,YQ==', 'camera.heic');
  assert.equal(result.name, 'camera.jpg');
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(draws(), 1);
});

test('large dimensions and incompressible payloads keep shrinking until the wire budget fits', async () => {
  const sizes = [];
  browserImages({ width: 8000, height: 6000, encode(width, height) {
    sizes.push([width, height]);
    return 'data:image/jpeg;base64,' + (width > 1000 ? 'a'.repeat(2 * 1024 * 1024) : 'YQ==');
  } });
  const result = await compressImageDataUrl('data:image/png;base64,YQ==', 'screen.png');
  assert.equal(sizes[0][0], 1920);
  assert.ok(sizes.at(-1)[0] <= 1000);
  assert.ok(result.dataUrl.length < 1024 * 1024);
});

test('unreadable photos fail before upload instead of using raw bytes as a fallback', async () => {
  browserImages({ invalid: true });
  await assert.rejects(compressImageDataUrl('data:image/heic;base64,YQ==', 'camera.heic'));
});

const attachmentsSource = await readFile(
  new URL('../src/services/chatImageAttachments.ts', import.meta.url),
  'utf8',
);
const attachmentsCode = ts.transpileModule(attachmentsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  normalizeValidImageDataUrl,
  extractValidImageContexts,
  extractValidPendingImages,
} = await import(`data:text/javascript;base64,${Buffer.from(attachmentsCode).toString('base64')}`);

test('image data URLs must use canonical RFC 4648 base64', () => {
  assert.deepEqual(normalizeValidImageDataUrl('data:image/png;base64,YQ=='), {
    trimmedUrl: 'data:image/png;base64,YQ==',
    mimeType: 'image/png',
  });
  assert.deepEqual(normalizeValidImageDataUrl('  data:image/jpeg;base64,YWI=  '), {
    trimmedUrl: 'data:image/jpeg;base64,YWI=',
    mimeType: 'image/jpeg',
  });
  assert.equal(normalizeValidImageDataUrl('data:image/webp;base64,YWJj')?.mimeType, 'image/webp');
  assert.equal(normalizeValidImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+')?.mimeType, 'image/svg+xml');

  for (const invalid of [
    undefined,
    null,
    42,
    '',
    'data:image/png;base64,',
    'data:image/png;base64,YQ',
    'data:image/png;base64,YR==', // non-zero padding bits
    'data:image/png;base64,YQ=',
    'data:image/png;base64,Y Q==',
    'data:text/plain;base64,YQ==',
    'data:image/png,YQ==',
    'data:image/png;base64,YQ--',
  ]) {
    assert.equal(normalizeValidImageDataUrl(invalid), null, String(invalid));
  }
});

test('transcript images project into model contexts without corrupted entries', () => {
  const images = [
    { name: 'screen.png', data_url: 'data:image/png;base64,YQ==' },
    { name: '', data_url: ' data:image/jpeg;base64,YWI= ' },
    { name: 'broken.png', data_url: 'data:image/png;base64,YR==' },
    null,
    'not-an-object',
    { name: 'missing.png' },
  ];
  const contexts = extractValidImageContexts(images, 'mobile_edit');
  assert.deepEqual(contexts?.map(({ id, ...rest }) => rest), [
    {
      data_url: 'data:image/png;base64,YQ==',
      mime_type: 'image/png',
      metadata: { name: 'screen.png', source: 'remote' },
    },
    {
      data_url: 'data:image/jpeg;base64,YWI=',
      mime_type: 'image/jpeg',
      metadata: { name: 'image', source: 'remote' },
    },
  ]);
  assert.match(contexts[0].id, /^mobile_edit_\d+_0$/);
  assert.match(contexts[1].id, /^mobile_edit_\d+_1$/);
  assert.equal(extractValidImageContexts([], 'mobile_edit'), undefined);
  assert.equal(extractValidImageContexts([{ data_url: 'data:image/png;base64,YR==' }], 'x'), undefined);
});

test('rollback drafts restore only valid images', () => {
  assert.deepEqual(
    extractValidPendingImages([
      { name: 'screen.png', data_url: 'data:image/png;base64,YQ==' },
      { name: 'broken.png', data_url: 'data:image/png;base64,YR==' },
      null,
    ]),
    [{ name: 'screen.png', dataUrl: 'data:image/png;base64,YQ==' }],
  );
  assert.deepEqual(extractValidPendingImages(undefined), []);
  assert.deepEqual(extractValidPendingImages('not-an-array'), []);
});
