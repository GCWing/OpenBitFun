import type { ExecToolSnapshot, ExecProcessCardModel } from './contracts';

interface ParsedExecResult {
  output: string;
  status?: string;
  action?: string;
  workdir?: string;
  sessionId?: number;
  requestedSessionId?: number;
  exitCode?: number;
  wallTimeSeconds?: number;
  remote?: boolean;
  tty?: boolean;
}

function resultRecord(raw: unknown): Record<string, unknown> | null {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  return typeof raw === 'object' ? raw as Record<string, unknown> : null;
}

function interactionInput(item: ExecToolSnapshot): Record<string, unknown> {
  const input = resultRecord(item.toolCall?.input) ?? {};
  const partial = resultRecord(item.partialParams) ?? {};
  const parameters = partial.tool_name === item.toolName ? resultRecord(partial.args) ?? {} : partial;
  return item.isParamsStreaming ? { ...input, ...parameters } : Object.keys(input).length ? input : parameters;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function boolField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function parseExecProcessResult(raw: unknown): ParsedExecResult {
  const record = resultRecord(raw);
  if (!record) {
    return { output: '' };
  }

  return {
    output: stringField(record, 'output') ?? '',
    status: stringField(record, 'status'),
    action: stringField(record, 'action'),
    workdir: stringField(record, 'workdir'),
    sessionId: numberField(record, 'session_id'),
    requestedSessionId: numberField(record, 'requested_session_id'),
    exitCode: numberField(record, 'exit_code'),
    wallTimeSeconds: numberField(record, 'wall_time_seconds'),
    remote: boolField(record, 'remote'),
    tty: boolField(record, 'tty'),
  };
}

export function buildExecCommandCardModel(
  toolItem: ExecToolSnapshot,
  t: (key: string, options?: Record<string, unknown>) => string,
): ExecProcessCardModel {
  const input = toolItem.toolCall?.input ?? {};
  const result = parseExecProcessResult(toolItem.toolResult?.result);
  const cmd = typeof input.cmd === 'string' ? input.cmd : '';

  return {
    kind: 'command',
    actionLabel: t('toolCards.execProcess.executeCommand'),
    primaryText: cmd,
    emptyText: t('toolCards.terminal.noCommand'),
    copyText: cmd,
    copyDisabled: !cmd.trim(),
    waitingText: t('toolCards.execProcess.executingCommand'),
    noOutputText: t('toolCards.execProcess.noOutput'),
    resultOutput: result.output,
    workdir: result.workdir,
    sessionId: result.sessionId,
    exitCode: result.exitCode,
    wallTimeSeconds: result.wallTimeSeconds,
    remote: result.remote,
    tty: result.tty,
  };
}

export function buildWriteStdinCardModel(
  toolItem: ExecToolSnapshot,
  t: (key: string, options?: Record<string, unknown>) => string,
): ExecProcessCardModel {
  const input = interactionInput(toolItem);
  const result = parseExecProcessResult(toolItem.toolResult?.result);
  const sessionId = inputSessionId(input) ?? result.sessionId;
  const displaySessionId = sessionId ?? result.requestedSessionId;
  const chars = typeof input.chars === 'string' ? input.chars : '';
  const isPollOnly = chars.length === 0;
  const primaryText = isPollOnly
    ? t('toolCards.execProcess.pollSession', { id: displaySessionId ?? '?' })
    : chars;
  const resultNoticeText = result.status === 'session_not_found'
    ? t('toolCards.execProcess.sessionNotFound', {
      id: displaySessionId ?? '?',
    })
    : undefined;

  return {
    kind: 'stdin',
    interaction: {
      operation: isPollOnly ? 'receive' : 'send',
      source: { label: t('toolCards.interaction.currentSession'), kind: 'session' },
      target: { label: displaySessionId == null ? t('toolCards.interaction.unknownProcess')
        : t('toolCards.interaction.process', { id: displaySessionId }), kind: 'process' },
    },
    actionLabel: isPollOnly
      ? t('toolCards.execProcess.pollProcess')
      : t('toolCards.execProcess.writeStdin'),
    primaryText,
    emptyText: t('toolCards.execProcess.pollSession', { id: displaySessionId ?? '?' }),
    copyText: chars,
    copyDisabled: isPollOnly,
    waitingText: isPollOnly
      ? t('toolCards.execProcess.pollingOutput')
      : t('toolCards.execProcess.waitingForOutput'),
    noOutputText: t('toolCards.execProcess.noOutput'),
    resultNoticeText,
    resultOutput: result.output,
    sessionId: displaySessionId,
    exitCode: result.exitCode,
    wallTimeSeconds: result.wallTimeSeconds,
    remote: result.remote,
  };
}

function inputSessionId(input: Record<string, unknown>): number | undefined {
  const value = input.session_id;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function buildExecControlCardModel(
  toolItem: ExecToolSnapshot,
  t: (key: string, options?: Record<string, unknown>) => string,
): ExecProcessCardModel {
  const input = interactionInput(toolItem);
  const result = parseExecProcessResult(toolItem.toolResult?.result);
  const sessionId = inputSessionId(input);
  const displaySessionId = sessionId ?? result.sessionId ?? result.requestedSessionId;
  const action = typeof input.action === 'string'
    ? input.action
    : result.action;
  const isInterrupt = action === 'interrupt';
  const primaryText = isInterrupt
    ? t('toolCards.execProcess.interruptSession', { id: displaySessionId ?? '?' })
    : t('toolCards.execProcess.killSession', { id: displaySessionId ?? '?' });
  const resultNoticeText = result.status === 'session_not_found'
    ? t('toolCards.execProcess.sessionNotFound', {
      id: displaySessionId ?? '?',
    })
    : undefined;

  return {
    kind: 'control',
    interaction: {
      operation: isInterrupt ? 'interrupt' : 'terminate',
      source: { label: t('toolCards.interaction.currentSession'), kind: 'session' },
      target: { label: displaySessionId == null ? t('toolCards.interaction.unknownProcess')
        : t('toolCards.interaction.process', { id: displaySessionId }), kind: 'process' },
    },
    actionLabel: isInterrupt
      ? t('toolCards.execProcess.interruptProcess')
      : t('toolCards.execProcess.killProcess'),
    primaryText,
    emptyText: primaryText,
    copyText: primaryText,
    copyDisabled: displaySessionId == null,
    waitingText: isInterrupt
      ? t('toolCards.execProcess.interruptingSession')
      : t('toolCards.execProcess.killingSession'),
    noOutputText: isInterrupt
      ? t('toolCards.execProcess.interruptSentNoOutput')
      : t('toolCards.execProcess.killSentNoOutput'),
    resultNoticeText,
    resultOutput: result.output,
    sessionId: displaySessionId,
    exitCode: result.exitCode,
    wallTimeSeconds: result.wallTimeSeconds,
    remote: result.remote,
  };
}
