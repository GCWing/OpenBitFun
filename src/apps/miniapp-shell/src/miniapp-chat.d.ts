export interface MiniAppChatEvent {
  sessionId: string;
  turnId?: string;
  sourceEvent: string;
  [key: string]: unknown;
}
export interface MiniAppChatSnapshot {
  sessionId: string;
  turns: Array<{ id: string; user: string; status: string; error?: string | null; rounds: Array<{ id: string; text: string }> }>;
  isPartial?: boolean;
  runtime?: { streamId: string; cursor: number; activeTurnId?: string | null; events: MiniAppChatEvent[] } | null;
}
export interface MiniAppChatSubmission { requestId: string; text: string; message: string }
export interface MiniAppChat {
  configure(options: { labels: Record<string, string>; appName: string; appIcon?: string; description?: string; snapshotSupported?: boolean }): void;
  claim(params?: Record<string, unknown>): void;
  release(): void;
  focusSession(id: string): Promise<void>;
  clearSession(): void;
  setDraft(text: string): void;
  complete(params: { requestId: string; error?: string }): { completed: boolean };
  getRequestId(): string | undefined;
  acceptedRun(result: { sessionId: string; turnId: string }, requestId: string | undefined): void;
  event(payload: MiniAppChatEvent): void;
  resync(): Promise<void>;
  setConnected(connected: boolean): void;
  setApproval(pending: boolean): void;
}
export function mountMiniAppChat(root: HTMLElement, options: {
  onSend: (submission: MiniAppChatSubmission) => void;
  onStop: (params: { sessionId: string; turnId: string }) => Promise<unknown>;
  loadSnapshot: (sessionId: string) => Promise<MiniAppChatSnapshot>;
  icons?: Record<string, string>;
}): MiniAppChat;
