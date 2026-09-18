import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {launchBrowser,startSourceServer,RelayFixture,connected,signIn,until} from './helpers/browser-account-harness.mjs';
const record=seq=>({sessionId:'browser-session',id:`turn/${seq}`,revision:seq,turn:{turnId:`t${seq}`,sessionId:'browser-session'}});

/** Real browser, real Socket.IO client and real pairwise encryption; only the
 * Relay and the controlled host are simulated. The Relay stores no session
 * content: every page below is answered by the host over `read_stream`, and
 * change hints arrive as encrypted `DeviceEvent`s that name the stream only. */
test('session content is read on demand from the online host, hints wake the reader and history pages walk backwards', {timeout:60000},async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try {
  const context=await browser.createIncognitoBrowserContext();
  const relay=new RelayFixture();
  // More than one host page (200 events) so history must be walked backwards.
  for(let seq=1;seq<=205;seq++)relay.appendStreamEvent('browser-session','session-record',record(seq));
  const page=await relay.page(context,source.origin);
  await signIn(page);await connected(page);
  // The session list itself already reads the host catalog stream on demand.
  await until(()=>relay.streamReads.some(read=>read.stream_id==='@host/catalog'&&read.subscribe),'catalog subscription reads the host');
  const relayRequests=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(/\/v[13]\/sessions/.test(path))relayRequests.push(path);});
  await page.evaluate(async()=>{
   const {getBrowserAccountStore,releaseBrowserAccount}=await import('/src/services/BrowserAccountStore.ts');
   const {currentRelayUrl}=await import('/src/services/pairingLink.ts');
   const {RelayHttpClient}=await import('/src/services/RelayHttpClient.ts');
   const saved=await getBrowserAccountStore(currentRelayUrl()).read();
   const client=new RelayHttpClient(currentRelayUrl(),{token:saved.session.token,masterKey:saved.session.masterKey,userId:saved.session.userId,deviceId:saved.controllerDeviceId});
   releaseBrowserAccount(saved);
   client.setTargetDeviceId('desktop-a');
   const state={events:[],history:[],gaps:[],errors:[],caughtUp:0,resumed:0};window.streamState=state;
   window.stream=await client.subscribeHostStream('browser-session',{
    onEvent:event=>state.events.push(event.payload.id),onError:error=>state.errors.push(String(error)),
    onCaughtUp:()=>state.caughtUp++,onHistoryState:history=>state.history.push(history),onResumed:()=>state.resumed++,onGap:reason=>state.gaps.push(reason),
   });
  });
  let state=await page.evaluate(()=>window.streamState);
  assert.equal(state.events.length,200);assert.equal(state.events[0],'turn/6');assert.equal(state.events.at(-1),'turn/205');
  assert.equal(state.caughtUp,1);assert.deepEqual(state.history.at(-1),{hasMore:true,oldestSeq:6,cursor:205,truncated:false});
  const opening=relay.streamReads.filter(read=>read.stream_id==='browser-session');
  assert.equal(opening.length,1);assert.equal(opening[0].subscribe,true);assert.equal(opening[0].after,undefined);

  // Older history is one explicit backwards page from the host.
  await page.evaluate(()=>window.stream.loadOlder());
  state=await page.evaluate(()=>window.streamState);
  assert.equal(state.events.length,205);assert.deepEqual(state.events.slice(200),['turn/1','turn/2','turn/3','turn/4','turn/5']);
  assert.deepEqual(state.history.at(-1),{hasMore:false,oldestSeq:1,cursor:205,truncated:false});
  assert.equal(relay.streamReads.filter(read=>read.stream_id==='browser-session').at(-1).before,6);

  // A live append reaches the browser through an encrypted hint and one forward read.
  relay.appendStreamEvent('browser-session','session-record',record(206));
  relay.emitStreamHint('desktop-a','browser-session');
  await until(async()=>(await page.evaluate(()=>window.streamState.events.length))===206,'hint triggers a catch-up read');
  const catchUp=relay.streamReads.filter(read=>read.stream_id==='browser-session').at(-1);
  assert.equal(catchUp.after,205);assert.equal(catchUp.epoch,relay.stream('browser-session').epoch);

  // Hints from a device that is not the control target are dropped before decryption.
  const readsBefore=relay.streamReads.length;
  relay.emitStreamHint('desktop-b','browser-session');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(relay.streamReads.length,readsBefore);

  // A host restart renumbers the stream: the reader reports a gap and replays the latest page.
  relay.restartStream('browser-session');
  relay.appendStreamEvent('browser-session','session-record',record(1));
  relay.emitStreamHint('desktop-a','browser-session');
  await until(async()=>(await page.evaluate(()=>window.streamState.gaps.length))===1,'restart is announced as a gap');
  state=await page.evaluate(()=>window.streamState);
  assert.equal(state.events.length,207);assert.equal(state.events.at(-1),'turn/1');assert.equal(state.errors.length,0);
  assert.deepEqual(state.history.at(-1),{hasMore:false,oldestSeq:1,cursor:1,truncated:false});
  const unsubscribed=relay.streamUnsubscribes.length;
  await page.evaluate(()=>window.stream.close());
  await until(()=>relay.streamUnsubscribes.length>unsubscribed&&relay.streamUnsubscribes.includes('browser-session'),'closing releases the host subscription');
  assert.deepEqual(relayRequests,[],'no session content route on the Relay was ever requested');
  assert.deepEqual(relay.errors,[]);
 }finally{await browser.close();await source.close();}
});

