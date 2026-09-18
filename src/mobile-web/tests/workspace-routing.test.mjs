import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const code = ts.transpileModule(await readFile(new URL('../src/services/workspaceIdentity.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { normalizeWorkspaceRouting, projectWorkspaceCatalog } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('1.0.0 local markers cannot select SSH after a catalog JSON round trip', () => {
  for (const workspace_kind of ['normal', 'assistant']) {
    const old = JSON.parse(JSON.stringify({ path: '/project', workspace_kind, remote_ssh_host: 'localhost' }));
    const current = normalizeWorkspaceRouting(old);
    assert.equal(current.remote_ssh_host, undefined);
    assert.equal(current.workspace_kind, workspace_kind);
    assert.equal(old.remote_ssh_host, 'localhost');
    const catalog = projectWorkspaceCatalog({ workspaces: [old] });
    assert.equal(catalog.workspaces[0].remote_ssh_host, undefined);
  }
});
test('real localhost SSH and unknown legacy types retain their identity for the host to resolve', () => {
  for (const workspace_kind of ['remote', undefined]) {
    const old = { path: '/project', workspace_kind, remote_connection_id: 'saved', remote_ssh_host: 'localhost' };
    assert.deepEqual(normalizeWorkspaceRouting(old), old);
  }
});
