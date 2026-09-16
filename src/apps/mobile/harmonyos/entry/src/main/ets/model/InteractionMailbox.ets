import { RemoteQuestionAnswerPayload } from './RemoteModels';

export interface PermissionSource { identity: string; }
export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  action: string;
  resources: string[];
  source?: PermissionSource;
}
export interface PendingQuestion {
  toolId: string;
  sessionId: string;
  questions: Object;
}
export interface PermissionMailbox { requests: PendingPermission[]; revision: number; }
export interface QuestionMailbox { questions: PendingQuestion[]; revision: number; }
export interface SessionInteractionMailbox {
  sessionId: string;
  permissions: PermissionMailbox;
  userQuestions: QuestionMailbox;
}

/** Separate from persisted transcript and from the active turn's lifetime. */
export class InteractionMailboxState {
  sessionId: string = '';
  requests: PendingPermission[] = [];
  questions: PendingQuestion[] = [];
  ownedToolIds: string[] = [];
  busy: boolean = false;
  failure: string = '';

  ownsToolInteraction(toolId: string): boolean {
    return toolId.length > 0 && (this.ownedToolIds.includes(toolId) ||
      this.questions.some((item: PendingQuestion): boolean => item.toolId === toolId) ||
      this.requests.some((item: PendingPermission): boolean => item.toolCallId === toolId));
  }
}

export enum InteractionMailboxActionType {
  Refresh = 'refresh', Approve = 'approve', Reject = 'reject',
  StartQuestion = 'start_question', Answer = 'answer'
}
export interface InteractionMailboxAction {
  sessionId: string;
  type: InteractionMailboxActionType;
  id?: string;
  updatedInput?: Object;
  answers?: RemoteQuestionAnswerPayload;
}
