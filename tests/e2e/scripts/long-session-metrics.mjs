/** Protocol-owned math; empty distributions remain unknown, never zero-latency success. */
export function distribution(values) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing sample');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { count: values.length, p50Ms: rank(.5), p90Ms: rank(.9), p95Ms: rank(.95), p99Ms: rank(.99),
    maxMs: sorted.at(-1) ?? null, meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

export function frameMetrics(times, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid frame window');
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]))) {
    throw new Error('Non-monotonic RAF timestamps');
  }
  // Include full intervals crossing input edges. Do not dilute an active operation with idle settling.
  const intervals = times.slice(1).flatMap((time, index) =>
    time >= start && times[index] < end ? [time - times[index]] : []);
  const durationMs = intervals.reduce((a, b) => a + b, 0);
  let run = 0, longestStallFrames = 0, stallEpisodes = 0;
  for (const interval of intervals) {
    if (interval > 1000 / 30) { if (!run) stallEpisodes++; longestStallFrames = Math.max(longestStallFrames, ++run); }
    else run = 0;
  }
  return { ...distribution(intervals), durationMs,
    rafFps: durationMs ? intervals.length * 1000 / durationMs : null,
    overBudget: [1000 / 30, 50, 100].map(thresholdMs => {
      const count = intervals.filter(value => value > thresholdMs).length;
      return { thresholdMs, count, percent: intervals.length ? count * 100 / intervals.length : null };
    }), stallEpisodes, longestStallFrames };
}

export function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.state}/${sample.scenario}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups].map(([name, rows]) => {
    const valid = rows.filter(row => row.valid);
    const times = valid.flatMap(row => row.probe.times);
    // Pool intervals, not concatenated timestamps from separate probes.
    const frames = valid.map(row => frameMetrics(row.probe.times, row.probe.actionAt, row.probe.endAt));
    const count = frames.reduce((n, frame) => n + frame.count, 0);
    const duration = frames.reduce((n, frame) => n + frame.durationMs, 0);
    const intervals = valid.flatMap(row => row.probe.times.slice(1).flatMap((time, index) =>
      time >= row.probe.actionAt && row.probe.times[index] < row.probe.endAt ? [time - row.probe.times[index]] : []));
    return { name, samples: rows.length, validSamples: valid.length,
      focusStates: [...new Set(valid.map(row => row.probe.focus))],
      latency: distribution(valid.map(row => row.probe.latencyMs).filter(value => value !== null)),
      frame: { ...distribution(intervals), rafFps: duration ? count * 1000 / duration : null,
        slowFramePercent: count ? intervals.filter(ms => ms > 1000 / 30).length * 100 / count : null },
      longTasks: valid.length && valid.every(row => row.probe.longTasksSupported)
        ? { count: valid.reduce((count, row) => count + row.probe.longTasks.length, 0),
          durationMs: valid.flatMap(row => row.probe.longTasks).reduce((sum, task) => sum + task.durationMs, 0) } : null,
      rawRafSamples: times.length };
  });
}

export function renderReport(report) {
  const escape = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const format = value => value === null || value === undefined ? '—' : typeof value === 'number' ? value.toFixed(2) : escape(value);
  const columns = ['Scenario', 'Valid / total', 'Latency P50 ms', 'Latency P95 ms', 'RAF FPS', 'Frame P95 ms', 'Frame max ms', 'Frames >33.33 ms %', 'Long tasks', 'Focus'];
  const rows = report.summary.map(row => [row.name, `${row.validSamples}/${row.samples}`, row.latency.p50Ms, row.latency.p95Ms,
    row.frame.rafFps, row.frame.p95Ms, row.frame.maxMs, row.frame.slowFramePercent, row.longTasks?.count, row.focusStates?.join('/')]);
  const csv = [columns, ...rows].map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Long session performance</title>
<style>body{font:15px system-ui;margin:32px;color:#222}table{border-collapse:collapse}th,td{padding:10px;border:1px solid #ccc;text-align:right}td:first-child{text-align:left}pre{white-space:pre-wrap}small{display:block;max-width:1100px;margin:12px 0}</style>
<h1>Desktop long session performance</h1><p>Functional: ${escape(report.functionalPassed)} · Budgets: ${escape(report.performanceBudgetsPassed)} · Instrumented: ${escape(report.instrumented ?? false)} · ${escape(report.environment.platform)} · ${escape(report.nativeProfile)}</p>
<small>First-open means first UI entry in this process, not a cold disk or OS-cache measurement. Streaming sessions are restored in the runtime before first UI entry. RAF FPS measures presentation opportunities, not compositor completion. Scroll latency is first wheel to first observed movement; other latency is input to target readiness plus two RAF opportunities. Short action frame distributions have few samples; inspect raw data. ${report.protocol.suite === 'btw-scroll' ? 'Primary and BTW panes stream concurrently in equal controlled output batches; preparation and reader checks are outside timed windows.' : report.protocol.suite === 'streaming-switch' ? 'Streaming-switch uses equal controlled output batches; readiness waits between batches are outside timed windows.' : 'Static runs precede streaming runs.'}</small>
<table><thead><tr>${columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${format(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<h2>Failures</h2><pre>${escape(JSON.stringify(report.failures, null, 2))}</pre><h2>Protocol</h2><pre>${escape(JSON.stringify(report.protocol, null, 2))}</pre><small>See result.json for raw frame timestamps, stream counters, environment and hashes. Remote workspace, remote control, Peer Device Mode and Detached Dispatch were not exercised.</small></html>`;
  return { csv, html };
}
