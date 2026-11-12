import React, { useContext, useEffect, useRef, useState } from 'react';
import { MobileButton, MobileTextarea } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import type { RemoteToolStatus } from '../services/RemoteSessionManager';
import { describeChatError, isUnknownOutcomeFailure } from '../services/chatErrorPresentation';
import { InteractionVerifyContext } from './InteractionVerification';

interface ChatToolApprovalActionsProps {
  tool: RemoteToolStatus;
  onApprove?: (toolId: string, updatedInput?: Record<string, unknown>) => Promise<void>;
  onReject?: (toolId: string) => Promise<void>;
}

export function isToolAwaitingApproval(tool: RemoteToolStatus): boolean {
  const status = tool.status.toLowerCase();
  return (status === 'pending_confirmation' || status === 'needs_confirmation') && Boolean(tool.id);
}

export default function ChatToolApprovalActions({
  tool,
  onApprove,
  onReject,
}: ChatToolApprovalActionsProps) {
  const { t } = useI18n();
  const verify = useContext(InteractionVerifyContext);
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);

  const [editing, setEditing] = useState(false);
  const [editedInput, setEditedInput] = useState('');
  // `checking`: the reply was lost and the host is being asked again.
  // `unconfirmed`: after that check the request is still pending, so the
  // decision may not have arrived; the buttons are usable again.
  const [outcome, setOutcome] = useState<'idle' | 'checking' | 'unconfirmed' | 'failed'>('idle');
  const [failureText, setFailureText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const toolKey = `${tool.id}:${tool.status}`;
  const toolKeyRef = useRef(toolKey);
  toolKeyRef.current = toolKey;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    setPendingAction(null);
    setOutcome('idle');
    setSubmitted(false);
    setEditing(false);
  }, [tool.id, tool.status]);

  if (!isToolAwaitingApproval(tool) || !onApprove || !onReject) return null;

  const request = tool.tool_input ?? tool.input_preview;
  const requestText = typeof request === 'string' ? request : request == null ? '' : JSON.stringify(request, null, 2);

  const runAction = async (action: 'approve' | 'reject') => {
    if (pendingAction || submitted || outcome === 'checking') return;
    const key = toolKeyRef.current;
    setPendingAction(action);
    setOutcome('idle');
    try {
      const updated = editing && action === 'approve' ? JSON.parse(editedInput) : undefined;
      if (updated !== undefined && (updated === null || typeof updated !== 'object' || Array.isArray(updated))) throw new Error('Approval input must be a JSON object');
      await (action === 'approve' ? onApprove(tool.id, updated) : onReject(tool.id));
      if (!mountedRef.current) return;
      setSubmitted(true);
      setPendingAction(null);
    } catch (error) {
      if (!mountedRef.current) return;
      if (isUnknownOutcomeFailure(error)) {
        // The host may already have applied the decision. Ask it before
        // offering the buttons again; a settled request leaves this view.
        setOutcome('checking');
        try { await verify?.(); } catch { /* the check itself is best effort */ }
        if (!mountedRef.current || toolKeyRef.current !== key) return;
        setOutcome('unconfirmed');
      } else {
        setFailureText(error instanceof SyntaxError ? '' : describeChatError(error, t));
        setOutcome('failed');
        void verify?.().catch(() => {});
      }
      setPendingAction(null);
    }
  };
  const locked = pendingAction !== null || submitted || outcome === 'checking';

  return (
    <div className="chat-tool-approval" role="group" aria-label={t('chat.approvalRequired')}>
      <p className="chat-tool-approval__label">{t('chat.approvalRequired')}</p>
      {requestText && <pre className="chat-tool-approval__request">{requestText.length > 240 ? `${requestText.slice(0, 240)}…` : requestText}</pre>}
      {!editing && <MobileButton disabled={locked} onClick={() => { setEditedInput(requestText || '{}'); setEditing(true); }}>{t('chat.editApproval')}</MobileButton>}
      {editing && <MobileTextarea aria-label={t('chat.toolRequest')} value={editedInput} onChange={event => setEditedInput(event.target.value)} disabled={locked} rows={6} />}
      {outcome === 'failed' && <p className="chat-tool-approval__error" role="alert">{t('chat.approvalFailed')}{failureText ? ` ${failureText}` : ''}</p>}
      {outcome === 'checking' && <p role="status">{t('chat.decisionChecking')}</p>}
      {outcome === 'unconfirmed' && <p className="chat-tool-approval__error" role="alert">{t('chat.decisionUnconfirmed')}</p>}
      {submitted && <p role="status">{t('chat.approvalSubmitted')}</p>}
      <div className="chat-tool-approval__actions" aria-busy={pendingAction !== null || outcome === 'checking'}>
        <MobileButton
          appearance="primary"
          block
          className="chat-tool-approval__button chat-tool-approval__button--approve"
          disabled={locked}
          onClick={() => void runAction('approve')}
          size="sm"
        >
          {pendingAction === 'approve' ? t('chat.approving') : t('chat.approve')}
        </MobileButton>
        <MobileButton
          appearance="secondary"
          block
          className="chat-tool-approval__button chat-tool-approval__button--reject"
          disabled={locked}
          onClick={() => void runAction('reject')}
          size="sm"
        >
          {pendingAction === 'reject' ? t('chat.rejecting') : t('chat.reject')}
        </MobileButton>
      </div>
    </div>
  );
}
