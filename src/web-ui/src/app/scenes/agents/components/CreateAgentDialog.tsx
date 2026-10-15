import { Dialog, DialogClose, DialogHeader, DialogHeading, DialogTitle } from '@openbitfun/ui';
import { useSyncExternalStore } from 'react';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import CreateAgentPage from './CreateAgentPage';

export default function CreateAgentDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n('scenes/agents');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const { workspace } = useCurrentWorkspace();

  return (
    <Dialog open onOpenChange={onClose} size="xl">
      <DialogHeader>
        <DialogHeading><DialogTitle>{t('agentsOverview.form.title')}</DialogTitle></DialogHeading>
        <DialogClose />
      </DialogHeader>
      <CreateAgentPage
        key={scope.key(scope.epoch, workspace?.id)}
        standalone
        onCancel={onClose}
        onCreated={() => { onClose(); onCreated(); }}
      />
    </Dialog>
  );
}
