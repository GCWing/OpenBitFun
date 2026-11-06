
export interface MessageQueueRequest {
  sessionId: string; action: string; queueEpoch?: string; turnId?: string;
  operationId?: string; expectedRevision?: number; beforeTurnId?: string;
  expectedActiveTurnId?: string;
}
export interface MessageQueueItem {
  turnId: string; displayContent: string; attachmentCount: number; status: string; reason?: string;
}
export interface MessageQueueSnapshot {
  sessionId: string; queueEpoch: string; revision: number; items: MessageQueueItem[];
  supportsReorder?: boolean; activeTurnId?: string;
}
export interface MessageQueueResponse { resp?: string; message?: string; snapshot?: MessageQueueSnapshot; }
export class MessageQueueState {
  sessionId: string = ''; items: MessageQueueItem[] = []; supportsReorder: boolean = false;
  revisionKey: string = ''; busy: boolean = false; failure: string = '';
}
export interface MessageQueueAction { sessionId: string; action: string; turnId?: string; beforeTurnId?: string; }
