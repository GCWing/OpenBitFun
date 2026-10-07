import { useRef } from 'react';
import { ToolRelationRow, ToolCardSection, ToolCardText } from '@openbitfun/ui/flow-chat';
import type { ExecOutputHandle, ExecProcessPresentationProps } from './ExecProcessPresentation';

/** Process input, polling and control are records; they never expand the transcript. */
export function ExecRelationPresentation({ toolItem, model, t, rootRef, renderOutput, renderOutputAction }: ExecProcessPresentationProps) {
  const outputRef = useRef<ExecOutputHandle | null>(null);
  const interaction = model.interaction!;
  const recordedStatus = toolItem.status;
  const done = recordedStatus === 'completed' || recordedStatus === 'confirmed';
  const nonzero = model.exitCode !== undefined && model.exitCode !== 0;
  const status = done && (toolItem.toolResult?.success === false || model.resultNoticeText) ? 'error' : recordedStatus;
  const progress = Array.isArray(toolItem._progressLogs) ? toolItem._progressLogs.filter((item): item is string => typeof item === 'string').join('')
    : typeof toolItem._progressMessage === 'string' ? toolItem._progressMessage : '';
  const output = model.resultOutput || progress;
  const receiving = interaction.operation === 'receive';
  const controlling = model.kind === 'control';
  const completed = controlling ? interaction.operation === 'terminate' ? t('toolCards.interaction.terminated') : t('toolCards.interaction.stopRequested')
    : receiving ? output ? t('toolCards.interaction.outputRead') : t('toolCards.interaction.noOutput') : t('toolCards.interaction.inputSent');
  const active = controlling ? interaction.operation === 'terminate' ? t('toolCards.interaction.terminating') : t('toolCards.interaction.stopping')
    : receiving ? t('toolCards.interaction.readingOutput') : t('toolCards.interaction.sendingInput');
  const summary = status === 'error' ? model.resultNoticeText || t('toolCards.default.failed')
    : status === 'cancelled' ? t('toolCards.default.cancelled') : status === 'rejected' ? t('toolCards.default.rejected')
      : status === 'pending_confirmation' ? t('toolCards.default.waitingConfirm') : status === 'queued' ? t('toolCards.default.queued')
        : done ? nonzero ? `${completed} · ${t('toolCards.terminal.exitCode', { code: model.exitCode })}` : completed : active;
  const error = toolItem.toolResult?.error || model.resultNoticeText;
  const hasInput = !controlling && !receiving && Boolean(model.primaryText);
  const details = <>
    {hasInput && <ToolCardSection label={t('toolCards.execProcess.writeStdin')}><ToolCardText>{model.primaryText}</ToolCardText></ToolCardSection>}
    {output && <ToolCardSection label={hasInput ? t('toolCards.builtin.fields.results') : undefined}
      actions={renderOutputAction(() => output)}>
      {renderOutput({ content: output, maxRows: 15, ref: outputRef, surface: 'standalone' })}
    </ToolCardSection>}
    {!output && !hasInput && !error && <ToolCardText variant="prose">{controlling ? summary : done ? model.noOutputText : model.waitingText}</ToolCardText>}
    {nonzero && !controlling && <ToolCardText variant="prose">{t('toolCards.terminal.exitCode', { code: model.exitCode })}</ToolCardText>}
    {error && <ToolCardText variant="prose">{error}</ToolCardText>}
  </>;

  return <div ref={rootRef} data-openbitfun-adapter="exec-process-tool-card" data-tool-card-id={toolItem.id}>
    <ToolRelationRow interaction={interaction} result={summary} status={status}
      details={details} detailsTitle={model.actionLabel} detailsSize="md" resultLabel={t('toolCards.interaction.inspectResult')} />
  </div>;
}
