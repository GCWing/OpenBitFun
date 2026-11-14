// @vitest-environment jsdom
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import { expect, it } from 'vitest';
import { VisualSkinPackageParser } from './parser';
import { VisualSkinRuntime } from './runtime';
import { BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS, BROWSER_FIXTURE_TEST_TIMEOUT_MS, browserFixtureFlags, cleanupBrowserFixture, rehostSkinImages } from './browser-fixture.test-support';
import type { VisualSkinPackage } from './types';

const browser = process.env.OPENBITFUN_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);

it.skipIf(!browser)('reveals chat artwork while loading, preserving opaque defaults, transcript hiding and input blocking', async () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-history-paint-'));
  const cases: { name: string; html: string; artwork: boolean }[] = [];
  try {
    for (const source of ['local', 'shell', 'disabled', 'plain', 'fallback'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        const value: VisualSkinPackage = {
          manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'history', name: 'History', version: '1' },
          modes: source === 'fallback' ? { light: {} } : { light: {}, dark: {} },
          assets: { hero: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#405060"/></svg>') } } },
          surfaces: source === 'shell'
            ? [{ surface: 'shell', backgroundAssetId: 'hero' }, { surface: 'chat', backgroundSource: 'shell' }]
            : [{ surface: 'chat', ...(source === 'plain' ? {} : { backgroundAssetId: 'hero', backgroundOpacity: source === 'disabled' ? 0 : 1 }) }],
        };
        document.documentElement.setAttribute('data-color-scheme', mode);
        document.body.innerHTML = `<main data-openbitfun-surface="shell"><span data-openbitfun-skin-paint></span><section data-openbitfun-surface="chat"><span data-openbitfun-skin-paint></span><div data-openbitfun-component="modern-flow-chat" data-openbitfun-part="root"><div class="history-session-loading"><div class="history-session-loading__content" style="opacity:0;pointer-events:none"><button>Old transcript</button></div><div id="overlay" class="history-session-loading__overlay" role="status"><div class="history-session-skeleton">Loading</div></div></div></div></section></main>`;
        const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify(value)).buffer);
        const runtime = new VisualSkinRuntime({ list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin,
          put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {} });
        try {
          await runtime.activate('history');
          const css = rehostSkinImages(document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent!, skin);
          cases.push({ name: `${source}-${mode}`, artwork: !['disabled', 'plain'].includes(source), html: `<html data-openbitfun-skin-id="history"><head><style>${css}</style></head><body>${document.body.innerHTML}</body></html>` });
        } finally { runtime.dispose(); }
      }
    }
    // The same production loading CSS must remain opaque without a skin.
    cases.push({ name: 'unskinned', artwork: false, html: cases[0].html.replace('data-openbitfun-skin-id="history"', '') });
    const css = compile(resolve('src/app/styles/visual-skin.scss')).css;
    const loadingCss = compile(resolve('src/flow_chat/components/modern/HistorySessionLoadingBoundary.scss')).css;
    const html = `<!doctype html><body><pre id="result"></pre><script>
      const cases=${JSON.stringify(cases)}, results=[];
      for (const c of cases) {
        const frame=document.createElement('iframe');frame.width='400';frame.height='300';document.body.append(frame);
        const doc=frame.contentDocument;doc.open();doc.write(c.html);doc.close();
        const style=doc.createElement('style');style.textContent=${JSON.stringify(`:root{--openbitfun-color-surface-scene:rgb(250,246,235)}body{margin:0}main,section{position:relative;height:250px}.history-session-loading__overlay{cursor:wait}${loadingCss}${css}`)};doc.head.append(style);
        const overlay=doc.getElementById('overlay'), content=doc.querySelector('.history-session-loading__content');
        const computed=node=>frame.contentWindow.getComputedStyle(node);
        const box=overlay.getBoundingClientRect();
        const result={name:c.name,background:computed(overlay).backgroundColor,hidden:computed(content).opacity,blocks:doc.elementFromPoint(20,200)===overlay,box:[box.x,box.y,box.width,box.height]};
        doc.documentElement.removeAttribute('data-openbitfun-skin-id');
        const original=overlay.getBoundingClientRect();result.originalBox=[original.x,original.y,original.width,original.height];
        results.push(result);frame.remove();
      }
      document.getElementById('result').textContent=JSON.stringify(results);
    </script></body>`;
    const file = resolve(scratch, 'history.html'); writeFileSync(file, html);
    const output = execFileSync(browser!, [...browserFixtureFlags(), '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${resolve(scratch, 'profile')}`, '--dump-dom', pathToFileURL(file).href], { windowsHide: true, encoding: 'utf8', timeout: BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS, stdio: 'pipe' });
    const results = JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(results).toHaveLength(cases.length);
    for (const result of results) {
      const artwork = cases.find(item => item.name === result.name)!.artwork;
      expect(result.background, result.name).toBe(artwork ? 'rgba(0, 0, 0, 0)' : 'rgb(250, 246, 235)');
      expect(result.hidden, result.name).toBe('0');
      expect(result.blocks, result.name).toBe(true);
      expect(result.box, result.name).toEqual(result.originalBox);
    }
  } finally {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-color-scheme');
    await cleanupBrowserFixture(scratch);
  }
}, BROWSER_FIXTURE_TEST_TIMEOUT_MS);
