import React from 'react';
import { useTranslation } from 'react-i18next';
import { Goal, Pause, Play, Trash2 } from 'lucide-react';
import { Icon, Tooltip } from '@openbitfun/ui';
import type { ThreadGoalSnapshot } from '../../services/goalService';
import type { ThreadGoalUiAction } from '../../services/threadGoalActions';
import { resolveThreadGoalStatusLabel } from '../../utils/threadGoalDisplay';
import { formatUsageDuration } from '../usage/usageReportUtils';
import { resolveThreadGoalStripTone } from './threadGoalStripTone';
import { useThreadGoalElapsedSeconds } from './useThreadGoalElapsedSeconds';

/** The goal actions the track carries as controls of its own; the rest stay in the menu. */
export type ThreadGoalStripAction = Extract<ThreadGoalUiAction, 'pause' | 'resume' | 'clear'>;

export interface ThreadGoalStripControlProps {
  goal: ThreadGoalSnapshot;
  /**
   * Actions the goal menu offers for the current status. The quick controls
   * mirror this list rather than judging the status themselves, so the track and
   * the menu cannot disagree about what this goal can do.
   */
  actions?: ThreadGoalUiAction[];
  onOpen: () => void;
  /** Omitted where the surface cannot run goal actions; those controls then stay away. */
  onAction?: (action: ThreadGoalStripAction) => void;
}

/**
 * The thread-goal segment of the composer's status track.
 *
 * It sits to the right of the execution target and reads as one fact: what the
 * session is chasing, what that goal is doing right now, and how long it has
 * been at it. The objective is long-form, so it stays in the tooltip — the
 * track has room for the state, not for the prose.
 *
 * Its state is the tone it carries, because a goal that stopped driving turns
 * while nobody was watching must not look like one that is running.
 *
 * The two controls beside it are the exits a user reaches for while watching the
 * session work — stop the goal, or drop it. Editing the objective is a dialog,
 * so it stays in the menu.
 */
export const ThreadGoalStripControl: React.FC<ThreadGoalStripControlProps> = ({
  goal,
  actions = [],
  onOpen,
  onAction,
}) => {
  const { t } = useTranslation('flow-chat');
  const tone = resolveThreadGoalStripTone(goal);
  const statusLabel = resolveThreadGoalStatusLabel(t, goal.status);
  // `pause` is what the menu offers exactly while the goal is driving turns, so
  // the readiness to pause is the policy's own answer to "is this goal running".
  const running = actions.includes('pause');
  const elapsedSeconds = useThreadGoalElapsedSeconds({
    goalId: goal.goalId,
    accountedSeconds: goal.timeUsedSeconds ?? 0,
    // A running goal is counted continuously, not only while one round happens to
    // be in flight, so the readout ticks while the goal runs.
    advancing: running,
  });

  const runAction: ThreadGoalStripAction | null = running
    ? 'pause'
    : actions.includes('resume')
      ? 'resume'
      : null;
  const quickRun = onAction && runAction
    ? {
        action: runAction,
        label: runAction === 'resume'
          ? t('threadGoal.stripResumeGoal')
          : t('threadGoal.stripPauseGoal'),
        glyph: runAction === 'resume' ? Play : Pause,
      }
    : null;
  const clearLabel = t('threadGoal.stripClearGoal');
  const showClear = Boolean(onAction) && actions.includes('clear');

  return (
    <>
      <Tooltip
        content={t('threadGoal.stripTooltipWithGoal', {
          status: statusLabel,
          objective: goal.objective,
        })}
        placement="top"
      >
        <button
          type="button"
          className={`openbitfun-chat-input-workspace-strip__goal-btn openbitfun-chat-input-workspace-strip__goal-btn--${tone}`}
          data-openbitfun-component="chat-input-workspace-strip"
          data-openbitfun-part="goal"
          data-openbitfun-state={tone}
          data-testid="chat-input-thread-goal"
          aria-haspopup="dialog"
          aria-label={t('threadGoal.stripOpenWithGoal')}
          onClick={event => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <Icon glyph={Goal} size="xs" aria-hidden />
          <span className="openbitfun-chat-input-workspace-strip__goal-text">
            <span>{statusLabel}</span>
            {/* A goal that has not driven a turn yet has no elapsed time to show. */}
            {elapsedSeconds > 0 ? (
              <span>{formatUsageDuration(elapsedSeconds * 1000, t)}</span>
            ) : null}
          </span>
        </button>
      </Tooltip>
      {quickRun ? (
        <Tooltip content={quickRun.label} placement="top">
          <button
            type="button"
            className="openbitfun-chat-input-workspace-strip__goal-run"
            data-openbitfun-component="chat-input-workspace-strip"
            data-openbitfun-part="goalRun"
            data-testid="chat-input-thread-goal-run"
            aria-label={quickRun.label}
            onClick={event => {
              event.stopPropagation();
              onAction?.(quickRun.action);
            }}
          >
            <Icon glyph={quickRun.glyph} size="xs" aria-hidden />
          </button>
        </Tooltip>
      ) : null}
      {showClear ? (
        <Tooltip content={clearLabel} placement="top">
          <button
            type="button"
            className="openbitfun-chat-input-workspace-strip__goal-clear"
            data-openbitfun-component="chat-input-workspace-strip"
            data-openbitfun-part="goalClear"
            data-testid="chat-input-thread-goal-clear"
            aria-label={clearLabel}
            onClick={event => {
              event.stopPropagation();
              onAction?.('clear');
            }}
          >
            <Icon glyph={Trash2} size="xs" aria-hidden />
          </button>
        </Tooltip>
      ) : null}
    </>
  );
};

ThreadGoalStripControl.displayName = 'ThreadGoalStripControl';
