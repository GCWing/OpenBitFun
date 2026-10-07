import React, { useMemo } from 'react';
import { FlowGroup, type FlowGroupProps } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { useSnapshotState } from '@/tools/snapshot_system/hooks/useSnapshotState';
import { FileEditGroupContext } from '../../grouping/FileEditGroupContext';
import { useFileOperationDiffStats } from '../../tool-cards/useFileOperationDiffStats';
import { sumFileOperationDiffStats } from '../../tool-cards/fileOperationDiffStats';
import type { FlowItem, FlowToolItem } from '../../types/flow-chat';

/** Resolve totals before deferred member cards mount, and share the exact values with them. */
export const FileEditGroupView = React.forwardRef<HTMLDivElement, FlowGroupProps & {
  items: readonly FlowItem[];
  sessionId?: string;
}>(function FileEditGroupView({ items, sessionId, fileRevision, ...props }, ref) {
  const { t, formatNumber } = useI18n('flow-chat');
  const { surfaceEpoch, snapshotsAvailable } = useSnapshotState(sessionId);
  const tools = useMemo(() => items.filter((item): item is FlowToolItem => item.type === 'tool'), [items]);
  const diffStats = useFileOperationDiffStats(tools, { sessionId, surfaceEpoch, snapshotsAvailable });
  const total = sumFileOperationDiffStats(diffStats.values());
  const additions = formatNumber(total.additions);
  const deletions = formatNumber(total.deletions);
  const revisionLabels = useMemo(() => new Map(tools.map((item, index) =>
    [item.id, t('fileEditGroup.revision', { count: formatNumber(index + 1) })])), [tools, t, formatNumber]);
  const context = useMemo(() => ({ revisionLabels, diffStats }), [revisionLabels, diffStats]);

  return <FileEditGroupContext.Provider value={context}>
    <FlowGroup {...props} ref={ref} fileRevision={fileRevision && { ...fileRevision,
      changeSummary: { additions, deletions, label: t('toolCards.file.changeSummary', { additions, deletions }) },
    }} data-openbitfun-component="file-edit-group" data-openbitfun-part="root" data-testid="chat-file-edit-group" />
  </FileEditGroupContext.Provider>;
});
