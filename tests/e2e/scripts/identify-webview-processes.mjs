import assert from 'node:assert/strict';

/** Causal diagnostic, outside timing windows. Does not claim a native PID API. */
export async function identifyWebviewProcesses(page, sample, pulseMs = 400, additionalHandles = []) {
  const handles = await page.request(`/session/${page.session}/window/handles`);
  if (additionalHandles.length) {
    // The embedded driver's WebviewWindow inventory omits child WebViews and
    // can omit main after it gains children. Exact view-label switching works.
    // Use the native inventory for all requested views in this case.
    await page.request(`/session/${page.session}/window`, { handle: 'main' });
    const views = await page.invoke('plugin:webview|get_all_webviews');
    for (const handle of ['main', 'agent-companion-pet']) {
      if (views.some(view => view.label === handle) && !handles.includes(handle)) handles.push(handle);
    }
    for (const handle of additionalHandles) {
      assert.ok(views.some(view => view.label === handle), `Missing native WebView: ${handle}`);
      if (!handles.includes(handle)) handles.push(handle);
    }
  }
  const identities = [];
  try {
    for (const handle of handles) {
      if (handle !== 'main' && handle !== 'agent-companion-pet' && !additionalHandles.includes(handle)) continue;
      await page.request(`/session/${page.session}/window`, { handle });
      const trials = [];
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = await sample();
        const elapsedMs = await page.execute(duration => {
          const start = performance.now();
          while (performance.now() - start < duration) { /* Isolated diagnostic CPU pulse. */ }
          return performance.now() - start;
        }, pulseMs);
        const after = await sample();
        const deltas = after.processes.filter(process => /WebContent/.test(process.name) && !process.error).flatMap(process => {
          const old = before.processes.find(row => row.pid === process.pid && row.startTicks === process.startTicks && !row.error);
          return old ? [{ pid: process.pid, startTicks: process.startTicks, cpuMs: process.cpuMs - old.cpuMs }] : [];
        }).sort((a, b) => b.cpuMs - a.cpuMs);
        assert.ok(deltas.length && deltas[0].cpuMs >= elapsedMs * .65
          && deltas[0].cpuMs - (deltas[1]?.cpuMs ?? 0) >= pulseMs * .5,
        `Ambiguous WebContent attribution for ${handle}: ${JSON.stringify(deltas)}`);
        trials.push({ elapsedMs, deltas, pid: deltas[0].pid, startTicks: deltas[0].startTicks });
      }
      assert.equal(trials[0].pid, trials[1].pid, 'Both independent pulses must identify the same process');
      assert.equal(trials[0].startTicks, trials[1].startTicks, 'The WebContent process must survive attribution');
      identities.push({ handle, pid: trials[0].pid, startTicks: trials[0].startTicks, trials,
        basis: 'two-out-of-window-CPU-pulses', visible: additionalHandles.includes(handle)
          ? await page.execute(() => document.visibilityState === 'visible')
          : await page.invoke('plugin:window|is_visible', { label: handle }) });
    }
  } finally {
    await page.request(`/session/${page.session}/window`, { handle: 'main' });
  }
  assert.ok(identities.some(identity => identity.handle === 'main'), 'Main view attribution is required');
  return identities;
}
