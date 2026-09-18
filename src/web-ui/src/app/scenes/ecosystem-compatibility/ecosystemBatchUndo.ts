import { applyImportUndo, type ImportUndoReview } from './ecosystemImportUndo';
import { importErrorMessage } from './ecosystemSkillImport';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';

export interface BatchUndoEntry { id: string; name: string; review: ImportUndoReview }
export interface BatchUndoResult { id: string; name: string; status: 'removed' | 'pending' | 'failed'; error?: string }

export async function applyEcosystemBatchUndo(entries: BatchUndoEntry[], workspaceId: string | undefined,
  onResult: (result: BatchUndoResult) => void) {
  const scope = getActiveSurfaceScope();
  if (!isLocalSurface(scope.surfaceId)) throw new Error('External batch undo requires the local host');
  // Every MCP removal reviewed the same config. Publish their union with one CAS,
  // so later removals cannot restore entries removed earlier in the batch.
  const mcp = entries.filter((entry) => entry.review.kind === 'mcp');
  if (mcp.length) {
    try {
      scope.assertCurrent('remove reviewed MCP batch');
      const first = mcp[0].review;
      if (first.kind !== 'mcp') throw new Error('Invalid MCP removal review');
      const config = JSON.parse(first.jsonConfig);
      for (const entry of mcp) {
        if (entry.review.kind !== 'mcp' || entry.review.fingerprint !== first.fingerprint) throw new Error('MCP configuration changed; review the batch again');
        delete config.mcpServers[entry.review.target];
      }
      const result = await applyImportUndo({ ...first, jsonConfig: JSON.stringify(config, null, 2) }, workspaceId);
      mcp.forEach(({ id, name }) => onResult({ id, name, status: result.runtimeApplied ? 'removed' : 'pending' }));
    } catch (error) { mcp.forEach(({ id, name }) => onResult({ id, name, status: 'failed', error: importErrorMessage(error) })); }
  }
  const revisions = new Map<string, string>();
  for (const entry of entries) {
    if (entry.review.kind === 'mcp') continue;
    try {
      scope.assertCurrent('remove reviewed imported copy');
      const original = entry.review;
      const review = original.kind === 'hook' ? { ...original, revision: revisions.get(original.revision) ?? original.revision } : original;
      const result = await applyImportUndo(review, workspaceId);
      // Advance only through revisions returned by our own successful removals.
      // An unrelated edit still fails the next compare-and-swap.
      if (original.kind === 'hook' && result.revision) revisions.set(original.revision, result.revision);
      onResult({ id: entry.id, name: entry.name, status: result.runtimeApplied ? 'removed' : 'pending' });
    } catch (error) { onResult({ id: entry.id, name: entry.name, status: 'failed', error: importErrorMessage(error) }); }
  }
}
