import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle, Icon,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Target } from 'lucide-react';
import { Textarea } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';
import type { ThreadGoalController } from '../../hooks/useThreadGoalController';
import type { ThreadGoalUiAction } from '../../services/threadGoalActions';
import {
  buildThreadGoalWorkflowSteps,
  shouldShowThreadGoalWorkflow,
} from './threadGoalWorkflow';
import { useThreadGoalElapsedSeconds } from './useThreadGoalElapsedSeconds';
import { formatThreadGoalElapsedSeconds } from '../../utils/threadGoalDuration';
import {
  resolveThreadGoalActionLabel,
  resolveThreadGoalStatusLabel,
} from '../../utils/threadGoalDisplay';
import './ThreadGoalDialogs.scss';

function formatUsageLine(
  goal: NonNullable<ThreadGoalController['goal']>,
  elapsedSeconds: number,
  t: ReturnType<typeof useTranslation>['t']
): string | null {
  const parts: string[] = [];
  if (goal.tokenBudget != null) {
    parts.push(
      t('threadGoal.usageTokens', {
        used: formatTokenCount(
          goal.tokensUsed ?? 0,
          (number, options) => i18nService.formatNumber(number, options),
        ),
        budget: formatTokenCount(
          goal.tokenBudget,
          (number, options) => i18nService.formatNumber(number, options),
        ),
      })
    );
  }
  if (elapsedSeconds > 0) {
    parts.push(
      t('threadGoal.usageTime', {
        duration: formatThreadGoalElapsedSeconds(elapsedSeconds, t),
      })
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function statusBadgeClass(status: string): string {
  const known = new Set([
    'active',
    'paused',
    'blocked',
    'usageLimited',
    'budgetLimited',
    'complete',
  ]);
  const key = known.has(status) ? status : 'active';
  return `openbitfun-thread-goal-menu__status-badge openbitfun-thread-goal-menu__status-badge--${key}`;
}

export interface ThreadGoalDialogsProps {
  controller: ThreadGoalController;
  disabled?: boolean;
}

export const ThreadGoalDialogs: React.FC<ThreadGoalDialogsProps> = ({
  controller,
  disabled = false,
}) => {
  const { t } = useTranslation('flow-chat');
  const { goal } = controller;
  const [draft, setDraft] = useState(controller.editInitialObjective);

  useEffect(() => {
    if (controller.editOpen) {
      setDraft(controller.editInitialObjective);
    }
  }, [controller.editInitialObjective, controller.editOpen]);

  const statusLabel = goal ? resolveThreadGoalStatusLabel(t, goal.status) : '';

  // `pause` is what the menu offers exactly while the goal is driving turns, so
  // the readiness to pause is the policy's own answer to "is this goal running"
  // — the same rule the track reads its stopwatch from. The clock only runs while
  // the menu is in front of the user, since nothing else shows the readout.
  const elapsedSeconds = useThreadGoalElapsedSeconds({
    goalId: goal?.goalId,
    accountedSeconds: goal?.timeUsedSeconds ?? 0,
    advancing: controller.menuOpen && controller.availableActions.includes('pause'),
  });

  const usageLine = goal ? formatUsageLine(goal, elapsedSeconds, t) : null;

  const workflowSteps = useMemo(
    () => (goal ? buildThreadGoalWorkflowSteps(goal.status) : []),
    [goal]
  );

  const showWorkflow = goal ? shouldShowThreadGoalWorkflow(goal.status) : false;

  const workflowNote = goal
    ? t(`threadGoal.workflow.note.${goal.status}`, {
        defaultValue: '',
      }).trim() || null
    : null;

  const runAction = useCallback(
    async (action: ThreadGoalUiAction) => {
      if (disabled) return;
      if (action === 'edit') {
        controller.openEdit(goal ? 'update' : 'create');
        return;
      }
      if (action === 'set') {
        controller.openEdit('create');
        return;
      }
      if (action === 'clear' || action === 'pause' || action === 'resume') {
        await controller.runUiAction(action);
      }
    },
    [controller, disabled, goal]
  );

  const commandHint = goal
    ? t(`threadGoal.commandHint.${goal.status}`, {
        defaultValue: t('threadGoal.commandHint.default'),
      })
    : t('threadGoal.commandHint.none');

  return (
    <>
      <Dialog
        open={controller.menuOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) controller.closeMenu(); }}
        size="md"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('threadGoal.menuTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="openbitfun-thread-goal-modal__body" inset="none">
        {goal ? (
          <div
            className="openbitfun-thread-goal-menu"
            data-openbitfun-component="thread-goal-dialogs"
            data-openbitfun-part="menu"
          >
            <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="header" className="openbitfun-thread-goal-menu__header">
              <span className={statusBadgeClass(goal.status)}>
                <Icon glyph={Target} size="sm" aria-hidden />
                {statusLabel}
              </span>
              {usageLine ? (
                <p className="openbitfun-thread-goal-menu__usage">{usageLine}</p>
              ) : null}
            </div>

            <section data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="section" className="openbitfun-thread-goal-menu__section" aria-labelledby="thread-goal-objective">
              <h3 id="thread-goal-objective" className="openbitfun-thread-goal-menu__section-title">
                {t('threadGoal.objectiveLabel')}
              </h3>
              <p data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="objective" className="openbitfun-thread-goal-menu__objective">{goal.objective}</p>
            </section>

            {showWorkflow ? (
              <section
                className="openbitfun-thread-goal-menu__section"
                aria-labelledby="thread-goal-workflow"
              >
                <h3 id="thread-goal-workflow" className="openbitfun-thread-goal-menu__section-title">
                  {t('threadGoal.workflow.title')}
                </h3>
                <ol data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="workflow" className="openbitfun-thread-goal-menu__workflow">
                  {workflowSteps.map(step => (
                    <li
                      data-openbitfun-component="thread-goal-dialogs"
                      data-openbitfun-part="workflowItem"
                      key={step.id}
                      className={[
                        'openbitfun-thread-goal-menu__workflow-step',
                        `openbitfun-thread-goal-menu__workflow-step--${step.state}`,
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'openbitfun-thread-goal-menu__workflow-marker',
                          `openbitfun-thread-goal-menu__workflow-marker--${step.state}`,
                        ].join(' ')}
                        aria-hidden
                      />
                      <span className="openbitfun-thread-goal-menu__workflow-text">
                        {t(`threadGoal.workflow.steps.${step.id}`)}
                      </span>
                    </li>
                  ))}
                </ol>
                {workflowNote ? (
                  <p className="openbitfun-thread-goal-menu__workflow-note">{workflowNote}</p>
                ) : null}
              </section>
            ) : null}

            <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="footer" className="openbitfun-thread-goal-menu__footer">
              <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="actions" className="openbitfun-thread-goal-menu__actions">
                {controller.availableActions.map(action => (
                  <Button
                    key={action}
                    type="button"
                    variant={action === 'clear' ? 'fill' : 'outline'}
                    tone={action === 'clear' ? 'danger' : 'neutral'}
                    size="sm"
                    disabled={disabled}
                    onClick={() => void runAction(action)}
                  >
                    {resolveThreadGoalActionLabel(t, action)}
                  </Button>
                ))}
              </div>
              <p data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="hint" className="openbitfun-thread-goal-menu__hint">{commandHint}</p>
            </div>
          </div>
        ) : (
          <div
            className="openbitfun-thread-goal-menu openbitfun-thread-goal-menu--empty"
            data-openbitfun-component="thread-goal-dialogs"
            data-openbitfun-part="menu"
            data-openbitfun-state="empty"
          >
            <p data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="hint" className="openbitfun-thread-goal-menu__hint">{t('threadGoal.menuEmpty')}</p>
            <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="actions" className="openbitfun-thread-goal-menu__actions">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={disabled}
                onClick={() => controller.openEdit('create')}
              >
                {t('threadGoal.action.set')}
              </Button>
            </div>
          </div>
        )}
        </DialogBody>
      </Dialog>

      <Dialog
        open={controller.editOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) controller.closeEdit(); }}
        size="md"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{controller.editMode === 'create'
            ? t('threadGoal.editTitleCreate')
            : t('threadGoal.editTitleUpdate')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="openbitfun-thread-goal-modal__body" inset="none">
        <div
          className="openbitfun-thread-goal-edit"
          data-openbitfun-component="thread-goal-dialogs"
          data-openbitfun-part="edit"
        >
          <p className="openbitfun-thread-goal-edit__hint">{t('threadGoal.editHint')}</p>
          <Textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={4}
            autoFocus
            disabled={disabled}
            placeholder={t('threadGoal.editPlaceholder')}
          />
          <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="actions" className="openbitfun-thread-goal-edit__actions">
            <Button type="button" variant="fill" size="sm" onClick={controller.closeEdit}>
              {t('threadGoal.editCancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={disabled || !draft.trim()}
              onClick={() => void controller.saveEdit(draft)}
            >
              {t('threadGoal.editSave')}
            </Button>
          </div>
        </div>
        </DialogBody>
      </Dialog>

      <Dialog
        open={controller.resumeOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) controller.dismissResume(); }}
        size="md"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('threadGoal.resumeTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="openbitfun-thread-goal-modal__body" inset="none">
        <div
          className="openbitfun-thread-goal-resume"
          data-openbitfun-component="thread-goal-dialogs"
          data-openbitfun-part="resume"
        >
          <p className="openbitfun-thread-goal-resume__subtitle">
            {t('threadGoal.resumeSubtitle', { objective: goal?.objective ?? '' })}
          </p>
          <p className="openbitfun-thread-goal-resume__hint">{t('threadGoal.resumeHint')}</p>
          <div data-openbitfun-component="thread-goal-dialogs" data-openbitfun-part="actions" className="openbitfun-thread-goal-resume__actions">
            <Button
              type="button"
              variant="fill"
              size="sm"
              disabled={disabled}
              onClick={controller.dismissResume}
            >
              {t('threadGoal.resumeLeavePaused')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={disabled}
              onClick={() => void controller.confirmResume()}
            >
              {t('threadGoal.resumeConfirm')}
            </Button>
          </div>
        </div>
        </DialogBody>
      </Dialog>
    </>
  );
};

ThreadGoalDialogs.displayName = 'ThreadGoalDialogs';
