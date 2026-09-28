import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import sharp from 'sharp';
import { canonicalizeIcns } from './icns-container.mjs';

const GENERATED_ICNS_FILES = [
  'src/apps/desktop/icons/openbitfun-app-icon.icns',
  'OpenBitFun-Installer/src-tauri/icons/openbitfun-app-icon.icns',
];

const HARMONY_MEDIA_DIRS = [
  'src/apps/mobile/harmonyos/AppScope/resources/base/media',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media',
];

test('design-system brand masters and packaged icons agree with native projections', () => {
  const componentAssets = 'design-system/packages/ui/src/brand/assets';
  for (const master of ['openbitfun-mark.svg', 'openbitfun-app-mark.png']) {
    assert.deepEqual(readFileSync(`${componentAssets}/${master}`), readFileSync(`assets/brand/source/${master}`));
  }
  for (const size of [16, 32, 128, 256, 512]) {
    const name = `openbitfun-app-icon-${size}.png`;
    assert.deepEqual(readFileSync(`${componentAssets}/${name}`), readFileSync(`assets/brand/exports/${name}`));
  }
});

function createChunk(type, payload) {
  const chunk = Buffer.alloc(8 + payload.length);
  chunk.write(type, 0, 4, 'ascii');
  chunk.writeUInt32BE(chunk.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function createIcns(chunks) {
  const length = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(length, 4);
  return Buffer.concat([header, ...chunks], length);
}

test('ICNS canonicalization is independent of Tauri chunk order', () => {
  const chunks = [
    createChunk('ic10', Buffer.from('large')),
    createChunk('ic07', Buffer.from('small')),
    createChunk('s8mk', Buffer.from('mask')),
  ];
  const forward = canonicalizeIcns(createIcns(chunks));
  const reverse = canonicalizeIcns(createIcns([...chunks].reverse()));

  assert.deepEqual(forward, reverse);
  assert.deepEqual(canonicalizeIcns(forward), forward);
});

test('generated macOS icons use the canonical ICNS layout', () => {
  const [desktop, installer] = GENERATED_ICNS_FILES.map(filePath => readFileSync(filePath));

  assert.ok(desktop.equals(canonicalizeIcns(desktop)), 'desktop ICNS is not canonical');
  assert.ok(installer.equals(canonicalizeIcns(installer)), 'installer ICNS is not canonical');
  assert.ok(desktop.equals(installer), 'desktop and installer ICNS files differ');
});

test('application icons preserve the submitted artwork independently from the startup Logo', async () => {
  const applicationMark = readFileSync('assets/brand/source/openbitfun-app-mark.png');
  const startupMark = readFileSync('assets/brand/source/openbitfun-mark-light.png');
  const generatedIcon = readFileSync('assets/brand/exports/openbitfun-app-icon-512.png');

  assert.equal(
    createHash('sha256').update(applicationMark).digest('hex'),
    '6cda0b01d037ef552690d210a1e5adfa807a806d685a49f46d110b1e3765b5a0',
  );
  assert.equal(
    createHash('sha256').update(generatedIcon).digest('hex'),
    'df460c4a43d9a68e15bee7b23b0bb68f7b9e70c26c68158ef82e2d4fd9e6288f',
  );
  assert.notDeepEqual(applicationMark, startupMark);

  const metadata = await sharp(applicationMark).metadata();
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.hasAlpha, true);
});

test('iOS App Store icon is a 1024 pixel RGB image without alpha', async () => {
  const metadata = await sharp('src/apps/mobile/ios/OpenBitFun/Resources.xcassets/AppIcon.appiconset/openbitfun-app-icon.png').metadata();
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 1024);
  assert.equal(metadata.hasAlpha, false);
  assert.equal(metadata.channels, 3);
});

test('brand exports provide decodable transparent PNGs at every advertised size', async () => {
  const sizes = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024, 2048];
  for (const size of sizes) {
    for (const treatment of ['mark-dark', 'mark-light', 'app-icon']) {
      const image = sharp(`assets/brand/exports/openbitfun-${treatment}-${size}.png`);
      const metadata = await image.metadata();
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
      assert.equal(metadata.hasAlpha, true);
      const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
      // Tiny rounded-square icons can have partial edge coverage in the corner.
      assert.ok(data[info.channels - 1] <= 16, 'corner must remain transparent apart from antialiasing');
    }
  }
  assert.deepEqual(
    readFileSync('assets/brand/exports/openbitfun-mark.svg'),
    readFileSync('assets/brand/source/openbitfun-mark.svg'),
  );
});

test('Web UI exposes the canonical mark as a reusable currentColor vector asset', () => {
  const source = readFileSync('assets/brand/source/openbitfun-mark.svg', 'utf8');
  const webAsset = readFileSync('src/web-ui/public/brand/openbitfun-mark.svg', 'utf8');

  assert.equal(webAsset, source.replaceAll('stroke="black"', 'stroke="currentColor"'));
  assert.equal(webAsset.match(/<path\b/g)?.length, 15);
  assert.match(webAsset, /stroke="currentColor"/);
  assert.doesNotMatch(webAsset, /#[0-9a-f]{3,8}\b/i);
});

test('Windows ICO frames contain the size-specific app PNGs', async () => {
  const ico = readFileSync('src/apps/desktop/icons/openbitfun-app-icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [];
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length);
    const frame = ico.subarray(offset, offset + length);
    assert.deepEqual(frame, readFileSync(`assets/brand/exports/openbitfun-app-icon-${size}.png`));
    const metadata = await sharp(frame).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    sizes.push(size);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 256]);
  assert.deepEqual(ico, readFileSync('OpenBitFun-Installer/src-tauri/icons/openbitfun-app-icon.ico'));
});

