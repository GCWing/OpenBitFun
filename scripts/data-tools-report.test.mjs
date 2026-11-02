import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportRows } from '../src/apps/data-tools/ui/report.mjs';

const text = { sessions: 'Sessions', workspaces: 'Workspaces', assistantDirectories: 'Assistants', imported: 'imported', staged: 'staged', skipped: 'skipped', itemCountsUnavailable: 'unavailable' };
const report = { domainResults: [{ domain: 'workspace_sessions', state: 'verified', imported: 175, skipped: 173, warnings: [{ severity: 'info', code: 'session_path_not_migrated' }] }] };
const counts = { sessions: { imported: 143, skipped: 0 }, workspaces: { imported: 30, skipped: 0 }, assistantDirectories: { imported: 2, skipped: 0 } };
test('renders separate entity counts and hides auxiliary exclusions', () => {
  assert.deepEqual(reportRows(report, counts, text), [
    ['Sessions', '143 imported, 0 skipped'], ['Workspaces', '30 imported, 0 skipped'], ['Assistants', '2 imported, 0 skipped'],
  ]);
});
test('retains real warnings and does not label staged data imported', () => {
  const staged = structuredClone(report);
  staged.domainResults[0].state = 'failed';
  staged.domainResults[0].warnings.push({ severity: 'warning', code: 'session_source_skipped' });
  const rows = reportRows(staged, counts, text);
  assert.equal(rows[0][1], '143 staged, 0 skipped');
  assert.deepEqual(rows.at(-1), ['workspace_sessions', 'session_source_skipped']);
});
test('missing historical manifest is explicit instead of inventing zero counts', () => {
  assert.deepEqual(reportRows(report, null, text), [['Sessions', 'unavailable'], ['Workspaces', 'unavailable'], ['Assistants', 'unavailable']]);
});
