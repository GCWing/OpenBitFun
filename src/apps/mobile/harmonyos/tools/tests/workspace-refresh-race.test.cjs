const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/RemoteWorkspaceViewModel.ets'), 'utf8');
const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exported = {};
new Function('require', 'exports', js)(name => name.endsWith('RemoteLogger') ? {RemoteLogger: {info(){}, warn(){}}} : {}, exported);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes; reject=no;});
  return {promise, resolve, reject};
}
function fixture() {
  let target = 'a';
  const requests=[], errors=[], catalogs=[];
  const state = {savedConnections:[{id:'existing'}], savedConnectionsTargetId:'a', setRecentWorkspaces(){}};
  const vm = new exported.RemoteWorkspaceViewModel(state, {
    savedConnections(){const request=deferred(); requests.push(request); return request.promise;},
    async workspaceCatalog(){catalogs.push(target); return {workspaces:[], recentWorkspaces:[], source:'opened'};}
  }, {remoteTargetId:()=>target, onCatalogLoading(){}, onCatalogLoaded(){}, onCatalogFailed(){}, onConnectionFailure:error=>errors.push(error)});
  return {vm,state,requests,errors,catalogs,target(value){target=value;}};
}
test('refresh keeps current locations visible and an older response cannot replace the latest result', async()=>{
  const f=fixture(); const old=f.vm.loadRecentWorkspacesInBackground();
  assert.equal(f.state.savedConnections[0].id,'existing');
  const current=f.vm.loadRecentWorkspacesInBackground();
  f.requests[1].resolve([{id:'new'}]); await current;
  f.requests[0].resolve([{id:'old'}]); await old;
  assert.equal(f.state.savedConnections[0].id,'new');
  assert.deepEqual(f.catalogs,['a']);
});
for(const outcome of ['success','failure']) test(`late ${outcome} from another device cannot mutate current state or continue its requests`, async()=>{
  const f=fixture(); const old=f.vm.loadRecentWorkspacesInBackground();
  f.target('b'); const current=f.vm.loadRecentWorkspacesInBackground();
  assert.deepEqual(f.state.savedConnections,[]);
  f.requests[1].resolve([{id:'b-ssh'}]); await current;
  if(outcome==='success') f.requests[0].resolve([{id:'a-ssh'}]);
  else f.requests[0].reject(Error('Old device offline'));
  await old;
  assert.equal(f.state.savedConnectionsTargetId,'b');
  assert.equal(f.state.savedConnections[0].id,'b-ssh');
  assert.deepEqual(f.errors,[]); assert.deepEqual(f.catalogs,['b']);
});
test('current connection failure remains visible and does not discard the saved list', async()=>{
  const f=fixture(); const pending=f.vm.loadRecentWorkspacesInBackground();
  f.requests[0].reject(Error('Unavailable')); await pending;
  assert.equal(f.errors.length,1); assert.equal(f.state.savedConnections[0].id,'existing');
  assert.deepEqual(f.catalogs,['a']);
});
