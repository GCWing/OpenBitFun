import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';
const modulePath = '/@fs' + fileURLToPath(new URL('../../shared/dialog-queue/HostDialogQueue.ts', import.meta.url));

test('real IndexedDB retains an ambiguous submission after closing the browser page', {timeout:60000}, async () => {
 const server=await startSourceServer();const browser=await launchBrowser();
 try {
  const context=await browser.createIncognitoBrowserContext();let page=await context.newPage();
  await page.goto(server.origin);
  const id=await page.evaluate(async path=>{
   const {HostDialogQueue}=await import(path);
   const q=new HostDialogQueue('browser-account/host/session','session',async request=>{
    if(request.action==='submit')throw new Error('Lost acknowledgement');
    return {sessionId:'session',queueEpoch:'host-epoch',revision:0,activeTurnId:'running',items:[],capacity:20,used:0,receipt:null};
   });
   try {await q.submit({content:'offline follow up',agentType:'Standard',attachments:[],metadata:{}});}catch{}
   return q.getSnapshot().pending[0].request.message.turnId;
  },modulePath);
  await page.close();page=await context.newPage();await page.goto(server.origin);
  const result=await page.evaluate(async ({path,id})=>{
   const {HostDialogQueue}=await import(path);const mutations=[];
   const q=new HostDialogQueue('browser-account/host/session','session',async request=>{
    if(request.action==='submit')mutations.push(request);
    return {sessionId:'session',queueEpoch:'host-epoch',revision:2,activeTurnId:null,items:[],capacity:20,used:0,
     receipt:request.action==='get'?{turnId:id,status:'completed',displayContent:'offline follow up'}:null};
   });
   await q.refresh();const pending=q.getSnapshot().pending;
   await q.retry(pending[0]);return {restoredId:pending[0].request.message.turnId,pending:q.getSnapshot().pending.length,mutations:mutations.length};
  },{path:modulePath,id});
  assert.deepEqual(result,{restoredId:id,pending:0,mutations:0});
 } finally {await browser.close();await server.close();}
});

