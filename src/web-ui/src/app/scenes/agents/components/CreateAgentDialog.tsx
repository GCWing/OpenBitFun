import { Dialog } from '@openbitfun/ui';
import { useId, useSyncExternalStore } from 'react';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import CreateAgentPage from './CreateAgentPage';
import type { WorkspaceInfo } from '@/shared/types';
import type { CustomAgentLevel } from '@/infrastructure/api/service-api/CustomAgentAPI';

export default function CreateAgentDialog({ onClose, onCreated, workspace: targetWorkspace, initialLevel }: {
  onClose: () => void;
  onCreated: () => void;
  workspace?: WorkspaceInfo;
  initialLevel?: CustomAgentLevel;
}) {
  const titleId = useId();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const current = useCurrentWorkspace();
  const workspace = targetWorkspace ?? current.workspace;

  return (
    <Dialog open onOpenChange={onClose} size="2xl" aria-labelledby={titleId}>
      <CreateAgentPage
        key={scope.key(scope.epoch, workspace?.id)}
        standalone
        workspace={targetWorkspace}
        initialLevel={initialLevel}
        titleId={titleId}
        onCancel={onClose}
        onCreated={() => { onClose(); onCreated(); }}
      />
    </Dialog>
  );
}
