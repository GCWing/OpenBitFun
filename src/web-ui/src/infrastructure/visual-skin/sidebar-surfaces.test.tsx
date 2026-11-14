// @vitest-environment jsdom
import { BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS, BROWSER_FIXTURE_TEST_TIMEOUT_MS, browserFixtureFlags } from './browser-fixture.test-support';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { ActionCard, Combobox, MultiSelect, Select } from '@openbitfun/ui';
import actionStyles from '../../../../../design-system/packages/ui/src/components/ActionCard/ActionCard.module.css';
import comboStyles from '../../../../../design-system/packages/ui/src/components/Combobox/Combobox.module.css';
import selectStyles from '../../../../../design-system/packages/ui/src/components/Select/Select.module.css';
import { VisualSkinRuntime } from './runtime';
import { VisualSkinPackageParser } from './parser';

const browser = process.env.OPENBITFUN_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
const rootPath = resolve('../..');
function cssModule(name: string, classes: Record<string,string>) {
  return readFileSync(resolve(rootPath,`design-system/packages/ui/src/components/${name}/${name}.module.css`),'utf8')
    .replace(/\.([a-zA-Z_][\w-]*)/g,(match,key)=>classes[key]?`.${classes[key]}`:match);
}
function runBrowser(html:string) {
  const dir=mkdtempSync(resolve(tmpdir(),'skin-sidebar-')),file=resolve(dir,'fixture.html'),shot=resolve(dir,'fixture.png');
  writeFileSync(file,html);
  try {
    const dom=execFileSync(browser!,[...browserFixtureFlags(), '--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${resolve(dir,'profile')}`,'--force-device-scale-factor=1','--window-size=900,800','--virtual-time-budget=250',`--screenshot=${shot}`,'--dump-dom',pathToFileURL(file).href],{encoding:'utf8',windowsHide:true,timeout: BROWSER_FIXTURE_LAUNCH_TIMEOUT_MS,stdio:'pipe'});
    return {result:JSON.parse(dom.match(/<pre id="result">(.*?)<\/pre>/s)![1]),pixels:readFileSync(shot)};
  } finally {rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}

it.skipIf(!browser).each(['light','dark'])('keeps actual picker paint inside the trigger corners in %s',async mode=>{
  const panel=mode==='light'?'#ffffff':'#242424';
  document.body.innerHTML=renderToStaticMarkup(<main>
    <Combobox size="sm" defaultValue="codex" options={[{value:'codex',label:'Codex'}]} label="Model"/>
    <Combobox variant="pill" defaultValue="codex" options={[{value:'codex',label:'Codex'}]}/>
    <MultiSelect size="sm" defaultValue={['codex']} options={[{value:'codex',label:'Codex'}]}/>
    <Select size="sm" defaultValue="codex" options={[{value:'codex',label:'Codex'}]}/>
    <ActionCard className="miniapp-installed-card__surface">Installed app</ActionCard>
  </main>);
  const skin=await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest:{schema:'openbitfun.visual-skin',schemaVersion:1,id:'corners',name:'Corners',version:'1'},modes:{[mode]:{tokens:{'color.field.background':panel}}},
    components:['combobox','multi-select','select'].map(component=>({component,slots:{[component==='select'?'trigger':'control']:{backgroundToken:'color.field.background'}}})),
  })).buffer);
  const runtime=new VisualSkinRuntime({list:async()=>({skins:[skin],invalidRecords:[]}),get:async()=>skin,put:async()=>{},delete:async()=>{},getSelection:async()=>null,setSelection:async()=>{}});
  try {
    document.documentElement.dataset.colorScheme=mode;await runtime.activate('corners');
    const css=cssModule('Combobox',comboStyles)+cssModule('Select',selectStyles)+cssModule('ActionCard',actionStyles)+compile(resolve('src/app/scenes/miniapps/components/MiniAppInstalledCard.scss')).css;
    const {result,pixels}=runBrowser(`<!doctype html><html data-openbitfun-skin-id="corners"><style>
      :root{--openbitfun-control-height-sm:32px;--openbitfun-control-height-md:40px;--openbitfun-color-surface-panel:${panel};--openbitfun-control-action-card-radius:12px;--openbitfun-control-action-card-padding-block:12px;--openbitfun-control-action-card-padding-inline:12px;--openbitfun-control-select-radius:10px;--openbitfun-control-status-pill-radius:999px;--openbitfun-border-width-default:1px;--openbitfun-color-field-background:${panel};--openbitfun-color-field-border:#704080;--openbitfun-space-1:4px;--openbitfun-control-select-padding-inline:12px;--openbitfun-control-status-pill-padding-inline:12px}
      body{margin:30px;background:#c82850}main>*{display:block;width:260px;margin-bottom:30px}main>[data-openbitfun-component="action-card"]{display:inline-flex}button{font:14px sans-serif}svg{width:16px;height:16px}
      ${css}</style>${document.head.innerHTML}<body>${document.body.innerHTML}<pre id="result"></pre><script>
      const rows=[...document.querySelector('main').children].map(root=>{
        const trigger=root.querySelector('[role="combobox"],[data-openbitfun-part="trigger"]'),isCard=root.dataset.openbitfunComponent==='action-card',control=isCard?root:root.querySelector('[data-openbitfun-part="control"]')||trigger;
        const t=trigger.getBoundingClientRect(),c=control.getBoundingClientRect();
        return {isCard,triggerBackground:getComputedStyle(trigger).backgroundColor,radius:getComputedStyle(control).borderTopLeftRadius,triggerRadius:getComputedStyle(trigger).borderTopLeftRadius,x:c.x,y:c.y,w:c.width,h:c.height,tw:t.width,th:t.height};
      });document.getElementById('result').textContent=JSON.stringify(rows);
      </script></body></html>`);
    expect(result).toHaveLength(5);
    const {data,info}=await sharp(pixels).removeAlpha().raw().toBuffer({resolveWithObject:true});
    for(const row of result){
      if(row.isCard){expect(row.radius).toBe('12px');expect(row.triggerBackground).toBe('rgba(0, 0, 0, 0)');}
      else{expect(row.radius).toBe(row.triggerRadius);}
      expect(row.w).toBe(row.tw);expect(row.h).toBe(row.th);
      for(const [x,y] of [[row.x+1,row.y+1],[row.x+row.w-2,row.y+1],[row.x+1,row.y+row.h-2],[row.x+row.w-2,row.y+row.h-2]]){
        const at=(Math.floor(y)*info.width+Math.floor(x))*info.channels;
        expect([...data.subarray(at,at+3)]).toEqual([200,40,80]);
      }
    }
  }finally{runtime.dispose();document.body.innerHTML='';document.head.querySelectorAll('style').forEach(e=>e.remove());delete document.documentElement.dataset.colorScheme;}
}, BROWSER_FIXTURE_TEST_TIMEOUT_MS);

