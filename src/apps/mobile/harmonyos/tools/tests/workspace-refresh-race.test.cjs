const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/RemoteWorkspaceViewModel.ets'), 'utf8');
const js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exported = {};
new Function('require', 'exports', js)(name => name.endsWith('RemoteLogger') ? {RemoteLogger: {info(){}, warn(){}}} :
  name.endsWith('RemoteI18n') ? {RemoteI18n: {t: key => key}} : {}, exported);
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

for (const picker of ['toggleRecentWorkspaces', 'toggleAssistants']) {
  for (const backgroundFirst of [true, false]) {
    test(`${picker} and background catalog finish independently (background first=${backgroundFirst})`, async () => {
      const saved = deferred(), picked = deferred();
      const state = { savedConnections: [], savedConnectionsTargetId: 'a', busy: false,
        setWorkspacePickerVisible(value) { this.showWorkspacePicker = value; },
        setAssistantPickerVisible(value) { this.showAssistantPicker = value; },
        setRecentWorkspaces(value) { this.recentWorkspaces = value; },
        setAssistants(value) { this.assistants = value; } };
      let catalogState = 'idle';
      const vm = new exported.RemoteWorkspaceViewModel(state, {
        savedConnections: () => saved.promise,
        workspaceCatalog: async () => ({workspaces: [{path:'/project'}], recentWorkspaces: [], source:'opened'}),
        recentWorkspaces: () => picked.promise, assistants: () => picked.promise
      }, {remoteTargetId: () => 'a', isRemoteAvailable: () => true,
        onBusy: value => {state.busy = value;}, onStatus() {}, onConnectionFailure(error) {throw error;},
        onCatalogLoading() {catalogState='loading';}, onCatalogLoaded() {catalogState='ready';}, onCatalogFailed() {catalogState='failed';}});
      const first = backgroundFirst ? vm.loadRecentWorkspacesInBackground() : vm[picker]();
      const second = backgroundFirst ? vm[picker]() : vm.loadRecentWorkspacesInBackground();
      saved.resolve([]); picked.resolve([{path:'/project',name:'Project'}]);
      await Promise.all([first, second]);
      assert.equal(catalogState, 'ready', 'opening a picker must not strand the sidebar in loading');
      assert.equal(state.busy, false, 'a host hint must not prevent the picker from releasing busy');
    });
  }
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
