// @vitest-environment jsdom
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import { afterEach, expect, it } from 'vitest';
import { VisualSkinPackageParser } from './parser';
import { VisualSkinRuntime } from './runtime';
import { BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS, BROWSER_FIXTURE_TEST_TIMEOUT_MS, browserFixtureFlags, cleanupBrowserFixture, rehostSkinImages } from './browser-fixture.test-support';
import { validateVisualSkinPackage } from './validator';
import type { VisualSkinPackage } from './types';

const base: VisualSkinPackage = {
  manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'shared', name: 'Shared', version: '1' },
  modes: { light: {}, dark: { surfaces: [{ surface: 'shell', backgroundOpacity: 0 }] } },
  assets: { hero: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#405060"/></svg>') } } },
  surfaces: [
    { surface: 'shell', backgroundAssetId: 'hero' },
    { surface: 'navigation', backgroundSource: 'shell', baseOpacity: 0.8 },
    { surface: 'workbench-content', backgroundSource: 'shell', baseOpacity: 0.5, states: { empty: { tokens: { 'color.surface.scene': 'transparent' } } } },
    { surface: 'chat', backgroundSource: 'shell', baseOpacity: 0.94 },
  ],
};
const runtimes: VisualSkinRuntime[] = [];
const browser = process.env.OPENBITFUN_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
afterEach(() => {
  runtimes.splice(0).forEach(r => r.dispose()); document.body.innerHTML = '';
  document.head.querySelectorAll('style').forEach(n => n.remove());
  document.documentElement.removeAttribute('data-color-scheme');
});
async function activate() {
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify(base)).buffer);
  const runtime = new VisualSkinRuntime({ list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin,
    put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {} });
  runtimes.push(runtime); await runtime.activate('shared'); return runtime;
}
it.each([
  { surface: 'shell', backgroundSource: 'shell' },
  { surface: 'chat', backgroundSource: 'remote' },
  { surface: 'chat', backgroundSource: 'shell', backgroundAssetId: 'hero' },
  { surface: 'chat', baseOpacity: -0.1 }, { surface: 'chat', baseOpacity: Infinity }, { surface: 'chat', baseOpacity: NaN },
])('rejects invalid shared material %j', profile => {
  expect(validateVisualSkinPackage({ ...base, surfaces: [profile] }).valid).toBe(false);
});
it('resolves shared paint by mode, reports its dependency, and clears markers on removal', async () => {
  document.body.innerHTML = '<main data-openbitfun-surface="shell"><section data-openbitfun-surface="chat"></section></main>';
  const runtime = await activate();
  expect(document.querySelector('[data-openbitfun-surface="chat"]')?.getAttribute('data-openbitfun-skin-background-source')).toBe('shell');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'surfaces[3].backgroundSource')?.status).toBe('projected');
  document.documentElement.setAttribute('data-color-scheme', 'dark');
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('[data-openbitfun-skin-background-source]')).toBeNull();
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'surfaces[3].backgroundSource')?.status).toBe('unsupported');
  document.documentElement.setAttribute('data-color-scheme', 'light');
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('[data-openbitfun-skin-background-source]')).not.toBeNull();
  await runtime.remove('shared');
  expect(document.querySelector('[data-openbitfun-skin-background-source]')).toBeNull();
});
it.skipIf(!browser)('renders shared chrome, translucent reader and collapsed corners without fading content or changing boxes', async () => {
  document.body.innerHTML = `<main data-openbitfun-surface="shell"><span data-openbitfun-skin-paint></span><div data-openbitfun-surface="workbench"><aside class="openbitfun-workspace-body__nav-area is-collapsed" data-openbitfun-surface="navigation"></aside><div class="openbitfun-workspace-body__scene-area"><div id="underlay" class="openbitfun-workspace-body__corner-underlay" data-openbitfun-surface-underlay="navigation"></div><div id="frame" data-openbitfun-surface="workbench-content"><header id="toolbar" class="openbitfun-scene-top-bar"><div class="openbitfun-scene-top-bar__panel-region"><button id="panelControl" data-openbitfun-component="icon-button">Panel</button><button id="disabledControl" data-openbitfun-component="icon-button" disabled>Disabled</button></div></header><div id="viewport" class="openbitfun-scene-viewport"><section class="openbitfun-scene-viewport__scene"><section id="session" class="openbitfun-session-scene"><div id="chat" data-openbitfun-surface="chat"><div id="text" data-openbitfun-component="modern-flow-chat" data-openbitfun-part="root">Readable text</div><div id="card">Independent card</div></div></section></section></div></div></div></div></main><div id="menu">Menu</div>`;
  const runtime = await activate();
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-shared-'));
  try {
    const css = compile(resolve('src/app/styles/visual-skin.scss')).css;
    const html = `<!doctype html><html data-openbitfun-skin-id="shared"><head>${rehostSkinImages(document.head.innerHTML, runtime.getSnapshot().activeSkin)}<style>:root{--openbitfun-color-surface-scene:rgb(250,246,235);--openbitfun-color-surface-chrome:rgb(232,220,196);--openbitfun-color-surface-canvas:rgb(243,237,225)}#toolbar{color:rgb(240,230,210)}#panelControl,#disabledControl{color:rgb(30,40,50)}#frame{position:relative;width:800px;height:600px;border-radius:24px 0 0 24px;overflow:hidden}#chat{width:700px;height:500px}#session,#toolbar,#viewport,.openbitfun-scene-viewport__scene,#text{background:var(--openbitfun-color-surface-scene)}#underlay{background:var(--openbitfun-color-surface-chrome)}#menu,#card{background:rgb(255,252,243)}${css}</style></head><body>${document.body.innerHTML}<pre id="result"></pre><script>
    const style=id=>getComputedStyle(document.getElementById(id));
    const rect=()=>{const r=document.getElementById('frame').getBoundingClientRect();return [r.x,r.y,r.width,r.height,style('frame').borderRadius]};
    const alpha=color=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return x.getImageData(0,0,1,1).data[3]/255};
    document.querySelector('.is-collapsed').classList.remove('is-collapsed');const expandedUnderlay=style('underlay').backgroundColor;document.querySelector('[data-openbitfun-surface="navigation"]').classList.add('is-collapsed');
    const result={expandedUnderlay,control:style('panelControl').color,disabled:style('disabledControl').color,frame:rect(),alpha:alpha(style('chat').backgroundColor),text:style('text').backgroundColor,session:style('session').backgroundColor,opacity:style('text').opacity,toolbar:style('toolbar').backgroundColor,viewport:style('viewport').backgroundColor,underlay:style('underlay').backgroundColor,menu:style('menu').backgroundColor,card:style('card').backgroundColor};
    result.activeAlpha=alpha(style('frame').backgroundColor);document.getElementById('frame').dataset.openbitfunState='empty';result.emptyAlpha=alpha(style('frame').backgroundColor);delete document.getElementById('frame').dataset.openbitfunState;result.restoredAlpha=alpha(style('frame').backgroundColor);document.documentElement.removeAttribute('data-openbitfun-skin-id');result.original=rect();document.getElementById('result').textContent=JSON.stringify(result);
    </script></body></html>`;
    const file = resolve(scratch, 'shared.html'); writeFileSync(file, html);
    const output = execFileSync(browser!, [...browserFixtureFlags(), '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${resolve(scratch, 'profile')}`, '--dump-dom', pathToFileURL(file).href], { windowsHide: true, encoding: 'utf8', timeout: BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS, stdio: 'pipe' });
    const result = JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result.activeAlpha).toBeCloseTo(0.5, 2); expect(result.emptyAlpha).toBe(0); expect(result.restoredAlpha).toBeCloseTo(0.5, 2);
    expect(result.expandedUnderlay).toBe('color(srgb 0.909804 0.862745 0.768627 / 0.8)');
    expect(result.control).toBe('rgb(240, 230, 210)'); expect(result.disabled).toBe('rgb(30, 40, 50)'); expect(result.frame).toEqual(result.original); expect(result.alpha).toBeCloseTo(0.94, 2); expect(result.opacity).toBe('1');
    for (const key of ['toolbar','viewport','underlay','text','session']) expect(result[key]).toBe('rgba(0, 0, 0, 0)');
    expect(result.menu).toBe('rgb(255, 252, 243)'); expect(result.card).toBe(result.menu);
  } finally { await cleanupBrowserFixture(scratch); }
}, BROWSER_FIXTURE_TEST_TIMEOUT_MS);
