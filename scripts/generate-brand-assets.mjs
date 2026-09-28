import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { canonicalizeIcns } from './icns-container.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'assets', 'brand', 'source');
const SOURCE_SVG = path.join(ROOT_DIR, 'design-system/packages/ui/src/brand/assets/openbitfun-mark.svg');
const SOURCE_APP_MARK = path.join(ROOT_DIR, 'design-system/packages/ui/src/brand/assets/openbitfun-app-mark.png');
const SOURCE_MARKS = {
  dark: path.join(SOURCE_DIR, 'openbitfun-mark-dark.png'),
  light: path.join(SOURCE_DIR, 'openbitfun-mark-light.png'),
};

const BRAND_SIZE = 512;
const APP_ICON_SIZE = 1024;
const APP_ICON_CORNER_RADIUS = 96;
const APP_MARK_LIFT = 28;
const ANDROID_FOREGROUND_SCALE = 0.66;

const ANDROID_DENSITIES = {
  mdpi: { icon: 48, adaptive: 108 },
  hdpi: { icon: 72, adaptive: 162 },
  xhdpi: { icon: 96, adaptive: 216 },
  xxhdpi: { icon: 144, adaptive: 324 },
  xxxhdpi: { icon: 192, adaptive: 432 },
};

const DESKTOP_HICOLOR_SIZES = [16, 32, 48, 64, 96, 128, 256, 512];
const EXPORT_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024, 2048];

const LEGACY_APPLICATION_ASSETS = [
  'src/apps/desktop/icons/Logo-ICON.png',
  'src/apps/desktop/icons/icon.png',
  'src/apps/desktop/icons/icon.ico',
  'src/apps/desktop/icons/icon.icns',
  'src/apps/desktop/icons/openbitfun-tray-template.png',
  'src/apps/desktop/icons/Square30x30Logo.png',
  'src/apps/desktop/icons/Square44x44Logo.png',
  'src/apps/desktop/icons/Square71x71Logo.png',
  'src/apps/desktop/icons/Square89x89Logo.png',
  'src/apps/desktop/icons/Square107x107Logo.png',
  'src/apps/desktop/icons/Square142x142Logo.png',
  'src/apps/desktop/icons/Square150x150Logo.png',
  'src/apps/desktop/icons/Square284x284Logo.png',
  'src/apps/desktop/icons/Square310x310Logo.png',
  'src/apps/desktop/icons/StoreLogo.png',
  'src/web-ui/public/Logo-ICON.png',
  'src/web-ui/public/Logo-ICON-128.png',
  'src/web-ui/public/OpenBitFun-Logo.png',
  'src/mobile-web/src/assets/Logo-ICON.png',
  'OpenBitFun-Installer/src/Logo-ICON.png',
  'OpenBitFun-Installer/src-tauri/icons/icon.png',
  'OpenBitFun-Installer/src-tauri/icons/icon.ico',
  'OpenBitFun-Installer/src-tauri/icons/icon.icns',
  'src/apps/mobile/harmonyos/AppScope/resources/base/media/openbitfun_icon.png',
  'src/apps/mobile/harmonyos/AppScope/resources/base/media/openbitfun-app-icon.png',
  'src/apps/mobile/harmonyos/AppScope/resources/base/media/background.png',
  'src/apps/mobile/harmonyos/AppScope/resources/base/media/foreground.png',
  'src/apps/mobile/harmonyos/AppScope/resources/base/media/layered_image.json',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/openbitfun_icon.png',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/openbitfun-app-icon.png',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/openbitfun-start-window.png',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/background.png',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/foreground.png',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/layered_image.json',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/media/startIcon.png',
  'src/apps/mobile/ios/OpenBitFun/Resources.xcassets/AppIcon.appiconset/openbitfun_icon.png',
  'src/apps/mobile/ios/OpenBitFun/Resources.xcassets/OpenBitFunLogo.imageset',
  'src/apps/relay-server/static/assets/Logo-ICON-BOaKcXgO.png',
];

