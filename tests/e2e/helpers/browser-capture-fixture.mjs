import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBrowserWorkloadFixture } from './browser-workload-fixture.mjs';

/** Static pixel oracle after the real Agent has opened a session-owned WebView. */
export async function createBrowserCaptureFixture() {
  const model = await createBrowserWorkloadFixture({ rows: 1, points: 1, workerIntervalMs: 1000 });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Native capture fixture</title>
<style>html,body{margin:0;background:#fff;color:#132846;font:16px system-ui}main{min-height:1600px;padding:20px}
h1{font-size:24px}section{display:flex;height:96px}section i{flex:1;background:var(--color)}
canvas{display:block;width:100%;height:240px}article{line-height:32px;border:1px solid #487ba1;padding:12px}
</style></head><body><main id="capture-fixture"><h1>Native screenshot · 中文 0123456789</h1>
<section><i style="--color:#ff0000"></i><i style="--color:#00ff00"></i><i style="--color:#0000ff"></i><i style="--color:#000000"></i></section>
<canvas width="900" height="240"></canvas><article>Static text, gradients, fine edges and transparency.<br>静态截图像素验证：保留尺寸、颜色和透明混合。<br>ABCDEFGHIJKLMNOPQRSTUVWXYZ</article>
</main><script>const c=document.querySelector('canvas').getContext('2d');
const gradient=c.createLinearGradient(0,0,900,240);gradient.addColorStop(0,'#1463ff');gradient.addColorStop(.5,'#f0ab37');gradient.addColorStop(1,'#e31a7b');
c.fillStyle=gradient;c.fillRect(0,0,900,240);c.fillStyle='rgba(20,60,120,.35)';c.fillRect(60,20,300,180);
c.fillStyle='#fff';for(let x=0;x<900;x+=17)c.fillRect(x,210,1,20);</script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { ...model, captureUrl: `http://127.0.0.1:${server.address().port}/capture`, async close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await model.close();
  } };
}
