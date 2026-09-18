import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../../store/FlowChatStore';
import { recordVoiceExchange, stageVoiceExchange, replayVoiceExchanges } from '../../services/controlConversation';
import type { VoiceCallTarget } from './voiceClientContext';
import type { Session } from '../../types/flow-chat';

export interface VoiceTranscriptExchange {
  id: string;
  startedAt: number;
  user: string;
  assistant: string;
}
export interface VoiceConversationTranscript {
  target: VoiceCallTarget;
  exchanges: readonly VoiceTranscriptExchange[];
}

/** Final transcripts only; provisional ASR and display truncation never enter history. */
export class VoiceConversationLedger {
  private exchange = { id: crypto.randomUUID(), user: '', assistant: '', delegated: false };
  private queue: Promise<void> = Promise.resolve();
  private readonly scope = getActiveSurfaceScope();
  private readonly session: Session | undefined;
  private previews: VoiceTranscriptExchange[] = [];
  constructor(private readonly target: VoiceCallTarget, private readonly onError: (error: unknown) => void,
    private readonly onTranscript?: (transcript: VoiceConversationTranscript) => void) {
    this.session = flowChatStore.getState().sessions.get(target.sessionId);
    this.publish();
  }
  get exchangeId() { return this.exchange.id; }
  private publish() {
    this.onTranscript?.({ target: { ...this.target, surfaceId: this.target.surfaceId ?? this.scope.surfaceId }, exchanges: this.previews });
  }
  /** Presentation-only ASR snapshots never become persisted conversation facts. */
  preview(role: 'user' | 'assistant', text: string) {
    const existing = this.previews.find(entry => entry.id === this.exchange.id);
    const next = { ...(existing ?? { id: this.exchange.id, startedAt: Date.now(), user: '', assistant: '' }), [role]: text };
    this.previews = existing ? this.previews.map(entry => entry.id === next.id ? next : entry) : [...this.previews, next];
    this.publish();
  }
  user(text: string) { this.exchange.user = text; this.preview('user', text); }
  assistant(text: string) { this.exchange.assistant = text; this.preview('assistant', text); }
  async delegate() {
    const text = this.exchange.user;
    this.exchange.delegated = true;
    await this.queue;
    this.scope.assertCurrent('delegate voice request');
    await replayVoiceExchanges(this.target.sessionId);
    return text;
  }
  next() { this.flush(); this.exchange = { id: crypto.randomUUID(), user: '', assistant: '', delegated: false }; }
  flush() {
    const exchange = this.exchange;
    const workspaceId = this.session?.workspaceId ?? this.session?.config.workspaceId
      ?? (this.target.kind === 'miniapp' ? undefined : this.target.workspaceId);
    if (!exchange.user || exchange.delegated || !workspaceId) return;
    // Mark the snapshot consumed synchronously; provider completion can be repeated.
    this.exchange = { ...exchange, user: '' };
    const scope = this.scope;
    const target = this.target;
    const request = { surfaceId: target.surfaceId ?? scope.surfaceId,
      sessionId: target.sessionId, workspaceId,
      exchangeId: exchange.id, userText: exchange.user, assistantText: exchange.assistant };
    try { stageVoiceExchange(request); } catch (error) { this.onError(error); }
    this.queue = this.queue.then(async () => {
      scope.assertCurrent('save voice history');
      const busy = () => flowChatStore.getState().sessions.get(target.sessionId)?.dialogTurns
        .some(turn => ['pending', 'processing', 'finishing', 'image_analyzing', 'cancelling'].includes(turn.status));
      if (busy()) await new Promise<void>((resolve, reject) => {
        const stop = flowChatStore.subscribe(onSettled);
        function onSettled() { if (!busy()) { cleanup(); resolve(); } }
        function aborted() { cleanup(); reject(new Error('Voice history target disconnected')); }
        function cleanup() { stop(); scope.signal.removeEventListener('abort', aborted); }
        scope.signal.addEventListener('abort', aborted, { once: true });
        if (!busy()) { cleanup(); resolve(); }
      });
      scope.assertCurrent('save voice history');
      await recordVoiceExchange(request);
      // recordVoiceExchange hydrates canonical records before this handoff.
      this.previews = this.previews.filter(entry => entry.id !== exchange.id);
      this.publish();
    }).catch(this.onError);
  }
}
