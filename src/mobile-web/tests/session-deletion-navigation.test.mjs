import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const load = async (path) => {
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
};
const { nearestSurvivingSession } = await load('../src/services/sessionDeletionNavigation.ts');

const row = (id) => ({ session_id: id, name: id });
const project = { path: '/project' };
const other = { path: '/other' };

test('deleting an open middle row selects the next row in the same workspace', () => {
  const next = nearestSurvivingSession([
    { owner: other, sessions: [row('o1')] },
    { owner: project, sessions: [row('a'), row('b'), row('c')] },
  ], 'b');
  assert.equal(next.session.session_id, 'c');
  assert.equal(next.owner, project);
});

test('deleting the last row selects the previous row', () => {
  const next = nearestSurvivingSession([{ owner: project, sessions: [row('a'), row('b')] }], 'b');
  assert.equal(next.session.session_id, 'a');
});

test('the only session in its workspace leaves the empty panel instead of another workspace', () => {
  assert.equal(nearestSurvivingSession([
    { owner: project, sessions: [row('a')] },
    { owner: other, sessions: [row('o1')] },
  ], 'a'), null);
});

test('an unlisted session falls through to the flat list, then to the empty panel', () => {
  const flat = nearestSurvivingSession([
    { owner: project, sessions: [row('a')] },
    { sessions: [row('x'), row('y')] },
  ], 'x');
  assert.equal(flat.session.session_id, 'y');
  assert.equal(flat.owner, undefined);
  assert.equal(nearestSurvivingSession([{ sessions: [row('a')] }], 'missing'), null);
});

test('the session list hands deletion of the open session to the app shell', async () => {
  const page = await readFile(new URL('../src/pages/SessionListPage.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const handleDelete = page.slice(page.indexOf('const handleDelete = useCallback'), page.indexOf('const [pullDistance'));
  assert.match(handleDelete, /deleteConfirmTarget\.session_id === activeSessionId/);
  assert.match(handleDelete, /onActiveSessionDeleted\?\.\(/);
  assert.match(app, /onActiveSessionDeleted=\{handleActiveSessionDeleted\}/);
});
