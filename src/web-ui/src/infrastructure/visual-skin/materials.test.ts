import { browserFixtureFlags, cleanupBrowserFixture } from './browser-fixture.test-support';
// @vitest-environment jsdom
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input, ListboxOption, Menu, SearchField, Switch, TabGroup } from '@openbitfun/ui';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { VisualSkinPackageParser } from './parser';
import { VisualSkinRuntime } from './runtime';
import { validateVisualSkinPackage } from './validator';
import type { VisualSkinPackage } from './types';

const base: VisualSkinPackage = {
  manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'material', name: 'Material', version: '1' },
  modes: { light: { tokens: { 'color.surface.panel': '#ffffff', 'color.selection.surface': '#ffbf00', 'color.content.primary': '#cc0000' } } },
  assets: { ink: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="blue" d="M0 0h16v16H0z"/></svg>') } } },
};
const runtimes: VisualSkinRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach(r => r.dispose()); document.body.innerHTML = ''; document.head.querySelectorAll('style[data-openbitfun-skin-runtime]').forEach(e => e.remove()); document.documentElement.removeAttribute('data-openbitfun-skin-id'); });
async function activate(patch: Partial<VisualSkinPackage>) {
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({ ...base, ...patch })).buffer);
  const runtime = new VisualSkinRuntime({ list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin, put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {} });
  runtimes.push(runtime); runtime.watchProjection(); await runtime.activate('material'); return runtime;
}

it.each([
  { opacity: .5 }, { width: '20px' }, { backgroundSize: 'calc(100% - 2px)' },
  { backgroundSize: '5000px' }, { backgroundPosition: 'url(x)' },
  { backgroundRepeat: 'space' }, { backgroundOpacity: .5 },
  { backgroundOpacity: Number.POSITIVE_INFINITY }, { shadowToken: 'color.surface.panel' },
])('rejects unsafe or unbounded part paint %j', paint => {
  const result = validateVisualSkinPackage({ ...base, components: [{ component: 'button', slots: { root: { assetId: 'ink', ...paint } } }] });
  expect(result.valid).toBe(false);
});

it('styles implicit primitive roots and child-tab states without crossing nested components', async () => {
  document.body.innerHTML = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(Menu, null, 'Menu'), React.createElement(Input, { 'aria-label': 'Field' }),
    React.createElement(TabGroup, { items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a' })));
  const runtime = await activate({ components: [
    { component: 'menu', slots: { root: { assetId: 'ink', backgroundSize: '24px 24px', backgroundRepeat: 'repeat' } } },
    { component: 'input', slots: { root: { assetId: 'ink', backgroundPosition: 'right bottom' } } },
    { component: 'tab-group', slots: { tab: { assetId: 'ink', backgroundSize: '20px 20px' } }, states: { selected: { slots: { label: { assetId: 'ink', backgroundPosition: '10% 20%' } } }, hover: { slots: { label: { assetId: 'ink', backgroundPosition: '30% 80%' } } } } },
  ] });
  expect(getComputedStyle(document.querySelector('[data-openbitfun-component="menu"]')!).backgroundSize).toBe('24px 24px');
  expect(getComputedStyle(document.querySelector('[data-openbitfun-component="input"]')!).backgroundPosition).toBe('right bottom');
  const labels = [...document.querySelectorAll('[data-openbitfun-part="label"]')];
  expect(getComputedStyle(labels[0]).backgroundPosition).toBe('10% 20%');
  expect(getComputedStyle(labels[1]).backgroundPosition).not.toBe('10% 20%');
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs[0].setAttribute('aria-selected', 'false'); tabs[1].setAttribute('aria-selected', 'true');
  await new Promise(r => setTimeout(r, 0));
  expect(getComputedStyle(labels[0]).backgroundPosition).not.toBe('10% 20%');
  expect(getComputedStyle(labels[1]).backgroundPosition).toBe('10% 20%');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'components[2].states.selected.slots.label')?.status).toBe('projected');
  document.querySelector('[data-openbitfun-component="tab-group"]')!.setAttribute('data-openbitfun-state', 'hover');
  await new Promise(r => setTimeout(r, 0));
  expect(getComputedStyle(labels[0]).backgroundPosition).not.toBe('30% 80%');
  expect(getComputedStyle(labels[1]).backgroundPosition).not.toBe('30% 80%');
  tabs[0].setAttribute('data-openbitfun-state', 'hover');
  await new Promise(r => setTimeout(r, 0));
  expect(getComputedStyle(labels[0]).backgroundPosition).toBe('30% 80%');
  expect(getComputedStyle(labels[1]).backgroundPosition).toBe('10% 20%');
  const css = document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent!;
  expect(css.match(/--openbitfun-skin-asset-\d+\s*:/g)).toHaveLength(1); // shared across instances and states
});

