// @vitest-environment jsdom
import { rehostSkinImages } from './browser-fixture.test-support';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compile } from 'sass';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { VisualSkinRuntime } from './runtime';
import { VisualSkinPackageParser } from './parser';
import type { StoredVisualSkin, VisualSkinPackage } from './types';
import type { VisualSkinStorage } from './storage';

const assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } } as const;
const styles = compile(resolve('src/app/styles/visual-skin.scss')).css;
const browser = process.env.OPENBITFUN_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(path => existsSync(path));
const runtimes: VisualSkinRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.dispose());
  document.head.querySelectorAll('style').forEach(node => node.remove());
  document.body.innerHTML = '';
});
async function apply(patch: Partial<VisualSkinPackage>) {
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'paint', name: 'Paint', version: '1' },
    modes: { light: {} }, assets, ...patch,
  })).buffer);
  document.querySelectorAll('[data-openbitfun-surface]').forEach(node => node.insertAdjacentHTML('afterbegin', '<span data-openbitfun-skin-paint aria-hidden="true"></span>'));
  const values = new Map<string, StoredVisualSkin>([['paint', skin]]);
  const storage: VisualSkinStorage = {
    list: async () => ({ skins: [...values.values()], invalidRecords: [] }), get: async id => values.get(id) ?? null,
    put: async value => { values.set(value.manifest.id, value); }, delete: async id => { values.delete(String(id)); },
    getSelection: async () => null, setSelection: async () => {},
  };
  const runtime = new VisualSkinRuntime(storage);
  runtimes.push(runtime);
  await runtime.activate('paint');
  return runtime;
}

