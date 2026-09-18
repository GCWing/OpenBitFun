import React from 'react';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import ScheduledJobsView from '@/app/components/scheduled-jobs/ScheduledJobsView';
import type { CronJobTargetKind } from '@/infrastructure/api';
import type { WorkspaceKind } from '@/shared/types';
import './ScheduledJobsModal.scss';

interface ScheduledJobsModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId?: string;
  workspaceKind?: WorkspaceKind;
  sessionId?: string;
  targetKind: CronJobTargetKind;
  lockSessionId?: boolean;
  title?: string;
  targetLabel?: string;
  targetDescription?: string;
}

const ScheduledJobsModal: React.FC<ScheduledJobsModalProps> = ({
  isOpen,
  onClose,
  workspaceId,
  workspaceKind,
  sessionId,
  targetKind,
  lockSessionId = false,
  title,
  targetLabel,
  targetDescription,
}) => {
  const { t } = useI18n('common');

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      size="xl"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{title || t('nav.scheduledJobs.title')}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody inset="none">
      <div data-openbitfun-component="scheduled-jobs-modal" data-openbitfun-part="body" className="scheduled-jobs-modal__body">
        <ScheduledJobsView
          workspaceId={workspaceId}
          workspaceKind={workspaceKind}
          sessionId={sessionId}
          targetKind={targetKind}
          lockSessionId={lockSessionId}
          headerTitle={null}
          targetLabel={targetLabel}
          targetDescription={targetDescription}
        />
      </div>
          </DialogBody>
    </Dialog>
  );
};

export default ScheduledJobsModal;