test('small icons retain a bright rim around the entire silhouette', async () => {
  for (const size of [16, 24, 32, 48, 64]) {
    const { data, info } = await sharp(`assets/brand/exports/openbitfun-app-icon-${size}.png`)
      .raw().toBuffer({ resolveWithObject: true });
    const sectors = Array(12).fill(0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size - 0.5;
        const dy = (y + 0.5) / size - 0.5;
        const radius = Math.hypot(dx, dy);
        if (radius < 0.32 || radius > 0.44) continue;
        const sector = Math.floor((Math.atan2(dy, dx) + Math.PI) * 12 / (2 * Math.PI)) % 12;
        sectors[sector] = Math.max(sectors[sector], data[(y * size + x) * info.channels]);
      }
    }
    assert.ok(sectors.every(value => value >= 200), `${size}px rim has a dim sector: ${sectors}`);
  }
});

test('desktop tray uses a macOS template and the application icon on other platforms', () => {
  const source = readFileSync('src/apps/desktop/src/tray.rs', 'utf8');
  assert.match(source, /#\[cfg\(target_os = "macos"\)\]\s*let icon = macos_tray_icon\(\)\?/);
  assert.match(source, /#\[cfg\(not\(target_os = "macos"\)\)\]\s*let icon = app\s*\.default_window_icon\(\)/);
  assert.doesNotMatch(source, /openbitfun-tray-template/);
  assert.match(source, /\.icon_as_template\(cfg!\(target_os = "macos"\)\)/);
  // The unread badge is gone, so the mark is built once and never swapped:
  // nothing may re-apply the icon or write a numeric tray title afterwards.
  assert.doesNotMatch(source, /set_icon_with_as_template|set_title/);
});

test('browser entry points reference generated application favicons', () => {
  for (const [htmlPath, assetDir] of [
    ['src/web-ui/index.html', 'src/web-ui/public/brand'],
    ['src/mobile-web/index.html', 'src/mobile-web/public/brand'],
    ['src/apps/relay-server/static/index.html', 'src/apps/relay-server/static/brand'],
    ['OpenBitFun-Installer/index.html', 'OpenBitFun-Installer/src/assets'],
  ]) {
    const html = readFileSync(htmlPath, 'utf8');
    for (const size of [16, 32]) {
      assert.ok(html.includes(`sizes="${size}x${size}"`));
      const name = `openbitfun-app-icon-${size}.png`;
      assert.ok(html.includes(name));
      assert.deepEqual(readFileSync(`${assetDir}/${name}`), readFileSync(`assets/brand/exports/${name}`));
    }
  }
});

test('HarmonyOS generated media use valid resource identifiers', () => {
  for (const directory of HARMONY_MEDIA_DIRS) {
    for (const fileName of readdirSync(directory)) {
      const resourceName = fileName.replace(/\.[^.]+$/, '');
      assert.match(
        resourceName,
        /^[a-zA-Z0-9_]+$/,
        `${directory}/${fileName} is not a valid HarmonyOS resource name`,
      );
    }
  }

  const appConfig = readFileSync('src/apps/mobile/harmonyos/AppScope/app.json5', 'utf8');
  const moduleConfig = readFileSync('src/apps/mobile/harmonyos/entry/src/main/module.json5', 'utf8');
  assert.match(appConfig, /\$media:openbitfun_app_icon/);
  assert.match(moduleConfig, /\$media:openbitfun_app_icon/);
  assert.match(moduleConfig, /\$media:openbitfun_start_window/);
});

test('ICNS canonicalization rejects malformed containers', () => {
  assert.throws(
    () => canonicalizeIcns(Buffer.from('not-an-icns')),
    /Invalid ICNS header/,
  );

  const truncated = createIcns([createChunk('ic07', Buffer.from('small'))]).subarray(0, -1);
  assert.throws(() => canonicalizeIcns(truncated), /Invalid ICNS length/);
});

test('verification email reuses the current mark and the OpenBitFun reference palette', () => {
  const emailMark = readFileSync('src/miniapp-market-web/public/assets/openbitfun-email-app-icon.png');
  assert.deepEqual(emailMark, readFileSync('src/web-ui/public/brand/openbitfun-app-icon.png'));
  assert.deepEqual(emailMark, readFileSync('src/crates/services/miniapp-market-service/src/email/app-icon.png'));
  const html = readFileSync('src/crates/services/miniapp-market-service/src/email/sign-in.html', 'utf8');
  const tokens = JSON.parse(readFileSync('design-system/packages/theme-openbitfun/src/reference.tokens.json', 'utf8'));
  const palette = new Set([...Object.values(tokens.ref.color.neutral), ...Object.values(tokens.ref.color.cyan)]
    .map(token => token?.$value).filter(Boolean));
  for (const [color] of html.matchAll(/#[0-9a-f]{6}\b/g)) assert.ok(palette.has(color), `Email color ${color} must come from the existing neutral/cyan palette`);
  assert.match(html, /src="cid:openbitfun-app-icon"/);
  assert.doesNotMatch(html, /<script|<form|data:image|\?[^\s]*\{\{code\}\}/i);
});
