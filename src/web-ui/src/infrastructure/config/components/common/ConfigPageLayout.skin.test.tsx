// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { ConfigPageLayout, ConfigPageSection, ConfigPageRow } from './ConfigPageLayout';
import { VisualSkinPackageParser } from '@/infrastructure/visual-skin/parser';
import { VisualSkinRuntime } from '@/infrastructure/visual-skin/runtime';

afterEach(() => { document.body.innerHTML = ''; });

it('keeps flush galleries out of the enclosing section material', () => {
  document.body.innerHTML = renderToStaticMarkup(<ConfigPageSection title="Skins" bodySurface={false}><article>Skin card</article></ConfigPageSection>);
  const group = document.querySelector('.openbitfun-config-page-section__body')!;
  expect(group.getAttribute('data-openbitfun-component')).toBe('field-group');
  expect(group.getAttribute('data-openbitfun-paint-layer')).toBe('none');
});

it('keeps the shared config paint target when a settings page supplies its own component id', async () => {
  document.body.innerHTML = renderToStaticMarkup(<ConfigPageLayout data-openbitfun-component="appearance-settings"><button>Control</button></ConfigPageLayout>);
  const container = document.body;
  const root = container.querySelector('.openbitfun-config-page-layout')!;
  expect(root.getAttribute('data-openbitfun-component')).toBe('appearance-settings');
  expect(root.getAttribute('data-openbitfun-product-component')).toBe('config-page');
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'config-paint', name: 'Config paint', version: '1' },
    modes: { light: {} },
    assets: { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') } } },
    components: [{ component: 'config-page', slots: { root: { assetId: 'art', fit: 'fill' } } }],
  })).buffer);
  const runtime = new VisualSkinRuntime({
    list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin,
    put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {},
  });
  try {
    await runtime.activate(skin.manifest.id);
    expect(getComputedStyle(root).backgroundImage).toContain('--openbitfun-skin-asset-0');
    expect(runtime.getSnapshot().projection?.entries.find(entry => entry.path === 'components[0].slots.root')?.status).toBe('projected');
    expect(['', 'none']).toContain(getComputedStyle(container.querySelector('button')!).backgroundImage);
  } finally { runtime.dispose(); }
});


it('paints the actual field group once without losing its public component identity', async () => {
  document.body.innerHTML = renderToStaticMarkup(<ConfigPageSection title="Navigation">
    <ConfigPageRow label="Available pages">{null}</ConfigPageRow><div role="group"><button>Add</button></div>
  </ConfigPageSection>);
  const group = document.querySelector('.openbitfun-config-page-section__body')!;
  expect(group.getAttribute('data-openbitfun-component')).toBe('field-group');
  expect(group.getAttribute('data-openbitfun-product-component')).toBe('config-page');
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'group', name: 'Group', version: '1' },
    modes: { light: {} },
    components: [{ component: 'config-page', slots: { sectionBody: { backgroundToken: 'color.surface.panel' } } }],
  })).buffer);
  const runtime = new VisualSkinRuntime({ list: async () => ({ skins: [skin], invalidRecords: [] }), get: async () => skin,
    put: async () => {}, delete: async () => {}, getSelection: async () => null, setSelection: async () => {} });
  try {
    await runtime.activate('group');
    expect(getComputedStyle(group).backgroundColor).toContain('--openbitfun-color-surface-panel');
    const row = document.querySelector('.openbitfun-config-page-row')!;
    expect(getComputedStyle(row).backgroundColor).not.toContain('--openbitfun-color-surface-panel');
    expect(runtime.getSnapshot().projection?.entries.find(e => e.path === 'components[0].slots.sectionBody')?.status).toBe('projected');
    expect(document.querySelector('[role="group"] button')?.textContent).toBe('Add');
  } finally { runtime.dispose(); }
});


it('scopes artwork toolbar contrast to section actions without recoloring row controls', async () => {
  document.body.innerHTML = renderToStaticMarkup(<ConfigPageSection title="Navigation" extra={<button>Reset</button>}>
    <ConfigPageRow label="Value"><button>Field</button></ConfigPageRow>
  </ConfigPageSection>);
  const actionBar = document.querySelector('[data-openbitfun-part="actionBar"]')!;
  expect(actionBar.getAttribute('data-openbitfun-state')).toBe('toolbar');
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest:{schema:'openbitfun.visual-skin',schemaVersion:1,id:'toolbar',name:'Toolbar',version:'1'},modes:{light:{}},
    components:[{component:'config',states:{toolbar:{tokens:{'color.action.quiet.content':'#ffffff'}}}}],
  })).buffer);
  const runtime = new VisualSkinRuntime({list:async()=>({skins:[skin],invalidRecords:[]}),get:async()=>skin,put:async()=>{},delete:async()=>{},getSelection:async()=>null,setSelection:async()=>{}});
  try {
    await runtime.activate('toolbar');
    expect(getComputedStyle(actionBar).getPropertyValue('--openbitfun-color-action-quiet-content')).toBe('#ffffff');
    expect(getComputedStyle(document.querySelector('.openbitfun-config-page-row')!).getPropertyValue('--openbitfun-color-action-quiet-content')).not.toBe('#ffffff');
  }finally{runtime.dispose();}
});