test('an older host without host streams is reported as unsupported instead of retried silently', {timeout:60000}, async()=>{
 const source=await startSourceServer();const browser=await launchBrowser();
 try {
  const context=await browser.createIncognitoBrowserContext();
  const relay=new RelayFixture();relay.legacyHost=true;
  const page=await relay.page(context,source.origin);
  await signIn(page);await connected(page);
  const module=fileURLToPath(new URL('../../shared/relay-transport/HostStream.ts',import.meta.url));
  const result=await page.evaluate(async path=>{
   const {getBrowserAccountStore,releaseBrowserAccount}=await import('/src/services/BrowserAccountStore.ts');
   const {currentRelayUrl}=await import('/src/services/pairingLink.ts');
   const {RelayHttpClient}=await import('/src/services/RelayHttpClient.ts');
   const {RemoteSessionManager}=await import('/src/services/RemoteSessionManager.ts');
   const {UNSUPPORTED_HOST_MESSAGE}=await import('/@fs'+path);
   const saved=await getBrowserAccountStore(currentRelayUrl()).read();
   const client=new RelayHttpClient(currentRelayUrl(),{token:saved.session.token,masterKey:saved.session.masterKey,userId:saved.session.userId,deviceId:saved.controllerDeviceId});
   releaseBrowserAccount(saved);
   client.setTargetDeviceId('desktop-a');
   const outcome={expected:UNSUPPORTED_HOST_MESSAGE};
   // Capability probe path: the host answers get_workspace_info without host_stream_v1.
   try{await new RemoteSessionManager(client).subscribeSessionStream('legacy-session',{onEvent(){},onError(){}});outcome.manager='resolved';}
   catch(error){outcome.manager=error.message;}
   // Raw path: the host rejects read_stream as an unknown command.
   try{await client.subscribeHostStream('legacy-session',{onEvent(){},onError(){}});outcome.client='resolved';}
   catch(error){outcome.client=error.message;}
   return outcome;
  },module);
  assert.equal(result.manager,result.expected);assert.equal(result.client,result.expected);
  // The session list surfaced the same state through its catalog subscription
  // instead of polling the host forever.
  assert.ok(relay.streamReads.filter(read=>read.stream_id==='@host/catalog').length<=2,'unsupported hosts are not retried in a loop');
  assert.deepEqual(relay.errors,[]);
 }finally{await browser.close();await source.close();}
});
