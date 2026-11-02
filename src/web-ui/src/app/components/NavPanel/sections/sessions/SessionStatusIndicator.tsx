import { memo, type ReactNode } from 'react';
import { Icon } from '@openbitfun/ui';
import { CircleAlert, CircleCheck, CirclePause, CircleStop, CloudOff, Hand, Loader2, MessageCircleQuestion } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useSessionNavStatus } from '@/flow_chat/hooks/useSessionNavStatus';
import './SessionStatusIndicator.scss';

const presentation = {
  running: { glyph: Loader2, tone: 'info', label: 'shared:statuses.running' },
  approval: { glyph: Hand, tone: 'warning', label: 'nav.sessions.status.approval' },
  input: { glyph: MessageCircleQuestion, tone: 'warning', label: 'nav.sessions.status.input' },
  error: { glyph: CircleAlert, tone: 'danger', label: 'shared:statuses.failed' },
  unread: { glyph: CircleCheck, tone: 'success', label: 'nav.sessions.status.unread' },
  paused: { glyph: CirclePause, tone: 'secondary', label: 'nav.sessions.status.paused' },
  stopped: { glyph: CircleStop, tone: 'secondary', label: 'shared:statuses.cancelled' },
  queued: { name: 'clock', tone: 'secondary', label: 'nav.sessions.status.queued' },
  syncing: { glyph: CloudOff, tone: 'secondary', label: 'nav.sessions.status.syncing' },
} as const;

export const SessionStatusIndicator = memo(function SessionStatusIndicator({
  sessionId,
  idleFallback,
}: {
  sessionId: string;
  /**
   * Rendered in the same trailing cell while the session has nothing to report,
   * so a second row mark can sit on the row's right edge without claiming a
   * second cell. The cell still yields to the row menu on hover or focus.
   */
  idleFallback?: ReactNode;
}) {
  const { t } = useI18n('common');
  const status = useSessionNavStatus(sessionId);
  const appearance = status.kind === 'idle' ? null : presentation[status.kind];
  const label = appearance
    ? status.kind === 'approval' && status.pendingCount > 1
      ? t('nav.sessions.status.approvalCount', { count: status.pendingCount })
      : t(appearance.label)
    : '';

  if (!appearance && idleFallback) {
    return (
      <span className="session-status-indicator openbitfun-nav-panel__inline-item-status">
        {idleFallback}
      </span>
    );
  }

  return appearance ? (
    <span
      className="session-status-indicator openbitfun-nav-panel__inline-item-status"
      data-openbitfun-component="sessions-section"
      data-openbitfun-part="status"
      data-status={status.kind}
      role="img"
      aria-label={label}
    >
      <Icon
        {...('glyph' in appearance
          ? { glyph: appearance.glyph }
          : { name: appearance.name })}
        size="xs"
        tone={appearance.tone}
        aria-hidden="true"
      />
    </span>
  ) : null;
});
