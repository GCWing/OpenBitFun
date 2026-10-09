const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/RemoteChatCommandController.ets'), 'utf8');
const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exported = {};
new Function('require', 'exports', js)(name => name.endsWith('RemoteI18n') ? {RemoteI18n: {t: key => key}} :
  name.endsWith('ConnectionErrorPolicy') ? {ConnectionErrorPolicy: {errorText: String}} : {}, exported);
function fixture(images = []) {
  let resolve, reject;
  const response = new Promise((yes, no) => {resolve = yes; reject = no;});
  const state = {draft: 'Hello', images, submits: 0, successes: 0, failures: [], requests: [], busy: false};
  const send = async (...args) => {state.requests.push(args); assert.equal(state.draft, '', 'draft must clear before RPC'); return response;};
  const controller = new exported.RemoteChatCommandController({sendMessage: send, sendMessageWithImages: send}, {
    onBusy: value => {state.busy = value;}, onStatusText() {},
    onComposerPrepared: () => ({commit: () => {state.draft = ''; state.images = []; state.submits++;}, rollback() {}}),
    onSendSucceeded: () => {state.successes++;},
    onSendFailed: (...args) => state.failures.push(args)
  }, {});
  return {state, resolve, reject, send: (busy=false, available=true) => controller.sendPreparedMessage(
    'session', 'Hello', 'code', 'Hello', images, [], 'local', 'pending', busy, available)};
}
for (const images of [[], [{id: 'image'}]]) {
  test(`submission clears immediately, late acknowledgment preserves next draft (images=${images.length})`, async () => {
    const f=fixture(images); const pending=f.send();
    assert.equal(f.state.draft, ''); assert.deepEqual(f.state.images, []);
    assert.equal(f.state.busy, true); assert.equal(f.state.successes, 0);
    f.state.draft='Hello'; // Even an identical next draft must survive the ACK.
    f.resolve('turn'); await pending;
    assert.equal(f.state.draft, 'Hello'); assert.equal(f.state.submits, 1);
    assert.equal(f.state.successes, 1); assert.equal(f.state.busy, false);
  });
}
test('failure returns the original payload for the failed bubble', async () => {
  const images=[{id:'image'}]; const f=fixture(images); const pending=f.send();
  f.reject(Error('offline')); await pending;
  assert.deepEqual(f.state.failures, [['Hello', images, 'local', 'pending']]);
  assert.equal(f.state.busy, false);
});
for (const [busy, available] of [[true,true],[false,false]]) {
  test(`rejected send keeps its draft (busy=${busy}, available=${available})`, async () => {
    const f=fixture(); await f.send(busy, available);
    assert.equal(f.state.draft, 'Hello'); assert.equal(f.state.submits, 0);
    assert.equal(f.state.requests.length, 0);
  });
}

const coreSource = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/state/ConversationCoreState.ets'), 'utf8')
  .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
const coreJs = ts.transpileModule(coreSource, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const coreExports = {};
new Function('require','exports',coreJs)(name => name.endsWith('RemoteUiState') ? {RemoteUiState:{emptyActiveTurn:()=>({}),emptyModelCatalog:()=>({})}} :
  name.endsWith('SubagentBranchExpansionState') ?
    {SubagentBranchExpansionState:class{isExpanded(){return false;}toggle(){return false;}}} :
  {ChatTimelineRevisionTracker:class{reset(){return 0;}},ChatTimelineRowStore:class{clear(){}}},coreExports);
function submitComposer(core, session, text, images) {
  const submission=core.prepareComposerSubmission(session,text,images); submission.commit(); return () => submission.rollback();
}
function composer() {
  const core=new coreExports.ConversationCoreState('code');
  core.setActiveSession({sessionId:'session',title:'Test',agentType:'code'});
  core.setChatInput('  Original  '); core.setSelectedImages([{id:'sent-image'}]);
  return core;
}
test('submission owns an exact text/attachment snapshot and failure restores it once', () => {
  const core=composer(); const restore=submitComposer(core,'session','Original',[{id:'sent-image'}]);
  assert.equal(core.chatInput,''); assert.deepEqual(core.selectedImages,[]);
  restore(); assert.equal(core.chatInput,'  Original  '); assert.deepEqual(core.selectedImages,[{id:'sent-image'}]);
  core.setChatInput('Next'); restore(); assert.equal(core.chatInput,'Next');
});
for (const mutation of ['new text','type then erase','new image','switch away and back','reset']) {
  test(`late failure cannot restore a draft after ${mutation}`, () => {
    const core=composer(); const restore=submitComposer(core,'session','Original',[{id:'sent-image'}]);
    if(mutation==='new text')core.setChatInput('Next');
    if(mutation==='type then erase'){core.setChatInput('Next');core.setChatInput('');}
    if(mutation==='new image')core.addSelectedImages([{id:'new-image'}]);
    if(mutation==='switch away and back'){core.setActiveSession({sessionId:'other'});core.setActiveSession({sessionId:'session'});}
    if(mutation==='reset')core.reset();
    const text=core.chatInput, images=core.selectedImages.slice(); restore();
    assert.equal(core.chatInput,text);assert.deepEqual(core.selectedImages,images);
  });
}
test('submission for a stale session leaves the visible composer untouched', () => {
  const core=composer();submitComposer(core,'other','Original',[{id:'sent-image'}])();
  assert.equal(core.chatInput,'  Original  ');assert.deepEqual(core.selectedImages,[{id:'sent-image'}]);
});
for(const fail of [false,true])test(`steering retains its draft until ACK and handles outcome (failure=${fail})`,async()=>{
  const core=composer(); let resolve,reject;
  const response=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const controller=new exported.RemoteChatCommandController({steerTurn:()=>response},{
    onBusy(){},onStatusText(){},onToast(){},onPollRequested(){},onSteerSucceeded(){},onSendFailed(){},
    onComposerPrepared:(session,text,images)=>core.prepareComposerSubmission(session,text,images)
  },{});
  const pending=controller.steerPreparedMessage('session','turn','Original','Original',[{id:'sent-image'}],[],false,true);
  assert.equal(core.chatInput,'  Original  ');assert.deepEqual(core.selectedImages,[{id:'sent-image'}]);
  if(fail)reject(Error('offline'));else {core.setChatInput('Original');resolve({steeringId:'steer',turnId:'turn'});}
  await pending;assert.equal(core.chatInput,fail?'  Original  ':'Original');
});
