import { FileEdit, TriangleAlert } from 'lucide-react';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton/IconButton';
import { OverflowText } from '../../primitives/OverflowText';
import { ToolCardChangeSummary } from '../tool-cards/FlowChatToolCard';
import { ToolProcessingDots } from '../tool-cards/ToolProcessingDots';
import styles from './FileRevisionSummary.module.css';

export interface FlowGroupFileRevision {
  path: string;
  label: string;
  /** Localized count prefix, including its separator before the filename. */
  countLabel: string;
  /** Localized expanded prefix, including its separator before the filename. */
  expandedLabel?: string;
  status?: 'running' | 'error' | 'stopped';
  statusLabel?: string;
  /** Cumulative additions and deletions displayed by the individual revisions. */
  changeSummary?: { additions: number | string; deletions: number | string; label: string };
  openFile?: { label: string; onPress: () => void };
}

export function FileRevisionSummary({ file, itemCount, expanded, onToggle, contentId, description, component, testId }: {
  file: FlowGroupFileRevision;
  itemCount: number;
  expanded: boolean;
  onToggle?: () => void;
  contentId?: string;
  description: string;
  component: string;
  testId: string;
}) {
  const prefixLabel = expanded ? file.expandedLabel : file.countLabel;
  return <div className={styles.header} data-expanded={expanded} data-openbitfun-component={component} data-openbitfun-part="header">
    {itemCount > 2 && <span aria-hidden="true" className={styles.page} data-layer="2" />}
    {itemCount > 1 && <span aria-hidden="true" className={styles.page} data-layer="1" />}
    <div className={styles.front} data-has-file-action={Boolean(file.openFile)}>
      <button type="button" className={styles.toggle} onClick={onToggle} disabled={!onToggle}
        aria-label={description} aria-expanded={expanded} aria-controls={contentId}
        data-overflow-trigger data-testid={`${testId}-toggle`}>
        <span className={styles.icon} aria-hidden="true"><Icon glyph={FileEdit} size="sm" />
          <span className={styles.disclosure}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" /></span>
        </span>
        <span className={styles.subject} data-openbitfun-component={component} data-openbitfun-part="summary">
          {prefixLabel && <span className={styles.count}>{prefixLabel}</span>}
          <OverflowText className={styles.filename} title={file.path}>{file.label}</OverflowText>
        </span>
        {(file.status || file.statusLabel || (!expanded && file.changeSummary)) && <span className={styles.metadata} data-has-status={Boolean(file.status || file.statusLabel)}>
          {(file.status || file.statusLabel) && <span className={styles.result} data-status={file.status}>
            {file.status === 'running' && <ToolProcessingDots size={16} />}
            {file.status === 'error' && <Icon glyph={TriangleAlert} size="sm" />}
            {file.statusLabel && <OverflowText>{file.statusLabel}</OverflowText>}
          </span>}
          {!expanded && file.changeSummary && <ToolCardChangeSummary className={styles.changes} additions={file.changeSummary.additions}
            deletions={file.changeSummary.deletions} aria-label={file.changeSummary.label} />}
        </span>}
      </button>
      {file.openFile && <div className={styles.actions} data-openbitfun-component={component} data-openbitfun-part="controls">
        <IconButton size="sm" variant="quiet" aria-label={file.openFile.label} title={file.openFile.label}
          icon={<Icon name="arrow-up-right" size="sm" />} onClick={file.openFile.onPress} />
      </div>}
    </div>
  </div>;
}
