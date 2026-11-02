import type { FlowChatToolStatus, ToolCardInteraction } from '@openbitfun/ui/flow-chat';

/** Read-only presentation input, structurally compatible with existing records. */
export interface ExecToolSnapshot {
  id: string;
  toolName: string;
  status: FlowChatToolStatus;
  isParamsStreaming?: boolean;
  partialParams?: Record<string, unknown>;
  startTime?: number;
  durationMs?: number;
  userConfirmed?: boolean;
  toolCall?: { id?: string; input?: Record<string, unknown> };
  toolResult?: { result?: unknown; success?: boolean; error?: string; duration_ms?: number };
  _progressLogs?: unknown;
  _progressMessage?: unknown;
}

export interface ExecProcessCardModel {
  kind: 'command' | 'stdin' | 'control';
  interaction?: ToolCardInteraction;
  actionLabel: string;
  primaryText: string;
  emptyText: string;
  copyText: string;
  copyDisabled?: boolean;
  waitingText: string;
  noOutputText: string;
  resultNoticeText?: string;
  resultOutput: string;
  workdir?: string;
  sessionId?: number;
  exitCode?: number;
  wallTimeSeconds?: number;
  remote?: boolean;
  tty?: boolean;
}

export type PresentationTranslate = (key: string, options?: Record<string, unknown>) => string;

/** An injected clock makes grace periods reproducible without a second policy. */
export interface PresentationClock {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

export const systemPresentationClock: PresentationClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
