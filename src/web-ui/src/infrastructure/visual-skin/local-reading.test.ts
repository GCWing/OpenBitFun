// @vitest-environment jsdom
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { VisualSkinRuntime } from './runtime';
import { VisualSkinPackageParser } from './parser';
import { rehostSkinImages } from './browser-fixture.test-support';

const browser = process.env.OPENBITFUN_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
it.skipIf(!browser).each(['light','dark'])('keeps artwork clear behind glyphs and applies the shadow without changing boxes in %s', async mode => {
  document.documentElement.dataset.colorScheme = mode;
  document.body.innerHTML = `<main data-openbitfun-surface="shell"><span data-openbitfun-skin-paint></span><section data-openbitfun-surface="workbench-content"><span data-openbitfun-skin-paint></span><header class="openbitfun-scene-top-bar"></header><div class="openbitfun-scene-viewport"><article class="markdown-renderer" id="reader" data-openbitfun-component="markdown" data-openbitfun-part="root"><h2 id="heading">Readable text</h2></article></div></section></main>`;
  const skin = await new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify({
    manifest:{schema:'openbitfun.visual-skin',schemaVersion:1,id:'local',name:'Local',version:'1'},
    modes:{light:{tokens:{'color.surface.panel':'rgba(255,255,255,.94)','color.content.onDark':'#ffffff','shadow.base':'0 1px 2px rgba(0,0,0,.9)','shadow.innerHighlight':'none'}},dark:{tokens:{'color.surface.panel':'rgba(0,0,0,.94)','color.content.onDark':'#ffffff','shadow.base':'0 1px 2px rgba(0,0,0,.9)','shadow.innerHighlight':'none'}}},
    assets:{hero:{mimeType:'image/svg+xml',source:{kind:'data',data:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#c82850"/></svg>')}}},
    surfaces:[{surface:'shell',backgroundAssetId:'hero'},{surface:'workbench-content',backgroundSource:'shell',baseOpacity:0}],
    components:[{component:'markdown',slots:{root:{foregroundToken:'color.content.onDark',textShadowToken:'shadow.base'}},states:{selected:{slots:{root:{textShadowToken:'shadow.innerHighlight'}}}}}],
  })).buffer);
  const runtime = new VisualSkinRuntime({list:async()=>({skins:[skin],invalidRecords:[]}),get:async()=>skin,put:async()=>{},delete:async()=>{},getSelection:async()=>null,setSelection:async()=>{}});
  const scratch=mkdtempSync(resolve(tmpdir(),'skin-local-reading-'));
  try {
    await runtime.activate('local');
    expect(runtime.getSnapshot().projection?.entries.find(e=>e.path==='components[0].slots.root.textShadowToken')?.status).toBe('projected');
    const css=compile(resolve('src/app/styles/visual-skin.scss')).css+compile(resolve('src/infrastructure/markdown/Markdown.scss')).css;
    const file=resolve(scratch,'local.html'),shot=resolve(scratch,'local.png');
    writeFileSync(file,`<!doctype html><html data-openbitfun-skin-id="local"><head><style>body{margin:0}#heading{margin:0}main{position:relative;width:400px;height:240px;isolation:isolate}section{position:relative;width:400px;height:240px}header{height:40px}#reader{position:absolute;left:100px;top:80px;width:160px;height:80px;padding:0;border-radius:0;color:${mode==='light'?'black':'white'}}${css}</style>${rehostSkinImages(document.head.innerHTML,skin)}</head><body>${document.body.innerHTML}<pre id="result"></pre><script>
    const e=document.getElementById('reader'),measure=()=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.x,r.y,r.width,r.height,s.padding,s.borderRadius,s.opacity]};
    const result={before:measure(),shadow:getComputedStyle(e).textShadow,heading:getComputedStyle(document.getElementById('heading')).color,background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,outsideTarget:document.elementFromPoint(93,110).id};e.dataset.openbitfunState='selected';result.selectedShadow=getComputedStyle(e).textShadow;delete e.dataset.openbitfunState;
    document.documentElement.removeAttribute('data-openbitfun-skin-id');result.original=measure();document.documentElement.dataset.openbitfunSkinId='local';document.getElementById('result').textContent=JSON.stringify(result);
    </script></body></html>`);
    const args=['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run',`--user-data-dir=${resolve(scratch,'profile')}`,'--window-size=500,400','--force-device-scale-factor=1','--virtual-time-budget=600',`--screenshot=${shot}`,'--dump-dom',pathToFileURL(file).href];
    const out=execFileSync(browser!,args,{encoding:'utf8',windowsHide:true,timeout:20000,stdio:'pipe'});
    const result=JSON.parse(out.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result.before).toEqual(result.original);expect(result.selectedShadow).toBe('none');expect(result.outsideTarget).not.toBe('reader');
    const {data,info}=await sharp(readFileSync(shot)).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
    for(const [x,y] of [[40,20],[40,110],[320,110]])expect(pixel(x,y)).toEqual([200,40,80]);
    expect(result.background).toBe('rgba(0, 0, 0, 0)');expect(result.color).toBe('rgb(255, 255, 255)');expect(result.heading).toBe(result.color);expect(result.shadow).toContain('2px');
    const expected=[200,40,80];
    pixel(160,130).forEach((v,i)=>expect(Math.abs(v-expected[i])).toBeLessThanOrEqual(2));
    expect(pixel(93,110)).toEqual([200,40,80]); // no plate or box-shadow around the reader
    const glyphs=[];for(let y=80;y<100;y++)for(let x=100;x<220;x++)glyphs.push(pixel(x,y));expect(glyphs.some(p=>p.every(v=>v>230))).toBe(true);
  }finally{runtime.dispose();document.body.innerHTML='';document.head.querySelectorAll('style').forEach(n=>n.remove());document.documentElement.removeAttribute('data-color-scheme');rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
},30000);
