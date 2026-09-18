import { useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, IconButton, Tooltip, VoiceCallTranscript, type VoiceTranscriptEntry } from '@openbitfun/ui';
import { ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import { SquarePen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { MarkdownRenderer } from '@/infrastructure/markdown/MarkdownRenderer';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { ConversationTextVisibilityContext, type ConversationSessionRef } from '../../contexts/conversationViewScope';
import { ChatInput } from '../ChatInput';
import { usePermissionRequests } from '../modern/usePermissionRequests';
import { UserMessageImage } from '../modern/UserMessageImage';
import { UserMessagePresentationContent } from '../modern/UserMessagePresentationContent';
import { AskUserQuestionCard } from '../../tool-cards/AskUserQuestionCard';
import { getToolCardConfig } from '../../tool-cards/toolCardMetadata';
import { flowChatStore } from '../../store/FlowChatStore';
import { findPendingAskUserQuestion, resolveTrackedTurn } from '../../utils/askUserQuestionState';
import { isTransientTurnStatus } from '../../utils/dialogTurnStability';
import { parseComposerPresentation } from '../../utils/composerPresentation';
import { effectiveToolInvocation, projectEffectiveToolItem } from '../../utils/toolInvocationIdentity';
import type { Session } from '../../types/flow-chat';
import { useRealtimeVoiceCall } from './RealtimeVoiceCallContext';
import { ConversationModeSurface } from './ConversationModeSurface';
import { controlConversationTranscript, controlTranscriptStartIndex } from './controlConversationTranscript';
import type { VoiceCallTarget } from './voiceClientContext';
import { supportsNewControlConversation } from '../../services/controlConversation';

const HISTORY_PAGE_SIZE = 40;

function ControlComposer({ active }: { active: boolean }) {
  const visible = useContext(ConversationTextVisibilityContext);
  return <ChatInput isSceneActive={active && visible} presentation="conversation" />;
}

interface ControlConversationProps {
  session: Session;
  sessionRef: ConversationSessionRef;
  voiceTarget: VoiceCallTarget;
  active: boolean;
  renderHeader: (modeSwitch: ReactNode) => ReactNode;
  onClose: () => void;
  onVoiceViewChange: (visible: boolean) => void;
  onNewConversation: () => Promise<void>;
}

/** A projection of the Runtime conversation, never a second session or message store. */
export function ControlConversation({ session, sessionRef, voiceTarget, active, renderHeader, onClose, onVoiceViewChange, onNewConversation }: ControlConversationProps) {
  const { t } = useI18n('flow-chat');
  const voice = useRealtimeVoiceCall();
  const { ownedRequests } = usePermissionRequests(session.sessionId);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyRequest = useRef(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const creatingRequest = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const needsAnswer = session.dialogTurns.some(turn => Boolean(findPendingAskUserQuestion(turn)));
  const trackedTurn = resolveTrackedTurn(session);
  const processingTurnId = trackedTurn && isTransientTurnStatus(trackedTurn.status)
    && trackedTurn.status !== 'cancelling' && !needsAnswer && ownedRequests.length === 0
    ? trackedTurn.id : undefined;
  const { surfaceId, sessionId } = sessionRef;
  const rows = useMemo(() => controlConversationTranscript({ surfaceId, sessionId }, session.dialogTurns, voice.conversationTranscript),
    [surfaceId, sessionId, session.dialogTurns, voice.conversationTranscript]);
  const [firstVisibleId, setFirstVisibleId] = useState<string | null>(null);
  const firstVisibleIndex = controlTranscriptStartIndex(rows, firstVisibleId, HISTORY_PAGE_SIZE);
  const firstRenderedId = rows[firstVisibleIndex]?.id ?? null;
  useLayoutEffect(() => { setFirstVisibleId(firstRenderedId); }, [firstRenderedId]);
  const visibleRows = rows.slice(firstVisibleIndex);
  const entries: VoiceTranscriptEntry[] = [];
  const renderAssistant = (content: string, isStreaming = false) => <MarkdownRenderer content={content}
    workspaceId={session.workspaceId ?? session.config.workspaceId}
    basePath={session.workspacePath} remoteConnectionId={session.remoteConnectionId} remoteSshHost={session.remoteSshHost}
    isStreaming={isStreaming} />;
  for (const row of visibleRows) {
    if ('exchange' in row) {
      if (row.exchange.user) entries.push({ id: `${row.id}:user`, role: 'user', content: row.exchange.user });
      if (row.exchange.assistant) entries.push({ id: `${row.id}:assistant`, role: 'assistant', content: renderAssistant(row.exchange.assistant) });
      continue;
    }
    const turn = row.turn;
    const presentation = parseComposerPresentation(turn.userMessage.metadata?.composerPresentation);
    if (turn.userMessage.content || turn.userMessage.images?.length) entries.push({ id: `${row.id}:user`, role: 'user', content: <>
      {presentation ? <UserMessagePresentationContent presentation={presentation} /> : turn.userMessage.content}
      {!!turn.userMessage.images?.length && <div className="openbitfun-conversation-mode-surface__images"
        data-openbitfun-component="conversation-mode-surface" data-openbitfun-part="images">
        {turn.userMessage.images.map(image => <UserMessageImage key={image.id} image={image} onPreview={setPreview} />)}
      </div>}
    </>, activity: turn.id === processingTurnId
      ? <span role="status" aria-label={t('input.processingCapsule')}><ToolProcessingDots size={16} /></span>
      : undefined });
    const text = turn.modelRounds.flatMap(round => round.items.flatMap(item => item.type === 'text' && item.content ? [item.content] : [])).join('\n\n');
    if (text) entries.push({ id: `${row.id}:assistant`, role: 'assistant', content: renderAssistant(text, turn.status === 'processing') });
    for (const round of turn.modelRounds) {
      for (const item of round.items) {
        if (item.type !== 'tool' || effectiveToolInvocation(item.toolName, item.toolCall?.input).toolName !== 'AskUserQuestion') continue;
        entries.push({ id: `${row.id}:${item.id}`, role: 'assistant', content: <AskUserQuestionCard toolItem={projectEffectiveToolItem(item)}
          config={getToolCardConfig('AskUserQuestion')} sessionId={session.sessionId} turnId={turn.id} /> });
      }
    }
    if (turn.error) entries.push({ id: `${row.id}:error`, role: 'status', content: turn.error });
  }
  const ownsCall = voice.target?.surfaceId === sessionRef.surfaceId && voice.target.sessionId === sessionRef.sessionId;
  const status = ownsCall
    ? voice.notice || (voice.taskPhase ? voice.taskProgressText : voice.phase !== 'live' && voice.phase !== 'idle' ? voice.status : undefined)
    : undefined;
  const sessionError = session.error && !session.dialogTurns.some(turn => turn.error === session.error) ? session.error : undefined;
  const failedHistory = historyError || (session.historyState === 'failed' ? t('historyState.failedTitle') : '');
  const historyBusy = loadingHistory || session.historyState === 'hydrating' || session.historyState === 'metadata-only';
  const canLoadEarlier = firstVisibleIndex > 0 || session.isPartial;
  const loadEarlier = async () => {
    if (historyBusy || historyRequest.current) return;
    const scope = getActiveSurfaceScope();
    if (scope.surfaceId !== sessionRef.surfaceId) return;
    historyRequest.current = true;
    setLoadingHistory(true);
    setHistoryError('');
    try {
      if (session.historyState === 'failed') {
        await flowChatStore.loadSessionHistory(session.sessionId, { includeInternal: true });
        scope.assertCurrent('retry control conversation history');
        if (flowChatStore.getState().sessions.get(session.sessionId)?.historyState !== 'ready') {
          throw new Error(t('historyState.failedTitle'));
        }
      } else if (firstVisibleIndex === 0 && session.isPartial) {
        const loaded = await flowChatStore.ensureSessionFullHistory(session.sessionId, 'control-conversation-history');
        scope.assertCurrent('read control conversation history');
        if (!loaded) throw new Error(t('historyState.olderHistoryNotReady'));
      }
      const latestRows = controlConversationTranscript(
        sessionRef, flowChatStore.getState().sessions.get(session.sessionId)?.dialogTurns ?? session.dialogTurns,
        voice.conversationTranscript,
      );
      const currentStart = controlTranscriptStartIndex(latestRows, firstRenderedId, HISTORY_PAGE_SIZE);
      setFirstVisibleId(latestRows[Math.max(0, currentStart - HISTORY_PAGE_SIZE)]?.id ?? null);
    } catch (error) {
      if (!isSurfaceChangedError(error)) setHistoryError(String(error instanceof Error ? error.message : error));
    } finally {
      historyRequest.current = false;
      if (scope.isCurrent()) setLoadingHistory(false);
    }
  };
  const conversationBusy = Boolean(ownedRequests.length || needsAnswer || ownsCall && voice.phase !== 'idle'
    || session.dialogTurns.some(turn => ['pending', 'image_analyzing', 'processing', 'finishing', 'cancelling'].includes(turn.status)));
  const createConversation = async () => {
    if (creatingRequest.current || conversationBusy) return;
    creatingRequest.current = true;
    setCreatingConversation(true);
    try { await onNewConversation(); }
    catch (error) { if (!isSurfaceChangedError(error)) notificationService.error(String(error instanceof Error ? error.message : error)); }
    finally { creatingRequest.current = false; setCreatingConversation(false); }
  };
  const newConversationLabel = t(conversationBusy ? 'dock.newConversationBusy' : 'dock.newConversation');
  const newConversationAction = supportsNewControlConversation() ? <Tooltip content={newConversationLabel}>
    <IconButton size="sm" variant="quiet" icon={<SquarePen size={16} />} aria-label={t('dock.newConversation')}
      disabled={conversationBusy || historyBusy} loading={creatingConversation} onClick={() => void createConversation()} />
  </Tooltip> : undefined;
  const historyFeedback = failedHistory || historyBusy ? <div className="openbitfun-conversation-mode-surface__history" role="status"
    data-openbitfun-component="conversation-mode-surface" data-openbitfun-part="history">
    {historyBusy ? t('dock.loadingHistory') : <><span>{failedHistory}</span>
      <Button size="sm" variant="fill" onClick={() => void loadEarlier()}>{t('dock.retry')}</Button></>}
  </div> : undefined;

  return <>
    <ConversationModeSurface voiceTarget={voiceTarget} renderHeader={renderHeader} active={active}
      headerAction={newConversationAction}
      requiresTextInput={Boolean(ownedRequests.length || needsAnswer)} onCloseVoice={onClose} onVoiceViewChange={onVoiceViewChange}
      transcript={mode => <VoiceCallTranscript compact presentation={mode} entries={entries} status={status || sessionError} header={historyFeedback}
        onLoadEarlier={active && canLoadEarlier && !historyBusy && !failedHistory ? () => void loadEarlier() : undefined}
        className="openbitfun-conversation-mode-surface__transcript" />}>
      <ControlComposer active={active} />
    </ConversationModeSurface>
    {preview && <Dialog open aria-label={t('context.image')} onOpenChange={() => setPreview(null)}>
      <img className="openbitfun-conversation-mode-surface__image-preview" src={preview} alt={t('context.image')}
        data-openbitfun-component="conversation-mode-surface" data-openbitfun-part="imagePreview" />
    </Dialog>}
  </>;
}