const outputPath = (...segments) => path.join(ROOT_DIR, ...segments);

async function writePng(filePath, buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
}

function createReusableWebMark(svg) {
  const reusableMark = svg.replaceAll('stroke="black"', 'stroke="currentColor"');
  if (!reusableMark.includes('stroke="currentColor"')) {
    throw new Error('OpenBitFun mark source is missing its canonical inherited-color strokes');
  }
  return reusableMark;
}

async function normalizePng(input) {
  return sharp(input)
    .ensureAlpha()
    .resize({ width: BRAND_SIZE, height: BRAND_SIZE, fit: 'contain', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function renderMark(svg, size, tone, opticalSize = size) {
  // At favicon sizes, fifteen subpixel strokes disappear. Keep the same
  // silhouette with fewer filaments. The opaque outer rim must survive
  // antialiasing independently of the decorative interior strokes.
  const indices = opticalSize <= 24 ? [0, 7, 14]
    : opticalSize <= 48 ? [0, 3, 7, 11, 14]
      : opticalSize <= 96 ? [0, 2, 4, 7, 10, 12, 14] : null;
  let index = 0;
  const reusableMark = createReusableWebMark(svg);
  const artwork = indices ? reusableMark.replace(/<path\b[^>]*\/>/g, element => {
    const contour = index++;
    if (!indices.includes(contour)) return '';
    const outer = contour === 14;
    const inner = contour === 0;
    const width = Math.max(outer ? 3.2 : inner ? 1.2 : 0.7,
      (outer ? 1.35 : inner ? 0.85 : 0.65) * 256 / opticalSize);
    return element.replace(/ (?:stroke-width|opacity)="[^"]*"/g, '')
      .replace('/>', ` stroke-width="${width}" opacity="${outer ? 1 : inner ? 0.9 : 0.75}"/>`);
  }) : reusableMark;
  return sharp(Buffer.from(artwork.replaceAll('currentColor', tone)), { density: 144 })
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function resizePng(input, size) {
  return sharp(input)
    .resize({ width: size, height: size, fit: 'contain', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function createApplicationMark(lightMark) {
  const { data, info } = await sharp(lightMark)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const whiteMark = Buffer.alloc(data.length);

  for (let index = 0; index < data.length; index += channels) {
    const sourceTone = data[index];
    const liftedTone = Math.min(255, sourceTone + APP_MARK_LIFT);
    whiteMark[index] = liftedTone;
    whiteMark[index + 1] = liftedTone;
    whiteMark[index + 2] = liftedTone;
    whiteMark[index + 3] = data[index + 3];
  }

  return sharp(whiteMark, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function createApplicationIcon(applicationMark) {
  const { width: size } = await sharp(applicationMark).metadata();
  const cornerRadius = APP_ICON_CORNER_RADIUS * size / BRAND_SIZE;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" rx="${cornerRadius}" fill="#000000"/>` +
    '</svg>',
  );

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: background },
      { input: applicationMark },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function createAdaptiveForeground(applicationMark, size) {
  const artworkSize = Math.round(size * ANDROID_FOREGROUND_SCALE);
  const artwork = await resizePng(applicationMark, artworkSize);

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .composite([{
      input: artwork,
      left: Math.floor((size - artworkSize) / 2),
      top: Math.floor((size - artworkSize) / 2),
    }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function generateTauriContainers(applicationIcon, renderIcon) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-tauri-icons-'));
  const inputPath = path.join(tempDir, 'openbitfun-app-icon.png');
  const tauriCliPath = path.join(ROOT_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

  try {
    await writeFile(inputPath, applicationIcon);
    execFileSync(
      process.execPath,
      [tauriCliPath, 'icon', inputPath, '--output', tempDir],
      { cwd: ROOT_DIR, stdio: 'ignore', windowsHide: true },
    );

    // Keep Tauri's directory metadata, but rasterize each Windows size from
    // the canonical application artwork so the container matches the exports.
    const icoTemplate = await readFile(path.join(tempDir, 'icon.ico'));
    const frameCount = icoTemplate.readUInt16LE(4);
    const icoDirectory = Buffer.from(icoTemplate.subarray(0, 6 + frameCount * 16));
    const icoFrames = [];
    let icoOffset = icoDirectory.length;
    for (let index = 0; index < frameCount; index++) {
      const entry = 6 + index * 16;
      const size = icoDirectory[entry] || 256;
      const png = await renderIcon(size);
      icoDirectory.writeUInt32LE(png.length, entry + 8);
      icoDirectory.writeUInt32LE(icoOffset, entry + 12);
      icoFrames.push(png);
      icoOffset += png.length;
    }

    // Let Tauri encode legacy RGB/mask chunks from the same application
    // artwork; modern PNG representations use the matching exported sizes.
    const icnsTemplate = await readFile(path.join(tempDir, 'icon.icns'));
    const legacyChunks = new Map();
    for (const [size, types] of [[16, ['is32', 's8mk']], [32, ['il32', 'l8mk']]]) {
      const smallInput = path.join(tempDir, `input-${size}.png`);
      const smallOutput = path.join(tempDir, `legacy-${size}`);
      await writeFile(smallInput, await renderIcon(size));
      execFileSync(process.execPath,
        [tauriCliPath, 'icon', smallInput, '--output', smallOutput],
        { cwd: ROOT_DIR, stdio: 'ignore', windowsHide: true });
      const smallIcns = await readFile(path.join(smallOutput, 'icon.icns'));
      for (let offset = 8; offset < smallIcns.length;) {
        const length = smallIcns.readUInt32BE(offset + 4);
        const type = smallIcns.toString('ascii', offset, offset + 4);
        if (types.includes(type)) legacyChunks.set(type, smallIcns.subarray(offset, offset + length));
        offset += length;
      }
    }
    const icnsChunks = [];
    for (let offset = 8; offset < icnsTemplate.length;) {
      const length = icnsTemplate.readUInt32BE(offset + 4);
      const chunk = icnsTemplate.subarray(offset, offset + length);
      if (chunk.subarray(8, 16).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        const { width } = await sharp(chunk.subarray(8)).metadata();
        const png = await renderIcon(width);
        const header = Buffer.from(chunk.subarray(0, 8));
        header.writeUInt32BE(png.length + 8, 4);
        icnsChunks.push(Buffer.concat([header, png]));
      } else {
        icnsChunks.push(legacyChunks.get(chunk.toString('ascii', 0, 4)) ?? chunk);
      }
      offset += length;
    }
    const icnsHeader = Buffer.from(icnsTemplate.subarray(0, 8));
    icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    return {
      ico: Buffer.concat([icoDirectory, ...icoFrames]),
      icns: canonicalizeIcns(Buffer.concat([icnsHeader, ...icnsChunks])),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function removeLegacyApplicationAssets() {
  await Promise.all(
    LEGACY_APPLICATION_ASSETS.map(relativePath =>
      rm(outputPath(...relativePath.split('/')), { recursive: true, force: true })),
  );
}

async function generateBrandAssets() {
  const svg = await readFile(SOURCE_SVG, 'utf8');
  const [darkMark, lightMark, applicationSourceMark] = await Promise.all([
    renderMark(svg, BRAND_SIZE, '#202020'),
    renderMark(svg, BRAND_SIZE, '#e8e8e8'),
    normalizePng(SOURCE_APP_MARK),
  ]);
  await writePng(SOURCE_MARKS.dark, darkMark);
  await writePng(SOURCE_MARKS.light, lightMark);
  const applicationMark = await createApplicationMark(applicationSourceMark);
  const applicationIcon = await createApplicationIcon(applicationMark);
  const applicationIconLarge = await resizePng(applicationIcon, APP_ICON_SIZE);
  const darkMarkSmall = await renderMark(svg, 128, '#202020');
  const lightMarkSmall = await renderMark(svg, 128, '#e8e8e8');
  const iconCache = new Map([
    [BRAND_SIZE, Promise.resolve(applicationIcon)],
    [APP_ICON_SIZE, Promise.resolve(applicationIconLarge)],
  ]);
  const renderIcon = size => {
    if (!iconCache.has(size)) {
      iconCache.set(size, resizePng(applicationIcon, size));
    }
    return iconCache.get(size);
  };
  const tauriContainers = await generateTauriContainers(applicationIconLarge, renderIcon);

  const exportDir = outputPath('assets', 'brand', 'exports');
  await mkdir(exportDir, { recursive: true });
  await copyFile(SOURCE_SVG, path.join(exportDir, 'openbitfun-mark.svg'));
  const legacySourceDir = outputPath('assets', 'brand', 'source');
  await mkdir(legacySourceDir, { recursive: true });
  await copyFile(SOURCE_SVG, path.join(legacySourceDir, 'openbitfun-mark.svg'));
  await copyFile(SOURCE_APP_MARK, path.join(legacySourceDir, 'openbitfun-app-mark.png'));
  const componentAssetDir = outputPath('design-system', 'packages', 'ui', 'src', 'brand', 'assets');
  await mkdir(componentAssetDir, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await writePng(path.join(componentAssetDir, `openbitfun-app-icon-${size}.png`), await renderIcon(size));
  }
  for (const size of EXPORT_SIZES) {
    const dark = await renderMark(svg, size, '#202020');
    const light = await renderMark(svg, size, '#e8e8e8');
    await writePng(path.join(exportDir, `openbitfun-mark-dark-${size}.png`), dark);
    await writePng(path.join(exportDir, `openbitfun-mark-light-${size}.png`), light);
    await writePng(
      path.join(exportDir, `openbitfun-app-icon-${size}.png`),
      await renderIcon(size),
    );
  }
  await writeFile(path.join(exportDir, 'openbitfun-app-icon.ico'), tauriContainers.ico);
  await writeFile(path.join(exportDir, 'openbitfun-app-icon.icns'), tauriContainers.icns);

  await writePng(outputPath('src', 'miniapp-market-web', 'public', 'assets', 'openbitfun-email-mark.png'), darkMarkSmall);

  await writePng(outputPath('src', 'miniapp-market-web', 'public', 'assets', 'openbitfun-email-app-icon.png'), applicationIcon);

  await writePng(outputPath('src', 'crates', 'services', 'miniapp-market-service', 'src', 'email', 'app-icon.png'), applicationIcon);

  const webBrandDir = outputPath('src', 'web-ui', 'public', 'brand');
  await writePng(path.join(webBrandDir, 'openbitfun-mark-dark.png'), darkMark);
  await writePng(path.join(webBrandDir, 'openbitfun-mark-light.png'), lightMark);
  await writePng(path.join(webBrandDir, 'openbitfun-mark-dark-128.png'), darkMarkSmall);
  await writePng(path.join(webBrandDir, 'openbitfun-mark-light-128.png'), lightMarkSmall);
  await writePng(path.join(webBrandDir, 'openbitfun-app-icon.png'), applicationIcon);
  await writeFile(path.join(webBrandDir, 'openbitfun-mark.svg'), createReusableWebMark(svg), 'utf8');

  const desktopIconDir = outputPath('src', 'apps', 'desktop', 'icons');
  await writePng(path.join(desktopIconDir, 'openbitfun-app-icon.png'), applicationIconLarge);
  await writePng(path.join(desktopIconDir, 'openbitfun-app-icon.ico'), tauriContainers.ico);
  await writePng(path.join(desktopIconDir, 'openbitfun-app-icon.icns'), tauriContainers.icns);
  for (const size of DESKTOP_HICOLOR_SIZES) {
    const icon = await renderIcon(size);
    await writePng(
      outputPath('src', 'apps', 'desktop', 'icons', 'hicolor', `${size}x${size}`, 'apps', 'openbitfun-desktop.png'),
      icon,
    );
  }

  const mobileWebAssetDir = outputPath('src', 'mobile-web', 'src', 'assets');
  await writePng(path.join(mobileWebAssetDir, 'openbitfun-mark-dark.png'), darkMark);
  await writePng(path.join(mobileWebAssetDir, 'openbitfun-mark-light.png'), lightMark);
  await writePng(
    outputPath('src', 'mobile-web', 'public', 'brand', 'openbitfun-app-icon.png'),
    applicationIcon,
  );
  await writePng(
    outputPath('src', 'apps', 'relay-server', 'static', 'brand', 'openbitfun-app-icon.png'),
    applicationIcon,
  );

  const installerBrandDir = outputPath('OpenBitFun-Installer', 'src', 'assets');
  await writePng(path.join(installerBrandDir, 'openbitfun-mark-dark.png'), darkMark);
  await writePng(path.join(installerBrandDir, 'openbitfun-mark-light.png'), lightMark);
  await writePng(path.join(installerBrandDir, 'openbitfun-app-icon.png'), applicationIcon);
  const installerIconDir = outputPath('OpenBitFun-Installer', 'src-tauri', 'icons');
  await writePng(path.join(installerIconDir, 'openbitfun-app-icon.png'), applicationIconLarge);
  await writePng(path.join(installerIconDir, 'openbitfun-app-icon.ico'), tauriContainers.ico);
  await writePng(path.join(installerIconDir, 'openbitfun-app-icon.icns'), tauriContainers.icns);

  for (const directory of [webBrandDir, installerBrandDir,
    outputPath('src', 'mobile-web', 'public', 'brand'),
    outputPath('src', 'apps', 'relay-server', 'static', 'brand')]) {
    for (const size of [16, 32]) {
      await writePng(path.join(directory, `openbitfun-app-icon-${size}.png`), await renderIcon(size));
    }
  }

  for (const [density, sizes] of Object.entries(ANDROID_DENSITIES)) {
    const legacyIcon = await renderIcon(sizes.icon);
    const adaptiveForeground = await createAdaptiveForeground(applicationMark, sizes.adaptive);
    const androidDir = outputPath('src', 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
    await writePng(path.join(androidDir, 'ic_launcher.png'), legacyIcon);
    await writePng(path.join(androidDir, 'ic_launcher_round.png'), legacyIcon);
    await writePng(path.join(androidDir, 'ic_launcher_foreground.png'), adaptiveForeground);
    await writePng(path.join(androidDir, 'ic_launcher_monochrome.png'), adaptiveForeground);
  }

  await writePng(
    outputPath('src', 'apps', 'mobile', 'ios', 'OpenBitFun', 'Resources.xcassets', 'AppIcon.appiconset', 'openbitfun-app-icon.png'),
    // App Store icons must be opaque; iOS applies its own corner mask.
    await sharp(applicationIconLarge).flatten({ background: '#000000' }).png().toBuffer(),
  );
  await writePng(
    outputPath('src', 'apps', 'mobile', 'ios', 'OpenBitFun', 'Resources.xcassets', 'OpenBitFunMark.imageset', 'openbitfun-mark-light.png'),
    lightMark,
  );

  await writePng(
    outputPath('src', 'apps', 'mobile', 'harmonyos', 'AppScope', 'resources', 'base', 'media', 'openbitfun_app_icon.png'),
    applicationIconLarge,
  );
  await writePng(
    outputPath('src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'resources', 'base', 'media', 'openbitfun_app_icon.png'),
    applicationIconLarge,
  );
  await writePng(
    outputPath('src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'resources', 'base', 'media', 'openbitfun_start_window.png'),
    await resizePng(lightMark, 144),
  );

  await removeLegacyApplicationAssets();

  console.log('Generated OpenBitFun application brand assets.');
}

await generateBrandAssets();