test('mobile running composer keeps send and stop independently available alongside the queue', {timeout:60000}, async () => {
 const server=await startSourceServer();const browser=await launchBrowser();
 try {
  const page=await browser.newPage();await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.goto(server.origin+'/?lang=zh-CN');
  await page.evaluate(async()=>{
   const {mountHostQueueFixture}=await import('/tests/fixtures/host-queue.tsx');
   window.queueFixture=mountHostQueueFixture();
  });
  await page.waitForSelector('.host-message-queue li');
  assert.ok(await page.$eval('.chat-msg__assistant-content .katex', el => !!el), 'katex renders inside assistant message');
  assert.ok(await page.$eval('.chat-msg__assistant-content .katex-display', el => !!el), 'katex block display renders');
  assert.ok((await page.$eval('.code-block-wrapper', el => el.textContent)).includes('echo $$ $1 $&'), 'code blocks preserve special dollar patterns');
  assert.ok(await page.$eval('.host-message-queue',el=>el.getBoundingClientRect().height<=100),'one queued message stays compact');
  const actions=await page.$$eval('.chat-page__send-btn', buttons=>buttons.map(button=>({disabled:button.disabled,stop:button.classList.contains('is-stop')})));
  assert.deepEqual(actions,[{disabled:false,stop:false},{disabled:false,stop:true}]);
  await page.click('.chat-page__send-btn:not(.is-stop)');
  assert.ok((await page.evaluate(()=>window.queueFixture.calls)).includes('send'));
  assert.ok(!(await page.evaluate(()=>window.queueFixture.calls)).includes('stop'));
  assert.equal(await page.$eval('body', body=>body.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/mobile-host-message-queue.png',fullPage:true});
 }finally{await browser.close();await server.close();}
});

test('queue stays above the measured composer across phone, keyboard-height and wide layouts', {timeout:60000}, async () => {
 const server=await startSourceServer();const browser=await launchBrowser();
 try {
  const page=await browser.newPage();
  for(const [width,height] of [[320,568],[390,844],[390,420],[768,800],[1200,900]]) {
   await page.setViewport({width,height});
   await page.goto(server.origin+'/tests/fixtures/host-queue.html?count=8&theme='+ (width===768 ? 'light' : 'dark'));
   await page.waitForSelector('.host-message-queue li');
   await page.waitForFunction(()=>{
    const wrap=document.querySelector('.chat-page__input-wrap');
    return Math.abs(parseFloat(getComputedStyle(document.querySelector('.chat-page')).getPropertyValue('--chat-composer-height'))-wrap.getBoundingClientRect().height)<1;
   });
   const layout=await page.evaluate(()=>{
    const box=selector=>document.querySelector(selector).getBoundingClientRect();
    const queue=box('.host-message-queue'),composer=box('.chat-page__composer'),wrap=box('.chat-page__input-wrap');
    const body=document.querySelector('.host-message-queue__body');
    return {noOverlap:queue.bottom<=composer.top,inside:queue.top>=0&&composer.bottom<=innerHeight,
     width:document.body.scrollWidth<=innerWidth,aligned:Math.abs(queue.left-composer.left)<1&&Math.abs(queue.right-composer.right)<1,
     scrollable:body.scrollHeight>body.clientHeight,reserved:parseFloat(getComputedStyle(document.querySelector('.chat-page__messages')).paddingBottom)>=wrap.height};
   });
   assert.deepEqual(layout,{noOverlap:true,inside:true,width:true,aligned:true,scrollable:true,reserved:true},`${width}x${height}`);
   const controls=await page.evaluate(()=>{
    const info=document.querySelector('.host-message-queue__header .host-message-queue__icon');
    const cancel=document.querySelector('.host-message-queue__row .host-message-queue__actions button:last-child');
    const stop=document.querySelector('.chat-page__send-btn.is-stop');
    const center=el=>{const r=el.getBoundingClientRect();return r.left+r.width/2;};
    const r=stop.getBoundingClientRect();
    return {info:center(info),cancel:center(cancel),stop:center(stop),width:r.width,height:r.height,radius:getComputedStyle(stop).borderRadius};
   });
   assert.ok(Math.abs(controls.info-controls.cancel)<1, 'queue info and remove share a centerline');
   assert.ok(Math.abs(controls.cancel-controls.stop)<1, 'queue remove and stop share a centerline');
   assert.equal(controls.width,controls.height);
   assert.equal(controls.radius,'50%', 'stop control is circular');

   const before=await page.$eval('.chat-page__input-wrap',el=>el.getBoundingClientRect().height);
   await page.click('.host-message-queue__toggle');
   await page.waitForFunction(()=>document.querySelector('.host-message-queue__list').hidden);
   const after=await page.$eval('.chat-page__input-wrap',el=>el.getBoundingClientRect().height);
   assert.ok(after<before-50,'collapsing the queue returns space to the conversation');
   assert.equal((await page.$eval('.host-message-queue__toggle',el=>el.textContent)).includes('8'),true);
  }
  await page.setViewport({width:390,height:844});
  await page.goto(server.origin+'/tests/fixtures/host-queue.html?count=2&expanded=false');
  await page.waitForSelector('.host-message-queue li');
  assert.equal(await page.$('.chat-page__input'),null,'queue controls also work alongside the collapsed composer');
  const geometry=await page.evaluate(()=>{
    const box=s=>document.querySelector(s).getBoundingClientRect();
    const composer=box('.chat-page__composer'),stop=box('.chat-page__send-btn.is-stop');
    const plus=box('.chat-page__composer-leading');
    const text=box('.chat-msg__assistant-content');
    const icon=box('.chat-thinking [data-openbitfun-part="leading"]');
    return {top:stop.top-composer.top,bottom:composer.bottom-stop.bottom,right:composer.right-stop.right,
      left:plus.left-composer.left,width:stop.width,plusWidth:plus.width,
      textLeft:text.left+parseFloat(getComputedStyle(document.querySelector('.chat-msg__assistant-content')).paddingLeft),iconLeft:icon.left};
  });
  assert.equal(geometry.width,44);
  assert.equal(geometry.plusWidth,44);
  for(const edge of ['top','bottom','left']) assert.ok(Math.abs(geometry[edge]-geometry.right)<1,JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.textLeft-geometry.iconLeft)<1,JSON.stringify(geometry));
  await page.screenshot({path:'/tmp/mobile-queue-aligned.png',fullPage:true});
  await page.click('[aria-label="排队消息说明"]');
  await page.waitForSelector('.host-message-queue__help');
  await page.click('[aria-label="排队消息说明"]');
  assert.equal(await page.$('.host-message-queue__help'),null);
  await page.click('.host-message-queue__actions button');
  await page.waitForFunction(()=>document.querySelectorAll('.host-message-queue li').length===1);
  await page.click('[aria-label="移出队列"]');
  await page.waitForFunction(()=>!document.querySelector('.host-message-queue'));
  assert.ok(await page.$('.chat-page__composer'),'removing the last queued message preserves the composer');
 }finally{await browser.close();await server.close();}
});
