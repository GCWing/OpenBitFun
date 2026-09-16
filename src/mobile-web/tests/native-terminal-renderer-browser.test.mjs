import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {launchBrowser} from './helpers/browser-account-harness.mjs';
test('bundled native terminal bridge renders ordered ANSI frames, rejects gaps and forwards PTY input', {timeout:40000},async()=>{
 const root=new URL('../../shared/terminal/webview/generated/',import.meta.url);
 const server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','terminal.js','terminal.css'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(name,root)));}catch{res.writeHead(500).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await launchBrowser();
 try{
  const page=await browser.newPage();await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.evaluateOnNewDocument(()=>{window.events=[];window.OpenBitFunTerminalHost={postMessage:text=>window.events.push(JSON.parse(text))};});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.events.some(e=>e.type==='ready'));
  await page.evaluate(()=>{
   const put=window.OpenBitFunTerminal.accept;
   put({epoch:'one',revision:0,reset:true,data:'old'});
   put({epoch:'one',revision:1,reset:false,data:'\r\x1b[31mRED\x1b[0m'});
   put({epoch:'one',revision:4,reset:false,data:'GAP'});
   put({epoch:'two',revision:0,reset:true,data:'fresh'});
   put({epoch:'two',revision:1,reset:false,data:'\r\x1b[32mGREEN\x1b[0m'});
   put({epoch:'two',revision:0,reset:false,data:'STALE'});
  });
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.trim()==='GREEN');
  assert.equal(await page.evaluate(()=>window.events.filter(e=>e.type==='resync').length),1);
  // Theme changes are presentation updates: they must neither consume a
  // stream revision nor reset the terminal buffer.
  await page.evaluate(()=>window.OpenBitFunTerminal.setTheme({background:'#ffffff',foreground:'#171717'}));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.xterm')).backgroundColor==='rgb(255, 255, 255)');
  await page.evaluate(()=>window.OpenBitFunTerminal.setTheme({background:'#151514',foreground:'#f4f3ef'}));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.xterm')).backgroundColor==='rgb(21, 21, 20)');
  assert.equal(await page.$eval('.xterm-rows',element=>element.textContent.trim()),'GREEN');
  assert.equal(await page.evaluate(()=>window.events.filter(e=>e.type==='resync').length),1);
  const touch = await page.target().createCDPSession();
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:120,y:300}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:120,y:180}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),false,'swiping must not open the keyboard');
  await page.touchscreen.tap(120,120);await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));await page.keyboard.type('pwd');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.events.filter(e=>e.type==='input').map(e=>e.data).join('')==='pwd\r');
  assert.equal(await page.evaluate(()=>!!document.querySelector('.xterm-fg-2')),true);
  assert.ok(await page.evaluate(()=>window.events.some(e=>e.type==='resize'&&e.cols>0&&e.rows>0)));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
