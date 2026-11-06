import assert from 'node:assert/strict';
import test from 'node:test';
import { identifyWebviewProcesses } from './identify-webview-processes.mjs';

function fixture({ child = true, ambiguous = false, multiViewWindow = false } = {}) {
  let active = 'main';
  const cpu = [0, 0, 0], order = [];
  const ids = { main: 11, 'agent-companion-pet': 12, child: 13 };
  const page = {
    session: 'fixture',
    async request(route, body) {
      if (route.endsWith('/window/handles')) return multiViewWindow ? ['agent-companion-pet'] : ['main', 'agent-companion-pet'];
      active = body.handle; order.push(active);
    },
    async invoke(command) {
      if (command === 'plugin:webview|get_all_webviews') return ['main', 'agent-companion-pet', ...(child ? ['child'] : [])].map(label => ({ label }));
      assert.equal(command, 'plugin:window|is_visible');
      assert.notEqual(active, 'child', 'Child visibility is not a top-level window API');
      return true;
    },
    async execute(fn, duration) {
      if (duration === undefined) return false;
      cpu[ids[active] - 11] += duration;
      if (ambiguous) cpu[(ids[active] - 10) % 3] += duration;
      return duration;
    },
  };
  const sample = async () => ({ processes: cpu.map((cpuMs, index) => ({ pid: index + 11, startTicks: `${index}`, name: 'WebContent', cpuMs })) });
  return { page, sample, order, active: () => active };
}
test('default identification retains top-level window scope', async () => {
  const f = fixture();
  const result = await identifyWebviewProcesses(f.page, f.sample);
  assert.deepEqual(result.map(item => item.handle), ['main', 'agent-companion-pet']);
  assert.equal(f.active(), 'main');
});
test('child views come from native inventory and use document visibility', async () => {
  const f = fixture();
  const result = await identifyWebviewProcesses(f.page, f.sample, 400, ['child']);
  assert.equal(result.find(item => item.handle === 'child').pid, 13);
  assert.equal(result.find(item => item.handle === 'child').visible, false);
  assert.equal(f.active(), 'main');
});
test('main remains attributable when WebviewWindow inventory omits its multi-view window', async () => {
  const f = fixture({ multiViewWindow: true });
  const result = await identifyWebviewProcesses(f.page, f.sample, 400, ['child']);
  assert.equal(result.find(item => item.handle === 'main').pid, 11);
  assert.equal(result.length, 3);
  assert.equal(f.active(), 'main');
});
test('missing native child is rejected rather than falsely attributed', async () => {
  const f = fixture({ child: false });
  await assert.rejects(identifyWebviewProcesses(f.page, f.sample, 400, ['child']), /Missing native WebView/);
  assert.equal(f.active(), 'main');
});
test('ambiguous CPU pulses fail and restore main execution context', async () => {
  const f = fixture({ ambiguous: true });
  await assert.rejects(identifyWebviewProcesses(f.page, f.sample, 400, ['child']), /Ambiguous WebContent attribution/);
  assert.equal(f.active(), 'main');
});
