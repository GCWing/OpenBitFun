import { InteractionMailboxAction, InteractionMailboxActionType, InteractionMailboxState } from '../../model/InteractionMailbox';
import { ConversationView } from '../components/ConversationView';
import { ConversationViewState } from '../state/ConversationViewState';
import { ChatSurface } from '../state/ChatSurface';
import { ConversationIntentType, ConversationIntent } from '../actions/ConversationIntent';

/** Deterministic native UI fixture; never opens a transport or modifies account state. */
@ComponentV2
export struct InteractionMailboxPreview {
  @Local state: ConversationViewState = this.initialState();

  private initialState(): ConversationViewState {
    const state = new ConversationViewState();
    state.surface = ChatSurface.Remote;
    state.connectionState = 'connected';
    state.activeSession = { sessionId: 'mailbox-preview', title: 'Interaction mailbox', workspacePath: '/workspace', agentType: 'code' };
    state.interactionMailbox.sessionId = 'mailbox-preview';
    state.interactionMailbox.requests = [{ requestId: 'preview-write', sessionId: 'mailbox-preview',
      action: 'write', resources: ['/workspace/readme.md'], source: { identity: 'Write' } }];
    return state;
  }

  build() {
    ConversationView({ state: this.state, onIntent: (intent: ConversationIntent): void => {
      if (intent.type === ConversationIntentType.Mailbox && intent.mailboxAction) this.handle(intent.mailboxAction);
    } })
  }

  private handle(action: InteractionMailboxAction): void {
    const next = this.initialState();
    if (action.type === InteractionMailboxActionType.Approve || action.type === InteractionMailboxActionType.Reject) {
      next.interactionMailbox.failure = 'reply';
    }
    this.state = next;
  }
}