it('merges state paint, clears images explicitly and follows the native switch state', async () => {
  document.body.innerHTML = renderToStaticMarkup(React.createElement(Switch, { defaultChecked: true, 'aria-label': 'Toggle' }));
  const runtime = await activate({ components: [{ component: 'switch', slots: { track: { assetId: 'ink', backgroundSize: '12px 12px', backgroundPosition: '20% 20%' } }, states: {
    checked: { slots: { track: { backgroundPosition: '80% 80%' } } },
    disabled: { slots: { track: { assetId: null } } },
  } }] });
  const track = document.querySelector('[data-openbitfun-part="track"]')!;
  const input = document.querySelector('input')!;
  expect(getComputedStyle(track).backgroundPosition).toBe('80% 80%');
  expect(getComputedStyle(track).backgroundSize).toBe('12px 12px');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'components[0].states.checked.slots.track')?.status).toBe('projected');
  input.checked = false; input.removeAttribute('checked'); input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  expect(getComputedStyle(track).backgroundPosition).toBe('20% 20%');
  expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'components[0].states.checked.slots.track')?.status).toBe('unresolved');
  input.disabled = true; await new Promise(r => setTimeout(r, 0));
  expect(getComputedStyle(track).backgroundImage).toBe('none');
});

const browser = process.env.OPENBITFUN_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(existsSync);
it('respects delegated search-field surfaces in compilation and diagnostics', async () => {
  document.body.innerHTML = renderToStaticMarkup(React.createElement('div', null,
    ...(['default','embedded','panel'] as const).map(variant => React.createElement(SearchField, {variant, 'aria-label':variant}))));
  const runtime = await activate({components:[{component:'input',slots:{root:{assetId:'ink',shadowToken:'shadow.raised'}}},{component:'search-field',slots:{root:{assetId:'ink'}}}]});
  const fields=[...document.querySelectorAll('[data-openbitfun-component="search-field"]')];
  expect(fields.map(e=>Boolean(e.querySelector('[data-openbitfun-component="input"]')?.hasAttribute('data-openbitfun-skin-node')))).toEqual([true,false,false]);
  expect(fields.map(e=>e.hasAttribute('data-openbitfun-skin-node'))).toEqual([false,false,true]);
  expect(runtime.getSnapshot().projection?.entries.find(e=>e.path==='components[0].slots.root')?.message).toContain('1 mounted');
});

it('paints the native option owner rather than an ancestor scroll container', async () => {
  document.body.innerHTML = renderToStaticMarkup(React.createElement(ListboxOption, {value:'sample',selected:true}, 'Sample'));
  const runtime = await activate({components:[{component:'listbox-option',states:{selected:{slots:{option:{assetId:'ink',backgroundPosition:'20% 30%'}}}}}]});
  expect(getComputedStyle(document.querySelector('[role="option"]')!).backgroundPosition).toBe('20% 30%');
  expect(runtime.getSnapshot().projection?.entries.find(e=>e.path==='components[0].states.selected.slots.option')?.status).toBe('projected');
});

