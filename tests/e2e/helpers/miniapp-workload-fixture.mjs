/** Installed local apps: real compiled iframe UI, SDK RPC and Bun/Node Worker. */
export function miniAppWorkloadSource({ marker, rows, points, workerIntervalMs, workItems, rpcIntervalMs }) {
  return {
    html: `<header><h1>MiniApp workload ${marker}</h1><input id="draft" aria-label="Workload draft"><button id="compute">Compute</button><output id="progress">Starting Worker</output><output id="computed"></output><canvas id="chart" width="900" height="160"></canvas></header><table><tbody id="rows"></tbody></table>`,
    css: 'body{margin:0;font:14px system-ui;color:#20242b;background:#fff}header{position:sticky;top:0;background:#eef4fa;padding:12px;z-index:1}h1{font-size:18px;margin:0}input{width:65%;padding:6px}output{display:block}canvas{display:block;width:100%;height:160px}table{border-collapse:collapse;width:100%}td{padding:6px;border-bottom:1px solid #ddd}',
    uiJs: `
const state={instance:crypto.randomUUID(),ready:false,frames:0,messages:0,rpcReplies:0,uiTicks:0,computations:0,worker:null,errors:[],inputRafMs:[],computationMs:[]};
const fail=error=>{state.errors.push(String(error));document.querySelector('#progress').textContent=String(error)};
document.querySelector('#rows').innerHTML=Array.from({length:${rows}},(_,i)=>'<tr><td>'+i+'</td><td>${marker}-'+i+'</td><td>'+i*17+'</td><td>retained</td><td>'+i%100+'</td><td>fixed workload</td></tr>').join('');
let points=[];
app.on('worker:workload',data=>{state.messages++;state.worker=data;points=data.points;document.querySelector('#progress').textContent='Worker '+data.sequence+' / '+data.checksum});
const update=async()=>{try{state.worker=await app.call('workload.stats');state.rpcReplies++;state.ready=true}catch(error){fail(error)}};
await update();
setInterval(update,${rpcIntervalMs});setInterval(()=>state.uiTicks++,100);
document.querySelector('#compute').addEventListener('click',async()=>{const started=performance.now();try{const result=await app.call('workload.compute',{iterations:${workItems}*10});state.computations++;state.lastComputation=result;document.querySelector('#computed').textContent='Result '+result.checksum;requestAnimationFrame(()=>state.computationMs.push(performance.now()-started))}catch(error){fail(error)}});
document.querySelector('#draft').addEventListener('input',()=>{const started=performance.now();requestAnimationFrame(()=>state.inputRafMs.push(performance.now()-started))});
const context=document.querySelector('#chart').getContext('2d');function draw(){state.frames++;context.clearRect(0,0,900,160);context.fillStyle='#178fba';for(let i=0;i<points.length;i++){context.fillRect((i*37+state.worker.sequence*3)%900,points[i],3,3)}requestAnimationFrame(draw)}requestAnimationFrame(draw);
window.workloadSnapshot=()=>({...state,worker:state.worker&&{...state.worker,points:undefined},draft:document.querySelector('#draft').value,scrollY,rows:document.querySelector('#rows').children.length,domNodes:document.getElementsByTagName('*').length,documentVisibility:document.visibilityState});
`,
    workerJs: `
const {randomUUID}=require('node:crypto');
const state={instance:randomUUID(),pid:process.pid,runtime:process.versions.bun?'bun':'node',sequence:0,checksum:0,processedItems:0,calls:0};
let seed=123456789;
const compute=iterations=>{let value=seed;for(let i=0;i<iterations;i++)value=(Math.imul(value,1664525)+1013904223)>>>0;seed=value;state.processedItems+=iterations;state.checksum=value;return value};
setInterval(()=>{compute(${workItems});state.sequence++;rpcEmit('workload',{...state,points:Array.from({length:${points}},(_,i)=>80+60*Math.sin(i*.1+state.sequence*.05))})},${workerIntervalMs});
module.exports={
  'workload.stats':()=>{state.calls++;return {...state}},
  'workload.compute':params=>{state.calls++;const iterations=Number(params.iterations);if(!Number.isInteger(iterations)||iterations<1||iterations>10000000)throw new Error('Invalid fixture work size');const checksum=compute(iterations);return {...state,checksum,iterations}}
};
`,
    esmDependencies: [], npmDependencies: [],
  };
}

export function miniAppFixtureRequests(protocol, workspacePath) {
  const quiet = Array.from({ length: protocol.installedApps - protocol.activeApps }, (_, index) => ({
    name: `Catalog fixture ${String(index).padStart(3, '0')}`, description: 'Installed catalog workload',
    icon: 'box', category: 'utilities', workspacePath, permissions: { node: { enabled: false } },
    source: { html: '<p>Catalog fixture</p>', css: '', uiJs: '', workerJs: '', esmDependencies: [], npmDependencies: [] },
  }));
  const active = Array.from({ length: protocol.activeApps }, (_, index) => ({
    name: `Workload ${'abc'[index]}`, description: 'Fixed rows, Canvas, real Worker and SDK RPC',
    icon: 'box', category: 'utilities', workspacePath,
    permissions: { node: { enabled: true, max_memory_mb: 256, timeout_ms: 10000 } },
    source: miniAppWorkloadSource({ ...protocol, marker: 'abc'[index] }),
  }));
  return { quiet, active };
}
