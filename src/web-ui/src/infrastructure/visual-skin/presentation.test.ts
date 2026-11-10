// @vitest-environment jsdom
import { browserFixtureFlags, cleanupBrowserFixture, rehostSkinImages } from './browser-fixture.test-support';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { afterEach, expect, it, vi } from 'vitest';
import WelcomeScene from '@/app/scenes/welcome/WelcomeScene';
import { VisualSkinPackageParser } from './parser';
import { VisualSkinRuntime } from './runtime';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => ({
  'welcomeScene.space.separator': ', ', 'welcomeScene.space.your': 'Your',
  'welcomeScene.space.suffix': ' ideas.', 'welcomeScene.phrases.dreams': 'Let dreams bloom.',
  'welcomeScene.phrases.impossible': 'Create the impossible.',
}[key] ?? 'Inspiration is knocking.') }) }));
vi.mock('@/shared/utils/motionPreference', () => ({ isReducedMotionPreferred: () => true }));

const parser = new VisualSkinPackageParser();
const runtimes: VisualSkinRuntime[] = [];
const browser = process.env.OPENBITFUN_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium',
].find(existsSync);
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.dispose());
  document.body.innerHTML = ''; document.head.querySelectorAll('style').forEach(e => e.remove());
  document.documentElement.removeAttribute('data-openbitfun-skin-id');
});
async function source(id: string, components: unknown) {
  return parser.parse(new TextEncoder().encode(JSON.stringify({
    manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id, name: id, version: '1' },
    modes: { light: {} }, components,
  })).buffer);
}
async function runtimeFor() {
  const skin = await parser.parse(new TextEncoder().encode(JSON.stringify({
    manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'whole', name: 'whole', version: '1' },
    modes: { light: {}, dark: {} },
    assets: { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#124578"/></svg>') } } },
    surfaces: [{ surface: 'shell', backgroundAssetId: 'art' }],
  })).buffer);
  const runtime = new VisualSkinRuntime({
    list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin,
    put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {},
  });
  runtimes.push(runtime); await runtime.activate('whole'); return runtime;
}

it('rejects component layout fields rather than moving the product brand', async () => {
  await expect(source('invalid', [{ component: 'welcome', presentation: 'quiet-end' }])).rejects.toThrow(/presentation/);
  await expect(source('invalid', [{ component: 'welcome', position: 'bottom' }])).rejects.toThrow(/position/);
});

