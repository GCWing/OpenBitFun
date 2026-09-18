import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launchBrowser,startSourceServer} from './helpers/browser-account-harness.mjs';
test('workspace terminal renders ANSI, sends keyboard input and resizes the controlled PTY without polling', {timeout:40000},async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try{
  const page=await browser.newPage();await page.goto(source.origin);
  await page.evaluate(async()=>{
   const ReactModule=await import('/node_modules/.vite/deps/react.js');const React=ReactModule.default??ReactModule;
   const ReactDOM=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=ReactDOM.default??ReactDOM;
   const {WorkspaceTerminal}=await import('/src/components/WorkspaceTerminal.tsx');
   const calls=[];window.testCalls=calls;
   const manager={invokeHost:async(command,request)=>{
    calls.push({command,request});
    if(command==='terminal_create')return{id:'pty'};
    if(command==='terminal_get_history')return{data:request.afterOffset===0?'alpha\r\x1b[31mOMEGA\x1b[0m':'',nextOffset:5,cursor:5,truncated:false};
    return null;
   },subscribeSessionStream:async(id,{onCaughtUp})=>{
    setTimeout(onCaughtUp,0);return{close:()=>calls.push({command:'stream-close'}),wake(){},async loadOlder(){}};
   }};
   document.body.innerHTML='<div id="terminal-test" style="width:700px"></div>';
   createRoot(document.querySelector('#terminal-test')).render(React.createElement(WorkspaceTerminal,{manager,workspace:{path:'/controlled/workspace',remote_connection_id:'saved-ssh'}}));
  });
  await page.waitForSelector('button');await page.evaluate(()=>document.querySelector('button').click());
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('OMEGA'));
  await page.click('.xterm-helper-textarea');await page.keyboard.type('pwd');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.testCalls.filter(c=>c.command==='terminal_write').map(c=>c.request.data).join('')==='pwd\r');
  await page.evaluate(()=>document.querySelector('#terminal-test').style.width='350px');
  await new Promise(r=>setTimeout(r,300));
  const result=await page.evaluate(()=>({calls:window.testCalls,red:!!document.querySelector('.xterm-fg-1'),text:document.querySelector('.xterm-rows')?.textContent.trim()}));
  const creates=result.calls.filter(c=>c.command==='terminal_create');assert.equal(creates[0].request.connectionId,'saved-ssh');
  assert.equal(result.red,true);assert.equal(result.text,'OMEGA');
  const sizes=result.calls.filter(c=>c.command==='terminal_resize');assert.ok(sizes.length>=2);assert.ok(sizes.at(-1).request.cols<sizes[0].request.cols);
  const reads=result.calls.filter(c=>c.command==='terminal_get_history').length;assert.equal(reads,1);
  await page.evaluate(()=>Array.from(document.querySelectorAll('button')).at(-1).click());
  await page.waitForFunction(()=>window.testCalls.some(c=>c.command==='stream-close'));
 }finally{await browser.close();await source.close()}
});