describe('skin paint ownership', () => {
  it('projects exact camelCase parts and scene parts while isolating nested owners', async () => {
    document.body.innerHTML = '<div data-openbitfun-component="chat-composer"><div id="context" data-openbitfun-part="contextBar"></div></div><section data-openbitfun-scene="personal-overview"><header id="identity" data-openbitfun-part="identity"></header><section data-openbitfun-scene="other"><header id="nested" data-openbitfun-part="identity"></header></section></section>';
    const runtime = await apply({ components: [
      { component: 'chat-composer', slots: { contextBar: { assetId: 'art', backgroundPosition: '20% 30%' } } },
      { component: 'personal-overview', slots: { identity: { assetId: 'art', fit: 'fill' } } },
    ] });
    expect(getComputedStyle(document.getElementById('context')!).backgroundPosition).toBe('20% 30%');
    expect(getComputedStyle(document.getElementById('identity')!).backgroundImage).toContain('--openbitfun-skin-asset-0');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-skin-asset-0')).toContain('blob:');
    expect(getComputedStyle(document.getElementById('nested')!).backgroundImage).toBe('');
    expect(runtime.getSnapshot().projection?.entries.find(entry => entry.path === 'components[1].slots.identity')?.status).toBe('projected');
  });
  it('keeps the actual input wrapper outside the chat surface contract', () => {
    const source = ts.createSourceFile('ChatInput.tsx', readFileSync(resolve('src/flow_chat/components/ChatInput.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const owners: ts.JsxAttributes[] = [];
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'data-testid' && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'chat-input-container')) owners.push(node.attributes);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(owners).toHaveLength(1);
    expect(owners[0].properties.filter(ts.isJsxAttribute).map(prop => prop.name.getText(source))).not.toContain('data-openbitfun-surface');
    expect(owners[0].properties.filter(ts.isJsxAttribute).map(prop => prop.name.getText(source))).not.toContain('data-openbitfun-skin-slot');
  });

  it('translates fill into valid background sizes for surfaces and owned parts', async () => {
    document.body.innerHTML = '<div id="editor" data-openbitfun-surface="editor"><button data-openbitfun-component="button"><span id="icon" data-openbitfun-part="leading-icon"></span></button></div>';
    await apply({ surfaces: [{ surface: 'editor', backgroundAssetId: 'art', fit: 'fill' }], components: [{ component: 'button', slots: { 'leading-icon': { assetId: 'art', fit: 'fill' } } }] });
    expect(getComputedStyle(document.getElementById('editor')!).getPropertyValue('--openbitfun-skin-surface-background-size')).toBe('100% 100%');
    expect(getComputedStyle(document.getElementById('icon')!).backgroundSize).toBe('100% 100%');
  });

  it('opts in visible artwork only and clears the derived marker when disabled', async () => {
    document.body.innerHTML = '<div id="editor" data-openbitfun-surface="editor"></div><div id="chat" data-openbitfun-surface="chat"></div>';
    const runtime = await apply({ surfaces: [{ surface: 'editor', backgroundAssetId: 'art' }, { surface: 'chat', baseToken: 'color.surface.canvas' }] });
    expect(document.getElementById('editor')?.getAttribute('data-openbitfun-skin-artwork')).toBe('true');
    expect(document.getElementById('chat')?.hasAttribute('data-openbitfun-skin-artwork')).toBe(false);
    await runtime.remove('paint');
    expect(document.querySelector('[data-openbitfun-skin-artwork]')).toBeNull();
  });

  it('keeps opaque editor paint when backdrop opacity is zero', async () => {
    document.body.innerHTML = '<div data-openbitfun-surface="editor"></div>';
    await apply({ surfaces: [{ surface: 'editor', backgroundAssetId: 'art', backgroundOpacity: 0 }] });
    expect(document.querySelector('[data-openbitfun-skin-artwork]')).toBeNull();
  });

  it.skipIf(!browser).each(['local', 'shell'] as const)('renders %s artwork in Chromium without changing widgets or child geometry', async owner => {
    const style = document.createElement('style');
    style.textContent = `:root{--openbitfun-color-surface-canvas:rgb(243,237,225);--openbitfun-color-surface-scene:rgb(250,246,235)}.canvas-editor-group,.openbitfun-flexible-panel,.openbitfun-flexible-panel__content,.monaco-editor,.monaco-editor-background,.suggest-widget,.modern-flowchat-container { background-color:rgb(10,20,30) } .openbitfun-flexible-panel { backdrop-filter:blur(8px) } ${styles}`;
    document.head.appendChild(style);
    document.body.innerHTML = `<div data-openbitfun-surface="editor"><div id="split" style="position:absolute;z-index:7"><div class="canvas-editor-group"><div class="openbitfun-flexible-panel"><div class="openbitfun-flexible-panel__content"><div data-openbitfun-component="editor-tool" data-openbitfun-part="root"><div id="monaco" class="monaco-editor"><div class="monaco-editor-background"></div><div id="widget" class="suggest-widget"></div></div></div></div></div></div></div><div id="other" class="openbitfun-flexible-panel"></div></div>`;
    document.body.insertAdjacentHTML('beforeend', '<section data-openbitfun-surface="chat"><div id="transcript" class="modern-flowchat-container" data-openbitfun-component="modern-flow-chat" data-openbitfun-part="root"><div id="card" class="suggest-widget"></div></div></section>');
    if (owner === 'shell') document.body.innerHTML = `<main data-openbitfun-surface="shell">${document.body.innerHTML}</main>`;
    const runtime = await apply({ surfaces: owner === 'shell' ? [{ surface: 'shell', backgroundAssetId: 'art' }, { surface: 'editor' }, { surface: 'chat' }] : [{ surface: 'editor', backgroundAssetId: 'art' }, { surface: 'chat', backgroundAssetId: 'art' }] });
    // jsdom does not compute cascade layers. Exercise the unmodified production
    // stylesheet and runtime output in a separate headless browser/profile.
    const scratch = mkdtempSync(resolve(tmpdir(), 'openbitfun-skin-paint-'));
    try {
      const html = `<!doctype html><html data-openbitfun-skin-id="paint"><head>${rehostSkinImages(document.head.innerHTML, runtimes.at(-1)!.getSnapshot().activeSkin)}</head><body>${document.body.innerHTML}<pre id="result"></pre><script>
        const style = id => getComputedStyle(document.getElementById(id));
        const editor = document.querySelector('[data-openbitfun-surface="editor"]');
        const result = { editor:getComputedStyle(editor).backgroundColor, monaco:style('monaco').backgroundColor, group:getComputedStyle(document.querySelector('.canvas-editor-group')).backgroundColor,
          widget:style('widget').backgroundColor, other:style('other').backgroundColor,
          position:style('split').position, zIndex:style('split').zIndex,
          backdrop:getComputedStyle(editor.querySelector('[data-openbitfun-skin-paint]'),'::before').zIndex, scrim:getComputedStyle(editor.querySelector('[data-openbitfun-skin-paint]'),'::after').zIndex,
          filter:getComputedStyle(document.querySelector('.canvas-editor-group .openbitfun-flexible-panel')).backdropFilter,
          transcript:style('transcript').backgroundColor,card:style('card').backgroundColor };
        (document.querySelector('[data-openbitfun-surface="shell"]') || editor).removeAttribute('data-openbitfun-skin-artwork');
        result.restored = style('monaco').backgroundColor;
        document.getElementById('result').textContent = JSON.stringify(result);
      </script></body></html>`;
      const path = resolve(scratch, 'paint.html');
      writeFileSync(path, html);
      const output = execFileSync(browser!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-extensions', `--user-data-dir=${resolve(scratch, 'profile')}`, '--dump-dom', pathToFileURL(path).href], { windowsHide: true, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
      const result = JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
      const canvas = 'rgba(0, 0, 0, 0)';
      expect(result).toEqual({ editor:'rgb(243, 237, 225)', monaco:canvas, group:canvas, widget:'rgb(10, 20, 30)', other:'rgb(10, 20, 30)', position:'absolute', zIndex:'7', backdrop:'auto', scrim:'auto', filter:owner === 'local' ? 'none' : 'blur(8px)', transcript:owner === 'local' ? canvas : 'rgb(10, 20, 30)',card:'rgb(10, 20, 30)',restored:'rgba(0, 0, 0, 0)' });
    } finally {
      await runtime.remove('paint');
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
