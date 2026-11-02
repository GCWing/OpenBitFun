import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { isLocalSurface, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';

export function useProjectDirectoryActions(workspace: WorkspaceInfo, scope: SurfaceScope, isActive: boolean) {
  const { t } = useI18n('scenes/project-resources');
  const { updateWorkspaceRelatedPaths } = useWorkspaceContext();
  const latest = useRef({ workspace, isActive });
  latest.current = { workspace, isActive };
  const mounted = useRef(true);
  const pending = useRef(false);
  const revealing = useRef(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [revealingPath, setRevealingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canReveal = isLocalSurface(scope.surfaceId) && isTauriRuntime()
    && !isRemoteWorkspace(workspace) && !workspace.connectionId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reveal = useCallback(async (path: string) => {
    const current = () => mounted.current && scope.isCurrent() && latest.current.isActive
      && latest.current.workspace.id === workspace.id;
    const owner = latest.current.workspace;
    if (revealing.current || !current() || !canReveal || isRemoteWorkspace(owner) || owner.connectionId
      || !path.trim() || (path !== owner.rootPath && !owner.relatedPaths?.some(directory => directory.path === path))) return;
    revealing.current = true;
    setRevealingPath(path);
    setError(null);
    try {
      await workspaceAPI.revealInExplorer(path, workspace.id);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : t('directories.revealFailed'));
    } finally {
      revealing.current = false;
      if (mounted.current && scope.isCurrent() && latest.current.workspace.id === workspace.id) setRevealingPath(null);
    }
  }, [canReveal, scope, t, workspace.id]);
  const remove = useCallback(async (path: string) => {
    const current = () => mounted.current && scope.isCurrent() && latest.current.isActive
      && latest.current.workspace.id === workspace.id;
    const canRemove = () => path !== latest.current.workspace.rootPath
      && latest.current.workspace.relatedPaths?.some(directory => directory.path === path);
    if (pending.current || !current() || !canRemove()) return;
    pending.current = true;
    setError(null);
    try {
      const confirmed = await confirmDialog({ title: t('directories.removeTitle'), message: t('directories.removeMessage'),
        type: 'warning', confirmDanger: true, confirmText: t('directories.removeConfirm') });
      if (!confirmed || !current() || !canRemove()) return;
      setRemovingPath(path);
      // Re-read after confirmation so directories added elsewhere are preserved.
      await updateWorkspaceRelatedPaths(workspace.id, latest.current.workspace.relatedPaths!.filter(directory => directory.path !== path));
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : t('directories.removeFailed'));
    } finally {
      pending.current = false;
      if (mounted.current && scope.isCurrent()) setRemovingPath(null);
    }
  }, [scope, t, updateWorkspaceRelatedPaths, workspace.id]);
  return { remove, removingPath, reveal, canReveal, revealingPath, error };
}
