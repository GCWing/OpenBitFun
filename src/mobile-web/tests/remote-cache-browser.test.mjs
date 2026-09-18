import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

// Persisted shape written by pre-ID builds: no workspace_id on sessions,
// provenance, or catalog rows. Upgraded code must read it unchanged.
const PATH = '/projects/herdr';
const ssh = { path: PATH, remote_connection_id: 'ssh-a', remote_ssh_host: 'host-a' };
const row = (id, identity) => ({
  session_id: id, name: id, agent_type: 'agentic', created_at: '1', updated_at: '1',
  message_count: 0, workspace_path: PATH, ...(identity ? { workspace_identity: identity } : {}),
});
const oldRecord = {
  sessions: [row('ssh', ssh), row('local', { path: PATH }), row('bare')],
  workspaces: [{ ...ssh, name: 'A', last_opened: '' }, { path: PATH, name: 'Local', last_opened: '' }],
  workspaceCatalogSource: 'opened',
  updatedAt: 1,
};

test('real IndexedDB: an old-shape session cache record loads and is attributed through the compatibility helper', { timeout: 40000 }, async () => {
  const source = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(source.origin);
    const result = await page.evaluate(async ({ record, freshRow }) => {
      const { createRemoteCacheScope, remoteCache } = await import('/src/services/RemoteCache.ts');
      const { sessionMatchesWorkspace } = await import('/src/services/workspaceIdentity.ts');
      const scope = createRemoteCacheScope('acct', 'desktop-a');
      // Seed the store exactly as an old build would have, before the module opens it.
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('openbitfun-mobile-remote-cache', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('session_state', { keyPath: 'key' });
          db.createObjectStore('transcripts', { keyPath: 'key' }).createIndex('deviceKey', 'deviceKey', { unique: false });
        };
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('session_state', 'readwrite');
          transaction.objectStore('session_state').put({ key: scope.key, accountId: scope.accountId, deviceId: scope.deviceId, ...record });
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      });
      const loaded = await remoteCache.loadSessionState(scope);
      const upgraded = [
        { ...record.workspaces[0], workspace_id: 'ws-a' },
        { ...record.workspaces[1], workspace_id: 'ws-local' },
      ];
      const attributed = (sessions, workspace, catalog) => sessions
        .filter(session => sessionMatchesWorkspace(session, workspace, catalog))
        .map(session => session.session_id);
      const before = {
        sessionIds: loaded.sessions.map(session => session.session_id).sort(),
        sshByOldCatalog: attributed(loaded.sessions, record.workspaces[0], record.workspaces),
        localByOldCatalog: attributed(loaded.sessions, record.workspaces[1], record.workspaces),
        sshByUpgraded: attributed(loaded.sessions, upgraded[0], upgraded),
        localByUpgraded: attributed(loaded.sessions, upgraded[1], upgraded),
      };
      // An ID-scoped listing from the upgraded host is merged into the old record.
      remoteCache.saveWorkspaceCatalog(scope, upgraded, 'opened');
      remoteCache.saveSessionPage(scope, [freshRow], {
        workspacePath: record.workspaces[1].path,
        workspaceIdentity: { workspaceId: 'ws-local' },
        replaceWorkspace: true,
      });
      let after = null;
      for (let attempt = 0; attempt < 100 && !after?.sessions.some(session => session.session_id === 'fresh'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        after = await remoteCache.loadSessionState(scope);
      }
      const fresh = after.sessions.find(session => session.session_id === 'fresh');
      return {
        before,
        afterIds: after.sessions.map(session => session.session_id).sort(),
        freshIdentity: fresh?.workspace_identity,
        freshWorkspaceId: fresh?.workspace_id,
        localByUpgraded: attributed(after.sessions, after.workspaces[1], after.workspaces),
        sshByUpgraded: attributed(after.sessions, after.workspaces[0], after.workspaces),
        catalogIds: after.workspaces.map(workspace => workspace.workspace_id),
        sshRowUnchanged: JSON.stringify(after.sessions.find(session => session.session_id === 'ssh'))
          === JSON.stringify(record.sessions[0]),
      };
    }, { record: oldRecord, freshRow: { ...row('fresh'), workspace_id: 'ws-local' } });
    assert.deepEqual(result.before.sessionIds, ['bare', 'local', 'ssh']);
    assert.deepEqual(result.before.sshByOldCatalog, ['ssh']);
    assert.deepEqual(result.before.localByOldCatalog, ['local']);
    assert.deepEqual(result.before.sshByUpgraded, ['ssh']);
    assert.deepEqual(result.before.localByUpgraded, ['local']);
    // The refresh replaced the stale local row, kept the SSH and unresolvable rows, and stamped the ID.
    assert.deepEqual(result.afterIds, ['bare', 'fresh', 'ssh']);
    assert.equal(result.freshWorkspaceId, 'ws-local');
    // Absent SSH selectors serialize as missing keys across the evaluate boundary.
    assert.deepEqual(result.freshIdentity, { workspace_id: 'ws-local', path: PATH });
    assert.deepEqual(result.localByUpgraded, ['fresh']);
    assert.deepEqual(result.sshByUpgraded, ['ssh']);
    assert.deepEqual(result.catalogIds, ['ws-a', 'ws-local']);
    assert.equal(result.sshRowUnchanged, true);
  } finally {
    await browser.close();
    await source.close();
  }
});