it.skipIf(!browser).each([1000, 700])('keeps the real welcome brand centered with shell artwork at %ipx', async width => {
  document.body.innerHTML = `<main data-openbitfun-surface="shell" style="position:relative"><span data-openbitfun-skin-paint=""></span>${renderToStaticMarkup(createElement(WelcomeScene))}</main>`;
  const runtime = await runtimeFor();
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-welcome-'));
  try {
    const style = compile(resolve('src/app/scenes/welcome/WelcomeScene.scss')).css + compile(resolve('src/app/styles/visual-skin.scss')).css;
    const html = `<!doctype html><html data-openbitfun-skin-id="whole"><head>${rehostSkinImages(document.head.innerHTML, runtimes.at(-1)!.getSnapshot().activeSkin)}<style>:root{--openbitfun-space-2:8px;--openbitfun-space-6:24px;--openbitfun-type-display-sm-font-size:32px;--openbitfun-type-display-sm-line-height:40px}body{margin:0}${style}.welcome-scene{width:${width}px;height:500px}</style></head><body>${document.body.innerHTML}<pre id="result"></pre><script>
      const root=document.querySelector('.welcome-scene'),greeting=document.querySelector('.welcome-scene__greeting');
      const r=greeting.getBoundingClientRect();
      const active={x:r.x,y:r.y,width:r.width,height:r.height};
      const background=getComputedStyle(root).backgroundColor;
      document.documentElement.removeAttribute('data-openbitfun-skin-id');
      const after=greeting.getBoundingClientRect();
      document.getElementById('result').textContent=JSON.stringify({active,after:{x:after.x,y:after.y,width:after.width,height:after.height},background,logo:document.querySelector('.welcome-scene__logo').getBoundingClientRect().width,brand:document.getElementById('welcome-scene-title').textContent,heading:document.getElementById(root.getAttribute('aria-labelledby')).tagName});
    </script></body></html>`;
    const file=resolve(scratch,'welcome.html');writeFileSync(file,html);
    const output=execFileSync(browser!,[...browserFixtureFlags(), '--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${resolve(scratch,'profile')}`,'--dump-dom',pathToFileURL(file).href],{windowsHide:true,encoding:'utf8',timeout:20000,stdio:'pipe'});
    const result=JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result.heading).toBe('H1');expect(result.brand).toContain('OpenBitFun');expect(result.logo).toBe(56);
    expect(result.background).toBe('rgba(0, 0, 0, 0)');expect(result.active).toEqual(result.after);
    expect(result.active.x+result.active.width/2).toBeCloseTo(width/2,0);
    expect(result.active.y).toBeLessThan(300);expect(result.active.y).toBeGreaterThan(100);
  } finally { await cleanupBrowserFixture(scratch); }
},30000);


it.skipIf(!browser)('retains readable settings, tables and overlays when a hidden welcome remains mounted', async () => {
  const runtime=await runtimeFor();
  const scratch=mkdtempSync(resolve(tmpdir(),'skin-reading-'));
  try {
    const css=compile(resolve('src/app/styles/visual-skin.scss')).css;
    const html=`<!doctype html><html data-openbitfun-skin-id="whole"><head><style>:root{--openbitfun-color-surface-scene:rgb(250,246,235);--openbitfun-color-surface-chrome:rgb(232,220,196);--openbitfun-color-surface-canvas:rgb(243,237,225)}${css}.openbitfun-scene-viewport,.openbitfun-scene-viewport__scene{background:var(--openbitfun-color-surface-scene)}.card,.menu{background:rgb(255,252,243)}</style></head><body>
    <main data-openbitfun-surface="shell" data-openbitfun-skin-artwork="true"><div data-openbitfun-surface="workbench"><div id="frame" data-openbitfun-surface="workbench-content"><header id="toolbar" class="openbitfun-scene-top-bar" style="background:rgb(232,220,196)"></header><div id="viewport" class="openbitfun-scene-viewport"><div class="openbitfun-scene-viewport__scene"><section id="settings"><p>Long explanatory text</p><table class="card"><tr><td>Content</td></tr></table></section></div><div class="openbitfun-scene-viewport__scene openbitfun-scene-viewport__scene--empty" aria-hidden="true" style="visibility:hidden"><section class="welcome-scene" data-openbitfun-surface="empty-state"></section></div></div></div></div></main><div class="menu">Menu</div><pre id="result"></pre><script>
    const style=id=>getComputedStyle(document.getElementById(id)).backgroundColor;
    const result={frame:style('frame'),viewport:style('viewport'),toolbar:style('toolbar'),card:getComputedStyle(document.querySelector('.card')).backgroundColor,menu:getComputedStyle(document.querySelector('.menu')).backgroundColor};
    document.getElementById('viewport').setAttribute('data-openbitfun-state','empty');result.landing=style('frame');result.landingToolbar=style('toolbar');document.getElementById('viewport').removeAttribute('data-openbitfun-state');result.restored=style('frame');document.getElementById('result').textContent=JSON.stringify(result);
    </script></body></html>`;
    const file=resolve(scratch,'reading.html');writeFileSync(file,html);
    const output=execFileSync(browser!,[...browserFixtureFlags(), '--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${resolve(scratch,'profile')}`,'--dump-dom',pathToFileURL(file).href],{windowsHide:true,encoding:'utf8',timeout:20000,stdio:'pipe'});
    const result=JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result).toEqual({frame:'rgb(250, 246, 235)',viewport:'rgb(250, 246, 235)',toolbar:'rgb(232, 220, 196)',card:'rgb(255, 252, 243)',menu:'rgb(255, 252, 243)',landing:'rgba(0, 0, 0, 0)',landingToolbar:'rgba(0, 0, 0, 0)',restored:'rgb(250, 246, 235)'});
  } finally { runtime.dispose();await cleanupBrowserFixture(scratch); }
},30000);