it.skipIf(!browser).each([
  { input: 'mouse', pointer: 4, hover: 2, expands: true },
  { input: 'touch', pointer: 2, hover: 1, expands: false },
])('keeps a closable tab edge on its $input surface and preserves Button borders', async ({ pointer, hover, expands }) => {
  const published = await import(/* @vite-ignore */ pathToFileURL(resolve('../../design-system/packages/ui/dist/index.js')).href);
  document.body.innerHTML = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(published.TabGroup, { id: 'tabs', items: [{ value: 'settings', label: 'Settings', endAction: React.createElement('button', { 'aria-label': 'Close', type: 'button' }, 'X') }] }),
    React.createElement(published.Button, { id: 'plain-button' }, 'Button')));
  await activate({ modes: { light: { tokens: { ...base.modes.light.tokens, 'shadow.raised': '0 0 4px #00ff00' } } }, components: [
    { component: 'tab-group', states: { selected: { slots: { tab: { backgroundToken: 'color.selection.surface', borderToken: 'color.content.primary', shadowToken: 'shadow.raised' } } } } },
    { component: 'button', slots: { root: { borderToken: 'color.content.primary' } } },
  ] });
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-tab-edge-'));
  try {
    const css = ['design-tokens/dist/tokens.css','theme-openbitfun/dist/themes.css','ui/dist/styles.css'].map(path => readFileSync(resolve('../../design-system/packages', path), 'utf8')).join('\n');
    const file = resolve(scratch, 'tabs.html');
    writeFileSync(file, `<!doctype html><html data-openbitfun-design-system-root data-color-scheme="light" data-openbitfun-skin-id="material"><head><style>${css}*{transition:none!important}</style>${document.head.innerHTML}</head><body>${document.body.innerHTML}<pre id="result"></pre><script>
      (()=>{try{const group=document.getElementById('tabs'),tab=group.querySelector('[role=tab]'),item=tab.parentElement,close=group.querySelector('[aria-label=Close]');
      const box=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]},geometry=()=>({tab:box(tab),item:box(item),close:box(close)});
      const results=[];for(const mode of ['light','dark'])for(const expanded of [false,true]){
        document.documentElement.dataset.colorScheme=mode;if(expanded)group.dataset.openbitfunPreviewState='hover';else delete group.dataset.openbitfunPreviewState;
        const paint=geometry(),self=getComputedStyle(tab),edge=getComputedStyle(tab,'::before');
        const state={mode,expanded,desktop:matchMedia('(hover: hover) and (pointer: fine)').matches,paint,border:self.borderColor,shadow:self.boxShadow,edgeBorder:edge.borderColor,edgeShadow:edge.boxShadow,edgeWidth:parseFloat(edge.width),buttonBorder:getComputedStyle(document.getElementById('plain-button')).borderColor};
        document.documentElement.removeAttribute('data-openbitfun-skin-id');state.original=geometry();document.documentElement.dataset.openbitfunSkinId='material';results.push(state);
      }document.getElementById('result').textContent=JSON.stringify(results);
      }catch(error){document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error.stack});}})();
    </script></body></html>`);
    // Explicit input capabilities exercise both media-query branches on every host.
    const output = execFileSync(browser!, [...browserFixtureFlags(), '--headless=new','--disable-gpu','--no-first-run',`--blink-settings=primaryPointerType=${pointer},primaryHoverType=${hover}`,`--user-data-dir=${resolve(scratch,'profile')}`,'--virtual-time-budget=500','--dump-dom',pathToFileURL(file).href], { windowsHide: true, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
    const encoded = output.match(/<pre id="result">(.*?)<\/pre>/s)![1];
    const results = JSON.parse(encoded);
    expect(Array.isArray(results), JSON.stringify(results)).toBe(true);
    for (const result of results) {
      expect(result.desktop).toBe(expands);
      expect(result.paint).toEqual(result.original);
      expect(result.border).toBe('rgba(0, 0, 0, 0)'); expect(result.shadow).toBe('none');
      expect(result.edgeBorder).toBe('rgb(204, 0, 0)'); expect(result.edgeShadow).toContain('rgb(0, 255, 0)');
      expect(Math.abs(result.edgeWidth - result.paint.item[2])).toBeLessThan(1);
      expect(result.buttonBorder).toBe('rgb(204, 0, 0)');
    }
    for (const index of [0, 2]) {
      if (expands) expect(results[index + 1].paint.item[2]).toBeGreaterThan(results[index].paint.item[2]);
      else expect(results[index + 1].paint.item[2]).toBe(results[index].paint.item[2]);
    }
  } finally { await cleanupBrowserFixture(scratch); }
}, 30000);

