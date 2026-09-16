import {
  InteractionMailboxAction, InteractionMailboxActionType, InteractionMailboxState,
  PendingPermission, PendingQuestion, SessionInteractionMailbox
} from '../model/InteractionMailbox';
import { RemoteSessionManager } from './RemoteSessionManager';

interface MailboxRequest { sessionId: string; }
interface MailboxArgs { request: MailboxRequest; }
interface PermissionReply { requestId: string; reply: string; updatedInput?: Object; }
interface PermissionReplyArgs { request: PermissionReply; }

/** The runtime mailbox owns approval and question state, never transcript events. */
export class InteractionMailboxStore {
  private client: RemoteSessionManager;
  private onChange: (state: InteractionMailboxState) => void;
  private state: InteractionMailboxState = new InteractionMailboxState();
  private epoch: number = 0;
  private version: number = 0;
  private read?: Promise<void>;
  private interacting: Set<string> = new Set<string>();

  constructor(client: RemoteSessionManager, onChange: (state: InteractionMailboxState) => void) {
    this.client = client; this.onChange = onChange;
  }

  select(sessionId: string): void {
    this.epoch++; this.version++; this.read = undefined; this.interacting.clear();
    this.state = new InteractionMailboxState(); this.state.sessionId = sessionId;
    this.publish();
  }

  refresh(): Promise<void> {
    if (!this.state.sessionId) return Promise.resolve();
    this.version++;
    if (this.read) return this.read;
    const epoch = this.epoch;
    const read = this.load(epoch).finally(() => { if (this.read === read) this.read = undefined; });
    this.read = read;
    return read;
  }

  private async load(epoch: number): Promise<void> {
    const sessionId = this.state.sessionId;
    try {
      while (epoch === this.epoch) {
        const version = this.version;
        const args: MailboxArgs = { request: { sessionId } };
        let snapshot: SessionInteractionMailbox;
        try {
          snapshot = await this.client.hostInvoke<SessionInteractionMailbox>('get_session_interaction_mailbox', args);
        } catch (error) {
          if (epoch !== this.epoch) return;
          // A newer invalidation owns the next read even if this request fails.
          if (version !== this.version) continue;
          throw error as Error;
        }
        if (epoch !== this.epoch) return;
        if (version !== this.version) continue;
        if (snapshot.sessionId !== sessionId || !Array.isArray(snapshot.permissions?.requests) ||
          !Array.isArray(snapshot.userQuestions?.questions)) throw new Error('Interaction mailbox session or payload mismatch');
        this.state.requests = snapshot.permissions.requests.filter((request: PendingPermission): boolean => request.sessionId === sessionId);
        this.state.questions = snapshot.userQuestions.questions.filter((question: PendingQuestion): boolean => question.sessionId === sessionId);
        const owned = new Set<string>(this.state.ownedToolIds);
        this.state.questions.forEach((question: PendingQuestion): void => { owned.add(question.toolId); });
        this.state.requests.forEach((request: PendingPermission): void => { if (request.toolCallId) owned.add(request.toolCallId); });
        this.state.ownedToolIds = Array.from(owned);
        this.state.failure = ''; this.publish(); return;
      }
    } catch (_error) {
      if (epoch === this.epoch) { this.state.failure = 'load'; this.publish(); }
    }
  }

  async dispatch(action: InteractionMailboxAction): Promise<void> {
    if (!action.sessionId || action.sessionId !== this.state.sessionId) return;
    if (action.type === InteractionMailboxActionType.Refresh) { await this.refresh(); return; }
    const id = action.id || '';
    const permission = action.type === InteractionMailboxActionType.Approve || action.type === InteractionMailboxActionType.Reject;
    if (permission ? !this.state.requests.some((item: PendingPermission): boolean => item.requestId === id) :
      !this.state.questions.some((item: PendingQuestion): boolean => item.toolId === id)) return;
    const epoch = this.epoch;
    if (action.type === InteractionMailboxActionType.StartQuestion) {
      if (this.interacting.has(id)) return;
      this.interacting.add(id);
      try { await this.client.startQuestionInteraction(action.sessionId, id); }
      catch (_error) { if (epoch === this.epoch) { this.interacting.delete(id); this.state.failure = 'reply'; this.publish(); } }
      return;
    }
    if (this.state.busy) return;
    this.state.busy = true; this.state.failure = ''; this.publish();
    try {
      if (permission) {
        // Rejection never consumes an approval draft, including an invalid one.
        const input = action.type === InteractionMailboxActionType.Approve ? action.updatedInput : undefined;
        if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
          throw new Error('Permission input must be a JSON object');
        }
        const args: PermissionReplyArgs = { request: { requestId: id,
          reply: action.type === InteractionMailboxActionType.Approve ? 'once' : 'reject',
          updatedInput: action.type === InteractionMailboxActionType.Approve ? input : undefined } };
        await this.client.hostInvoke<Object>('respond_permission', args);
      } else if (action.type === InteractionMailboxActionType.Answer && action.answers) {
        await this.client.answerQuestion(id, action.answers);
      } else return;
      if (epoch === this.epoch) await this.refresh();
    } catch (_error) {
      if (epoch === this.epoch) { this.state.failure = 'reply'; this.publish(); }
    } finally {
      if (epoch === this.epoch) { this.state.busy = false; this.publish(); }
    }
  }

  private publish(): void {
    const snapshot = new InteractionMailboxState();
    snapshot.sessionId = this.state.sessionId;
    snapshot.requests = this.state.requests.slice(); snapshot.questions = this.state.questions.slice();
    snapshot.ownedToolIds = this.state.ownedToolIds.slice();
    snapshot.busy = this.state.busy; snapshot.failure = this.state.failure;
    this.onChange(snapshot);
  }
}
