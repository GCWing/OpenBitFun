// @vitest-environment jsdom
import { browserFixtureFlags, cleanupBrowserFixture, rehostSkinImages } from './browser-fixture.test-support';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { VisualSkinSurfacePaint } from './VisualSkinSurfacePaint';
import { VisualSkinRuntime } from './runtime';
import { VisualSkinPackageParser } from './parser';
import type { StoredVisualSkin, VisualSkinPackage } from './types';

const paint = renderToStaticMarkup(createElement(VisualSkinSurfacePaint));
const styles = compile(resolve('src/app/layout/WorkspaceBody.scss')).css + compile(resolve('src/app/styles/visual-skin.scss')).css;
const browser = process.env.OPENBITFUN_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium',
].find(existsSync);
const runtimes: VisualSkinRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.dispose());
  document.body.innerHTML = '';
  document.head.querySelectorAll('style').forEach(node => node.remove());
  for (const name of ['data-color-scheme', 'data-contrast', 'data-openbitfun-skin-id']) document.documentElement.removeAttribute(name);
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const base: VisualSkinPackage = {
  manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'surface', name: 'Surface', version: '1' },
  modes: { light: {} },
};
async function activate(patch: Partial<VisualSkinPackage>) {
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({ ...base, ...patch })).buffer);
  const values = new Map<string, StoredVisualSkin>([['surface', skin]]);
  const runtime = new VisualSkinRuntime({
    list: async () => ({ skins: [skin], invalidRecords: [] }), get: async id => values.get(id) ?? null,
    put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {},
  });
  runtimes.push(runtime);
  await runtime.activate('surface');
  return runtime;
}

it('resolves complete surface profiles for light, dark and high contrast, removing superseded artwork', async () => {
  document.body.innerHTML = `<section id="surface" data-openbitfun-surface="empty-state">${paint}</section>`;
  const art = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const runtime = await activate({
    assets: { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: art } } },
    surfaces: [{ surface: 'empty-state', backgroundAssetId: 'art' }],
    modes: {
      light: { surfaces: [{ surface: 'empty-state', backgroundAssetId: 'art', backgroundOpacity: 0.7 }] },
      dark: { surfaces: [{ surface: 'empty-state', backgroundAssetId: 'art', backgroundOpacity: 0.9 }] },
      highContrastDark: { surfaces: [{ surface: 'empty-state', baseToken: 'color.surface.scene' }] },
    },
  });
  const target = document.getElementById('surface')!;
  const value = () => getComputedStyle(target).getPropertyValue('--openbitfun-skin-surface-background-opacity');
  expect(value()).toBe('0.7');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'surfaces[0]')?.status).toBe('inactive');
  document.documentElement.setAttribute('data-color-scheme', 'dark'); await tick();
  expect(value()).toBe('0.9');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'modes.light.surfaces[0]')?.status).toBe('inactive');
  document.documentElement.setAttribute('data-contrast', 'high'); await tick();
  expect(target.hasAttribute('data-openbitfun-skin-artwork')).toBe(false);
  expect(document.querySelector('style[data-openbitfun-skin-runtime]')?.textContent).not.toContain(art);
  document.documentElement.removeAttribute('data-contrast'); await tick();
  expect(value()).toBe('0.9');
});

it('validates mode-specific profiles and asset references through the production parser', async () => {
  const parser = new VisualSkinPackageParser();
  const parse = (surfaces: unknown) => parser.parse(new TextEncoder().encode(JSON.stringify({ ...base, modes: { light: { surfaces } } })).buffer);
  await expect(parse([{ surface: 'chat', backgroundAssetId: 'missing' }])).rejects.toThrow(/modes.light.surfaces\[0\].backgroundAssetId/);
  await expect(parse([{ surface: 'chat', backgroundOpacity: -1 }])).rejects.toThrow(/modes.light.surfaces\[0\].backgroundOpacity/);
  await expect(parse([{ surface: 'chat', tokens: { 'color.content.primary': 'red;display:none' } }])).rejects.toThrow();
});