it.skipIf(!browser)('composes image alpha on the real Button paint layer without fading content or changing geometry', async () => {
  const published = await import(/* @vite-ignore */ pathToFileURL(resolve('../../design-system/packages/ui/dist/index.js')).href);
  document.body.innerHTML = renderToStaticMarkup(React.createElement('div', null, React.createElement(published.Button, { id: 'button' }, 'Label'), React.createElement(published.Switch, { defaultChecked: true, 'aria-label': 'Native switch' })));
  await activate({ components: [
    { component: 'button', slots: { root: { assetId: 'ink', backgroundToken: 'color.surface.panel', backgroundOpacity: .25, backgroundSize: '16px 16px', backgroundRepeat: 'repeat', foregroundToken: 'color.content.primary' } } },
    { component: 'switch', slots: { track: { assetId: 'ink', backgroundPosition: '10% 10%' } }, states: { checked: { slots: { track: { backgroundPosition: '60% 60%' } } } } },
  ] });
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-material-'));
  try {
    const css = readFileSync(resolve('../../design-system/packages/ui/dist/styles.css'), 'utf8');
    const file = resolve(scratch, 'paint.html'), screenshot = resolve(scratch, 'paint.png');
    const image = resolve(scratch, 'ink.svg');
    writeFileSync(image, Buffer.from(base.assets!.ink.source.kind === 'data' ? base.assets!.ink.source.data.split(',')[1] : '', 'base64'));
    // Blob URLs belong to their creating document. Rehost this fixture's exact
    // image bytes in the independent browser; resource lifecycle is tested separately.
    const runtimeStyle = document.head.innerHTML.replace(/blob:nodedata:[a-z0-9-]+/gi, pathToFileURL(image).href);
    writeFileSync(file, `<!doctype html><html data-openbitfun-skin-id="material"><head><style>${css}body{margin:0}#button{position:absolute;left:20px;top:20px;width:160px;height:48px;padding:8px;border:1px solid black;border-radius:20px;font:16px sans-serif}</style>${runtimeStyle}</head><body>${document.body.innerHTML}<pre id="result"></pre><script>
      const e=document.getElementById('button'),measure=()=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {rect:[r.x,r.y,r.width,r.height],radius:s.borderRadius,padding:s.padding,font:s.fontSize}};
      const result={paint:measure(),opacity:getComputedStyle(e).opacity,textOpacity:getComputedStyle(e.querySelector('[data-openbitfun-part="content"]')).opacity,textColor:getComputedStyle(e).color,image:getComputedStyle(e,'::before').backgroundImage,layerOpacity:getComputedStyle(e,'::before').opacity,layerColor:getComputedStyle(e,'::before').backgroundColor,after:getComputedStyle(e,'::after').backgroundImage};
      const track=document.querySelector('[data-openbitfun-part="track"]'),input=document.querySelector('input');result.checked=getComputedStyle(track).backgroundPosition;input.checked=false;result.unchecked=getComputedStyle(track).backgroundPosition;
      document.documentElement.removeAttribute('data-openbitfun-skin-id');result.original=measure();document.documentElement.setAttribute('data-openbitfun-skin-id','material');document.getElementById('result').textContent=JSON.stringify(result);
    </script></body></html>`);
    const output = execFileSync(browser!, [...browserFixtureFlags(), '--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run',`--user-data-dir=${resolve(scratch,'profile')}`,'--window-size=400,300','--force-device-scale-factor=1','--virtual-time-budget=500',`--screenshot=${screenshot}`,'--dump-dom',pathToFileURL(file).href], { windowsHide: true, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
    const result = JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result.paint).toEqual(result.original); expect(result.opacity).toBe('1'); expect(result.textOpacity).toBe('1'); expect(result.textColor).toBe('rgb(204, 0, 0)'); expect(result.image).toContain('linear-gradient');
    expect(result.checked).toBe('60% 60%'); expect(result.unchecked).toBe('10% 10%');
    const { data, info } = await sharp(readFileSync(screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = [...data.subarray((26 * info.width + 100) * info.channels, (26 * info.width + 100) * info.channels + 3)];
    pixel.forEach((value, i) => expect(Math.abs(value - [191,191,255][i]), JSON.stringify({pixel,result})).toBeLessThanOrEqual(2));
  } finally { await cleanupBrowserFixture(scratch); }
}, 30000);
