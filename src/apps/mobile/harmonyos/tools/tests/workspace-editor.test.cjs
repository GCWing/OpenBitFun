const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function fixture(){
 const source=fs.readFileSync(path.join(__dirname,'../../entry/src/main/ets/pages/viewmodel/WorkspaceToolsViewModel.ets'),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const exports={};new Function('require','exports',js)(name=>name.endsWith('WorkspaceFileUploadClient')?{WorkspaceFileUploadClient:class{hasPending(){return false;}}}:name.endsWith('Encoding')?{Encoding:{sha256:async value=>'hash:'+value}}:{},exports);
 const state={visible:true,busy:false,dirty:false,editorVisible:false,editing:false,content:'',selectedFile:'',directory:'/project',entries:[],sort:0};const calls=[];const manager={async hostInvoke(command,args){calls.push({command,args});if(command==='ssh_list_saved_connections')return [{id:'saved-other',name:'Other'}];if(command==='read_file_content')return 'original';if(command==='terminal_list')return [];return {children:[],hasMore:false};}};
 const vm=new exports.WorkspaceToolsViewModel(state,manager,()=> 'runtime');vm.owner='runtime';vm.location={path:'/project',remoteConnectionId:'saved-ssh'};return {vm,state,calls};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('viewer opens independently; cancel preserves edits and discard returns to same directory',async()=>{const f=fixture();f.vm.dispatch({type:'read',path:'/project/a'});await tick();assert.equal(f.state.editorVisible,true);assert.equal(f.state.editing,false);f.vm.dispatch({type:'editor-edit'});f.vm.dispatch({type:'edit',text:'changed'});f.vm.dispatch({type:'editor-back'});assert.equal(f.state.confirmDiscard,true);assert.equal(f.state.editorVisible,true);f.vm.dispatch({type:'discard-cancel'});assert.equal(f.state.content,'changed');f.vm.dispatch({type:'editor-back'});f.vm.dispatch({type:'discard-confirm'});assert.equal(f.state.editorVisible,false);assert.equal(f.state.directory,'/project');assert.equal(f.state.content,'original');assert.equal(f.calls.length,1);});
test('server sort is sent with stable SSH workspace identity and resets pagination',async()=>{const f=fixture();for(let sort=0;sort<4;sort++){f.vm.dispatch({type:'sort',text:String(sort)});await tick();const request=f.calls.at(-1).args.request;assert.equal(request.sortBy,sort<2?'name':'modified');assert.equal(request.sortOrder,sort%2?'desc':'asc');assert.equal(request.remoteConnectionId,'saved-ssh');assert.equal(request.offset,0);}});
test('saved runtime folder browsing never changes the active workspace',async()=>{const f=fixture();f.vm.dispatch({type:'browse-workspace',path:'/remote/folder',text:'saved-other'});await tick();assert.deepEqual(f.calls.map(x=>x.command),['get_directory_children_paginated']);assert.equal(f.calls[0].args.request.remoteConnectionId,'saved-other');assert.equal(f.state.directory,'/project');assert.equal(f.state.browsePath,'/remote/folder');});
test('successful save keeps editor open and clears dirty state with expected hash',async()=>{const f=fixture();f.vm.dispatch({type:'read',path:'/project/a'});await tick();f.vm.dispatch({type:'edit',text:'new'});f.vm.dispatch({type:'save'});await tick();assert.equal(f.state.editorVisible,true);assert.equal(f.state.dirty,false);const request=f.calls.find(x=>x.command==='write_file_content').args.request;assert.equal(request.expectedHash,'hash:original');assert.equal(request.content,'new');});

test('workspace menu captures the clicked root and saved connection without consulting global selection',async()=>{const f=fixture();f.vm.dispatch({type:'open',deviceId:'runtime',path:'/other',connectionId:'saved-clicked',tab:1});await tick();assert.equal(f.state.directory,'/other');assert.equal(f.state.initialTab,1);const request=f.calls[0].args.request;assert.equal(request.path,'/other');assert.equal(request.remoteConnectionId,'saved-clicked');assert.equal(f.vm.location.path,'/other');});

test('sidebar final entry hierarchy keeps modes in workspace plus and tools in the footer',()=>{
 const components=path.join(__dirname,'../../entry/src/main/ets/pages/components');
 const group=fs.readFileSync(path.join(components,'SidebarDeviceGroup.ets'),'utf8');
 const menu=group.slice(group.indexOf('private CreateModeMenu()'),group.indexOf('private SessionLoadingRow()'));
 assert.match(menu,/HarnessProfileMenu\(\{ showTitle: false/);
 assert.doesNotMatch(menu,/supportsHarnessProfiles|workspaceTools\.files|workspaceTools\.terminal|openWorkspaceTools/);
 const sidebar=fs.readFileSync(path.join(components,'AppSidebar.ets'),'utf8');
 assert.doesNotMatch(sidebar,/requestChat|sidebar\.newChat|sidebar\.conversations/);
 assert.match(sidebar,/workspaceTools\.title/);
 assert.match(sidebar,/if \(this.connectionState !== 'connected'\) return/);
 assert.doesNotMatch(sidebar,/DeviceToolsPicker|showToolsPicker/);
 assert.match(sidebar,/type: 'open-device', deviceId: this.controlTargetDeviceId/);
 for(const host of ['WideConversationHost.ets','AppRootOverlaySurfaces.ets']){
  const source=fs.readFileSync(path.join(components,host),'utf8');
  assert.match(source,/toolLocations: this.remotePageState.savedConnectionsTargetId/);
  assert.match(source,/onWorkspaceTools: this.actions.onWorkspaceTools/);
 }
});
test('device tools local default comes from serving runtime home without reading or changing workspace',async()=>{
 const f=fixture();f.vm.manager.hostInvoke=async(command,args)=>{f.calls.push({command,args});if(command==='ssh_list_saved_connections')return [];if(command==='get_system_info')return {homeDir:'/runtime-home'};if(command==='terminal_list')return [{id:'other-cwd',initialCwd:'/elsewhere',connectionId:''},{id:'ssh',connectionId:'saved'}];return {children:[],hasMore:false};};
 f.vm.dispatch({type:'open-device',deviceId:'runtime',connectionId:''});await tick();
 assert.equal(f.state.directory,'/runtime-home');assert.deepEqual(f.state.terminals.map(x=>x.id),['other-cwd']);
 assert.deepEqual(f.calls.map(x=>x.command),['ssh_list_saved_connections','get_system_info','get_directory_children_paginated','terminal_list']);
 assert.equal(f.calls[2].args.request.remoteConnectionId,'');
});
test('device tools saved SSH starts at POSIX root independently of runtime selected workspace',async()=>{
 const f=fixture();f.vm.dispatch({type:'open-device',deviceId:'runtime',connectionId:'saved-other'});await tick();
 assert.equal(f.state.directory,'/');assert.equal(f.calls[1].command,'get_directory_children_paginated');assert.equal(f.calls[1].args.request.remoteConnectionId,'saved-other');
 f.vm.dispatch({type:'directory',path:'/etc'});await tick();assert.equal(f.vm.location.path,'/etc');assert.equal(f.vm.location.remoteConnectionId,'saved-other');
});
test('device parent navigation uses serving-runtime syntax for POSIX and Windows roots',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../entry/src/main/ets/pages/policy/RuntimeLocationPolicy.ets'),'utf8');const exports={};
 new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports);
 const parent=exports.RuntimeLocationPolicy.parent;
 assert.equal(parent('/home/user'),'/home');assert.equal(parent('/'),'/');
 assert.equal(parent('C:\\Users\\name'),'C:/Users');assert.equal(parent('C:/'),'C:/');
 assert.equal(parent('\\\\server\\share\\folder'),'//server/share');
});

test('device tools rejects an unavailable SSH identity instead of falling back to local files',async()=>{
 const f=fixture();f.vm.dispatch({type:'open-device',deviceId:'runtime',connectionId:'missing'});await tick();
 assert.match(f.state.error,/Saved connection is unavailable/);
 assert.equal(f.calls.some(x=>x.command==='get_directory_children_paginated'),false);
});
test('tools tab selection retains terminal output and never issues host commands',async()=>{
 const f=fixture();f.state.output='retained';f.state.terminalId='pty';
 f.vm.dispatch({type:'panel',tab:1});f.vm.dispatch({type:'panel',tab:0});await tick();
 assert.equal(f.state.initialTab,0);assert.equal(f.state.output,'retained');assert.equal(f.state.terminalId,'pty');assert.equal(f.calls.length,0);
});

test('list forms create relative files on the selected SSH host and close after refresh',async()=>{
 const f=fixture();f.vm.dispatch({type:'file-action',text:'file'});f.vm.dispatch({type:'file-action-name',text:'new.txt'});
 f.vm.dispatch({type:'file-action-submit'});await tick();
 assert.equal(f.calls[0].command,'write_file_content');assert.equal(f.calls[0].args.request.filePath,'/project/new.txt');
 assert.equal(f.calls[0].args.request.remoteConnectionId,'saved-ssh');assert.equal(f.calls[0].args.request.expectedHash,'');
 assert.equal(f.calls[1].command,'get_directory_children_paginated');assert.equal(f.state.fileAction,'');assert.equal(f.state.editorVisible,false);
});
test('directory row deletion is non-recursive and does not need an editor selection',async()=>{
 const f=fixture();f.state.entries=[{path:'/project/folder',name:'folder',isDirectory:true}];
 f.vm.dispatch({type:'file-action',text:'delete',path:'/project/folder'});f.vm.dispatch({type:'file-action-submit'});await tick();
 assert.equal(f.calls[0].command,'delete_directory');assert.equal(f.calls[0].args.request.recursive,false);assert.equal(f.calls[0].args.request.path,'/project/folder');assert.equal(f.state.fileAction,'');
});
test('stale row keeps its form and error without sending a mutation',async()=>{
 const f=fixture();f.vm.dispatch({type:'file-action',text:'rename',path:'/project/missing'});f.vm.dispatch({type:'file-action-name',text:'rename.txt'});
 f.vm.dispatch({type:'file-action-submit'});await tick();assert.equal(f.calls.length,0);assert.equal(f.state.fileAction,'rename');
 assert.equal(f.state.fileActionName,'rename.txt');assert.match(f.state.error,/no longer available/);
});

test('conflicting save keeps the draft and original hash through retry', async () => {
 const f = fixture();
 f.vm.dispatch({ type: 'read', path: '/project/a' }); await tick();
 f.vm.dispatch({ type: 'edit', text: 'unsaved draft' });
 const originalInvoke = f.vm.manager.hostInvoke;
 let reject = true;
 const writes = [];
 f.vm.manager.hostInvoke = async (command, args) => {
  if (command === 'write_file_content') {
   writes.push(args.request);
   if (reject) throw new Error('FILE_CONFLICT: File changed after it was read');
  }
  return originalInvoke(command, args);
 };
 f.vm.dispatch({ type: 'save' }); await tick();
 assert.equal(f.state.content, 'unsaved draft');
 assert.equal(f.state.dirty, true);
 assert.equal(f.state.editorVisible, true);
 assert.match(f.state.error, /FILE_CONFLICT:/);
 reject = false;
 f.vm.dispatch({ type: 'save' }); await tick();
 assert.deepEqual(writes.map(value => value.expectedHash), ['hash:original', 'hash:original']);
 assert.equal(f.state.content, 'unsaved draft');
 assert.equal(f.state.dirty, false);
 assert.equal(f.state.error, '');
});

test('rejected provider fences a previous delayed directory response', async () => {
 const f = fixture();
 const original = f.vm.manager.hostInvoke.bind(f.vm.manager);
 let release;
 f.vm.manager.hostInvoke = async (command, args) => {
  if (command === 'get_directory_children_paginated') {
   await new Promise(resolve => { release = resolve; });
   return { children: [{path:'/previous/a',name:'a',isDirectory:false}], hasMore:false };
  }
  return original(command, args);
 };
 f.vm.dispatch({type:'directory',path:'/previous'}); await tick();
 f.vm.dispatch({type:'open-device',deviceId:'runtime',connectionId:'missing'}); await tick();
 assert.match(f.state.error,/Saved connection is unavailable/);
 release(); await tick();
 assert.deepEqual(f.state.entries,[]);
 assert.equal(f.state.directory,'');
 assert.match(f.state.error,/Saved connection is unavailable/);
});