it.skipIf(!browser).each(['light','dark'])('reveals sidebar scene canvases only for a materialized frame in %s',mode=>{
  const global=compile(resolve('src/app/styles/visual-skin.scss')).css;
  const paths=['personal-overview/PersonalOverviewScene','agents/AgentsScene','miniapps/MiniAppGalleryScene','profile/views/NurseryView'];
  const importers=[{findFileUrl:(url:string)=>url.startsWith('@/')?pathToFileURL(resolve('src',url.slice(2))):null}];
  const styles=compile(resolve('src/app/components/GalleryLayout/GalleryLayout.scss')).css+paths.map(p=>compile(resolve(`src/app/scenes/${p}.scss`),{importers}).css).join('');
  const classes=['personal-overview','openbitfun-agents-scene','miniapp-gallery-scene','miniapp-gallery-pane','nursery-gallery','nursery-page','gallery-page-header'];
  const markup=classes.map(cls=>`<section class="${cls}" style="width:200px;height:30px"><h2 class="gallery-page-header__title">Heading</h2><article data-openbitfun-reading-surface="self">Reading content</article></section>`).join('');
  const {result}=runBrowser(`<!doctype html><html data-openbitfun-skin-id="scenes"><style>
    :root{--openbitfun-color-surface-scene:${mode==='light'?'white':'black'};--openbitfun-color-surface-panel:${mode==='light'?'#fafafa':'#282828'}}${styles}${global}
  </style><body><main data-openbitfun-surface="workbench-content">${markup}</main><pre id="result"></pre><script>
    const root=document.querySelector('main'),nodes=[...root.children],measure=()=>nodes.map(e=>{const r=e.getBoundingClientRect();return[r.x,r.y,r.width,r.height]});
    const original=measure(),plain=nodes.map(e=>getComputedStyle(e).backgroundColor);root.dataset.openbitfunSkinArtwork='true';
    const shadows=nodes.map(e=>getComputedStyle(e.querySelector('h2')).textShadow);
    const active=nodes.map(e=>getComputedStyle(e).backgroundColor),geometry=measure(),cards=nodes.map(e=>getComputedStyle(e.querySelector('article')).backgroundColor),headings=nodes.map(e=>getComputedStyle(e.querySelector('h2'),'::before').content);
    root.dataset.openbitfunSkinArtwork='false';const removed=nodes.map(e=>getComputedStyle(e).backgroundColor);
    document.getElementById('result').textContent=JSON.stringify({original,plain,active,geometry,cards,headings,shadows,removed});
  </script></body></html>`);
  expect(result.active.every((c:string)=>c==='rgba(0, 0, 0, 0)')).toBe(true);
  expect(result.original).toEqual(result.geometry);expect(result.removed).toEqual(result.plain);
  expect(result.plain.every((c:string)=>c!=='rgba(0, 0, 0, 0)')).toBe(true);
  expect(result.cards.every((c:string)=>c=== (mode==='light'?'rgb(250, 250, 250)':'rgb(40, 40, 40)'))).toBe(true);
  expect(result.shadows.every((s:string)=>s!=='none')).toBe(true);
  expect(result.headings.every((c:string)=>['none','normal'].includes(c))).toBe(true);
}, BROWSER_FIXTURE_TEST_TIMEOUT_MS);