it('places paint on the complete navigation and rounded workbench owners', () => {
  const workspace = readFileSync(resolve('src/app/layout/WorkspaceBody.tsx'), 'utf8');
  const nav = workspace.slice(workspace.indexOf('id={navId}'), workspace.indexOf('<TerminalActionBridge'));
  expect(nav).toMatch(/data-openbitfun-surface="navigation"/);
  expect(nav.indexOf('<VisualSkinSurfacePaint')).toBeLessThan(nav.indexOf('<NavBar'));
  const frame = workspace.slice(workspace.indexOf('className="openbitfun-workspace-body__scene-surface"'));
  expect(frame).toMatch(/data-openbitfun-surface="workbench-content"/);
  expect(frame.indexOf('<VisualSkinSurfacePaint')).toBeLessThan(frame.indexOf('<WorkbenchLayout'));
  expect(readFileSync(resolve('src/app/workbench/WorkbenchLayout.tsx'), 'utf8')).not.toContain('data-openbitfun-surface="workbench-content"');
  expect(readFileSync(resolve('src/app/components/NavPanel/NavPanel.tsx'), 'utf8')).not.toContain('data-openbitfun-surface="navigation"');
  expect(workspace.indexOf('data-openbitfun-surface-underlay="navigation"')).toBeGreaterThan(workspace.indexOf('data-openbitfun-part="sceneArea"'));
});

