import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Fixed loopback content and model responses; Agent/browser execution is real. */
export async function createBrowserWorkloadFixture({ rows, points, workerIntervalMs }) {
  const errors = [], results = new Map(), requests = [];
  let url;
  const respondModel = (res, marker, tool) => {
    const input = { domain: 'browser', action: 'navigate',
      params: { target: 'builtin', url: `${url}/pages/${marker}`, observe: 'article' } };
    const events = [
      { type: 'message_start', message: { id: marker, type: 'message', role: 'assistant', model: 'browser-workload', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: `browser-${marker}`, name: 'ControlHub', input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: `BROWSER_WORKLOAD_${marker}_COMPLETE` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  };
  const server = createServer(async (req, res) => {
    try {
      const address = new URL(req.url, url);
      if (address.pathname === '/worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(`let sequence=0;setInterval(()=>{const values=new Float32Array(${points}*2);for(let i=0;i<${points};i++){values[i*2]=(i*37+sequence*3)%900;values[i*2+1]=80+60*Math.sin(i*.1+sequence*.05)}postMessage({sequence:++sequence,values},[values.buffer])},${workerIntervalMs});`);
        return;
      }
      if (address.pathname.startsWith('/pages/')) {
        const marker = address.pathname.split('/').at(-1);
        assert.match(marker, /^[abc]$/);
        requests.push({ marker, at: Date.now() });
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Browser workload ${marker}</title>
<style>body{margin:0;font:14px system-ui;color:#20242b;background:#fff}header{position:sticky;top:0;background:#eef4fa;padding:12px;z-index:1}h1{font-size:18px;margin:0}input{width:90%;padding:6px}canvas{display:block;width:100%;height:160px}table{border-collapse:collapse;width:100%}td{padding:6px;border-bottom:1px solid #ddd}</style></head>
<body><header><h1>BROWSER_WORKLOAD_${marker}</h1><input id="draft" aria-label="Browser workload draft" value=""><output id="status">Starting</output><canvas id="chart" width="900" height="160"></canvas></header>
<table><tbody>${Array.from({ length: rows }, (_, i) => `<tr><td>${i}</td><td>record-${marker}-${i}</td><td>${i * 17}</td><td>queued</td><td>${i % 100}</td><td>retained row</td></tr>`).join('')}</tbody></table>
<script>window.workload={instance:crypto.randomUUID(),ticks:0,workerMessages:0,frames:0,rows:${rows},points:${points}};
setInterval(()=>window.workload.ticks++,100);
let values=new Float32Array(${points}*2);const worker=new Worker('/worker.js');
worker.onmessage=event=>{window.workload.workerMessages++;values=event.data.values;document.querySelector('#status').textContent='Update '+event.data.sequence};
const context=document.querySelector('#chart').getContext('2d');function draw(){window.workload.frames++;context.clearRect(0,0,900,160);context.fillStyle='#178fba';for(let i=0;i<values.length;i+=2){context.fillRect(values[i],values[i+1],3,3)}requestAnimationFrame(draw)}requestAnimationFrame(draw);
window.workloadSnapshot=()=>({...window.workload,draft:document.querySelector('#draft').value,scrollY,visibility:document.visibilityState,ready:document.readyState,domNodes:document.getElementsByTagName('*').length,url:location.href});
</script></body></html>`);
        return;
      }
      if (address.pathname !== '/v1/messages') { res.writeHead(404); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const messages = body.messages ?? [];
      const markers = messages.filter(message => message.role === 'user').flatMap(message => {
        const content = typeof message.content === 'string' ? message.content
          : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
        return [...content.matchAll(/BROWSER_WORKLOAD_([abc])(?!\w)/g)].map(match => match[1]);
      });
      const marker = markers.at(-1);
      if (!marker) { respondModel(res, 'aux', false); return; }
      const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === `browser-${marker}`);
      if (result) { results.set(marker, result); respondModel(res, marker, false); return; }
      assert.ok(body.tools?.some(tool => tool.name === 'ControlHub'), 'Real tool catalog must expose ControlHub');
      respondModel(res, marker, true);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, errors, results, requests, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