it.skipIf(!browser).each([
  ['light', '#145078', [20, 80, 120], false, 24],
  ['dark', '#b05a20', [176, 90, 32], false, 16],
  ['light', '#7030a0', [112, 48, 160], false, 24],
  ['light', '#145078', [20, 40, 60], true, 24], // undeclared navigation retains its opaque chrome base
  ['dark', '#308060', [48, 128, 96], false, 64],
] as const)('paints independent layers and shared corners for %s / %s', async (scheme, navColor, navPixels, ancestor, radiusSize) => {
  document.documentElement.setAttribute('data-color-scheme', scheme);
  document.body.innerHTML = `<main data-openbitfun-surface="workbench" style="--nav-width:80px;--openbitfun-layout-split-view-content-panel-radius:${radiusSize}px;position:relative;isolation:isolate;width:320px;height:160px;background:white">${paint}
    <nav id="nav" data-openbitfun-surface="navigation" style="position:absolute;width:80px;height:160px;z-index:3">${paint}<div id="menu" style="position:absolute;left:60px;top:120px;width:80px;height:20px;background:lime"></div></nav>
    <div class="openbitfun-workspace-body__scene-area" style="position:absolute;left:80px;width:240px;height:160px"><div class="openbitfun-workspace-body__corner-underlay" data-openbitfun-surface-underlay="navigation"></div><section id="frame" data-openbitfun-surface="workbench-content" style="position:absolute;left:0;width:240px;height:160px;border-radius:${radiusSize}px 0 0 ${radiusSize}px;overflow:hidden;z-index:1">${paint}
      <header class="openbitfun-scene-top-bar" style="height:40px;background:black"></header>
      <div class="openbitfun-scene-viewport" data-openbitfun-state="empty" style="height:120px;background:white"><div class="openbitfun-scene-viewport__scene openbitfun-scene-viewport__scene--empty" style="height:120px;background:white"><div class="welcome-scene" data-openbitfun-surface="empty-state" style="height:120px;background:white"></div></div></div>
      <div id="nested" data-openbitfun-surface="editor" style="position:absolute;left:120px;top:80px;width:30px;height:30px">${paint}</div>
    </section></div></main>`;
  const art = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="#dc5028" d="M0 0h10v10H0z"/></svg>');
  await activate({
    modes: { light: { tokens: { 'color.surface.chrome': '#14283c', 'color.surface.scene': '#14283c', 'color.surface.panel': '#abcdef', 'color.overlay.scrim': '#ffffff' } }, dark: { tokens: { 'color.surface.chrome': '#14283c', 'color.surface.scene': '#14283c', 'color.surface.panel': '#abcdef', 'color.overlay.scrim': '#ffffff' } } },
    assets: { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: art } } },
    surfaces: ancestor ? [{ surface: 'workbench', baseToken: 'color.surface.scene', backgroundAssetId: 'art', backgroundOpacity: 0.5, scrimToken: 'color.overlay.scrim', scrimOpacity: 0.25 }] : [
      { surface: 'navigation', tokens: { 'color.surface.chrome': navColor } },
      { surface: 'workbench-content', baseToken: 'color.surface.scene', backgroundAssetId: 'art', backgroundOpacity: 0.5, scrimToken: 'color.overlay.scrim', scrimOpacity: 0.25 },
      { surface: 'editor', baseToken: 'color.surface.panel', scrimToken: 'color.overlay.scrim' },
    ],
  });
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-surface-'));
  try {
    const file = resolve(scratch, 'surface.html'); const screenshot = resolve(scratch, 'surface.png');
    writeFileSync(file, `<!doctype html><html data-openbitfun-skin-id="surface"><head><style>body{margin:0}#frame::after{content:'';position:absolute;left:180px;top:140px;width:20px;height:20px;background:magenta}${styles}</style>${rehostSkinImages(document.head.innerHTML, runtimes.at(-1)!.getSnapshot().activeSkin)}</head><body>${document.body.innerHTML}</body></html>`);
    execFileSync(browser!, [...browserFixtureFlags(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${resolve(scratch, 'profile')}`, '--window-size=400,300', '--force-device-scale-factor=1', '--virtual-time-budget=1000', `--screenshot=${screenshot}`, pathToFileURL(file).href], { windowsHide: true, timeout: 20000, stdio: 'pipe' });
    const { data, info } = await sharp(readFileSync(screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    pixel(10, 20).forEach((channel, i) => expect(Math.abs(channel - navPixels[i])).toBeLessThanOrEqual(2));
    pixel(80, 0).forEach((channel, i) => expect(Math.abs(channel - navPixels[i])).toBeLessThanOrEqual(2)); // outside the scene curve: navigation's own base
    pixel(85, 5).forEach((channel, i) => expect(Math.abs(channel - (radiusSize === 16 ? [154, 109, 101] : navPixels)[i])).toBeLessThanOrEqual(2)); // explicit 16px radius vs preserved 24px product radius
    if (radiusSize === 64) expect(pixel(110, 0)).toEqual(navPixels); // underlay follows a radius larger than the default
    for (const [x, y] of [[140, 15], [140, 100]]) {
      pixel(x, y).forEach((channel, i) => expect(Math.abs(channel - [154,109,101][i])).toBeLessThanOrEqual(2));
    }
    pixel(210, 90).forEach((channel, i) => expect(Math.abs(channel - (ancestor ? [154, 109, 101] : [171, 205, 239])[i])).toBeLessThanOrEqual(2)); // nested surface, no inherited art/scrim
    expect(pixel(100, 130)).toEqual([0, 255, 0]); // navigation menu escapes the paint clip
    expect(pixel(270, 150)).toEqual([255, 0, 255]); // existing component pseudo-element survives
  } finally {
    await cleanupBrowserFixture(scratch);
  }
}, 30000);


it.skipIf(!browser).each(['light', 'dark'] as const)('shares one shell image across chrome, navigation and scene in %s mode', async mode => {
  document.documentElement.setAttribute('data-color-scheme', mode);
  document.body.innerHTML = `<main data-openbitfun-surface="shell" style="position:relative;width:400px;height:240px">${paint}
    <div class="openbitfun-workspace-body" data-openbitfun-surface="workbench" style="--nav-width:80px;--openbitfun-layout-split-view-content-panel-radius:24px;width:400px;height:240px;background:white">${paint}
        <nav data-openbitfun-surface="navigation" style="position:absolute;width:80px;height:240px">${paint}</nav>
      <div class="openbitfun-workspace-body__scene-area" style="position:absolute;left:80px;width:320px;height:240px"><div class="openbitfun-workspace-body__corner-underlay" data-openbitfun-surface-underlay="navigation"></div><section data-openbitfun-surface="workbench-content" style="position:absolute;left:0;top:0;width:320px;height:240px;border-radius:24px 0 0 24px;overflow:hidden;background:white">${paint}
        <header class="openbitfun-scene-top-bar" style="height:40px;background:white"></header>
        <div class="openbitfun-scene-viewport" data-openbitfun-state="empty" style="height:200px;background:white"><div class="openbitfun-scene-viewport__scene openbitfun-scene-viewport__scene--empty" style="height:200px;background:white"><div class="welcome-scene" data-openbitfun-surface="empty-state" style="height:200px;background:white">${paint}</div></div></div>
      </section></div>
      <div style="position:absolute;left:270px;top:200px;width:20px;height:20px;background:lime"></div>
    </div></main>`;
  const art = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><path fill="#c82850" d="M0 0h200v240H0z"/><path fill="#1464c8" d="M200 0h200v240H200z"/></svg>');
  const navBase = mode === 'light' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
  await activate({ modes: { light: { tokens: { 'color.surface.chrome': '#ffffff' } }, dark: { tokens: { 'color.surface.chrome': '#ffffff' } } }, assets: { art: { mimeType:'image/svg+xml',source:{kind:'data',data:art} } }, surfaces: [
    {surface:'shell',backgroundAssetId:'art',fit:'fill'},
    {surface:'navigation',backgroundSource:'shell',tokens:{'color.surface.chrome':navBase}},
  ] });
  const scratch=mkdtempSync(resolve(tmpdir(),'skin-whole-window-'));
  try {
    const file=resolve(scratch,'whole.html'), screenshot=resolve(scratch,'whole.png');
    writeFileSync(file,`<!doctype html><html data-openbitfun-skin-id="surface"><head><style>body{margin:0}${styles}</style>${rehostSkinImages(document.head.innerHTML, runtimes.at(-1)!.getSnapshot().activeSkin)}</head><body>${document.body.innerHTML}</body></html>`);
    execFileSync(browser!,[...browserFixtureFlags(), '--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run',`--user-data-dir=${resolve(scratch,'profile')}`,'--window-size=500,400','--force-device-scale-factor=1','--virtual-time-budget=500',`--screenshot=${screenshot}`,pathToFileURL(file).href],{windowsHide:true,timeout:20000,stdio:'pipe'});
    const {data,info}=await sharp(readFileSync(screenshot)).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
    const close=(value:number[],expected:number[])=>value.forEach((v,i)=>expect(Math.abs(v-expected[i])).toBeLessThanOrEqual(2));
    const tinted = mode === 'light' ? [214,94,124] : [150,30,60];
    close(pixel(10,20),tinted); // navigation tint is applied exactly once
    close(pixel(80,0),tinted); // its material continues behind the exposed scene curve
    close(pixel(120,20),[200,40,80]); // landing toolbar shares the same wallpaper origin
    close(pixel(120,100),[200,40,80]);
    close(pixel(81,120),[200,40,80]); // no tinted strip inside the transparent frame
    close(pixel(230,100),[20,100,200]); // image origin does not restart in the main area
    expect(pixel(275,205)).toEqual([0,255,0]); // content controls retain their own fill
  } finally { await cleanupBrowserFixture(scratch); }
},30000);

it.skipIf(!browser).each([0, 80, 140])('keeps corner paint on the actual scene edge at nav width %ipx', async navWidth => {
  document.body.innerHTML = `<main class="openbitfun-workspace-body" data-openbitfun-surface="workbench" style="width:400px;height:200px;--nav-width:300px;--openbitfun-layout-split-view-content-panel-radius:24px;background:#cc2850">
    <nav class="openbitfun-workspace-body__nav-area${navWidth === 0 ? ' is-collapsed' : ''}" data-openbitfun-surface="navigation" style="--nav-width:${navWidth}px">${paint}</nav>
    <div class="openbitfun-workspace-body__scene-area"><div class="openbitfun-workspace-body__corner-underlay" data-openbitfun-surface-underlay="navigation"></div><section class="openbitfun-workspace-body__scene-surface" data-openbitfun-surface="workbench-content">${paint}<div class="openbitfun-scene-viewport" data-openbitfun-state="empty"></div></section></div></main>`;
  await activate({ modes: { light: { tokens: { 'color.surface.chrome': '#145078' } } }, surfaces: [{ surface: 'navigation' }] });
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-collapsed-corners-'));
  try {
    const file = resolve(scratch, 'corner.html'), screenshot = resolve(scratch, 'corner.png');
    writeFileSync(file, `<!doctype html><html data-openbitfun-skin-id="surface"><head><style>body{margin:0}${styles}.openbitfun-workspace-body__scene-surface{background:transparent!important;box-shadow:none}</style>${rehostSkinImages(document.head.innerHTML, runtimes.at(-1)!.getSnapshot().activeSkin)}</head><body>${document.body.innerHTML}</body></html>`);
    execFileSync(browser!, [...browserFixtureFlags(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${resolve(scratch, 'profile')}`, '--window-size=500,400', '--force-device-scale-factor=1', '--virtual-time-budget=500', `--screenshot=${screenshot}`, pathToFileURL(file).href], { windowsHide: true, timeout: 20000, stdio: 'pipe' });
    const { data, info } = await sharp(readFileSync(screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    // Once navigation collapses its corner material must reveal the shell,
    // while expanded navigation still extends its own fill into both curves.
    expect(pixel(navWidth, 0)).toEqual(navWidth === 0 ? [204, 40, 80] : [20, 80, 120]);
    expect(pixel(navWidth, 199)).toEqual(navWidth === 0 ? [204, 40, 80] : [20, 80, 120]);
    expect(pixel(navWidth + 1, 100)).toEqual([204, 40, 80]); // no tinted stripe inside the scene
    expect(pixel(302, 199)).toEqual([204, 40, 80]); // no stale default-width corner
  } finally { await cleanupBrowserFixture(scratch); }
}, 30000);
