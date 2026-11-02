import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import { buildExecControlCardModel, buildWriteStdinCardModel } from './execProcessToolCardModel';

const messages: Record<string, string> = {
  'toolCards.execProcess.pollSession': 'Poll session #{{id}}',
  'toolCards.execProcess.pollProcess': 'Poll process:',
  'toolCards.execProcess.writeStdin': 'Write stdin:',
  'toolCards.execProcess.interruptProcess': 'Interrupt process:',
  'toolCards.execProcess.killProcess': 'Kill process:',
  'toolCards.execProcess.pollingOutput': 'Polling output...',
  'toolCards.execProcess.waitingForOutput': 'Waiting for output...',
  'toolCards.execProcess.interruptingSession': 'Interrupting process...',
  'toolCards.execProcess.killingSession': 'Killing process...',
  'toolCards.execProcess.noOutput': 'No output',
  'toolCards.execProcess.interruptSentNoOutput': 'Interrupt sent; no output',
  'toolCards.execProcess.killSentNoOutput': 'Kill sent; no output',
  'toolCards.execProcess.interruptSession': 'Interrupt session #{{id}}',
  'toolCards.execProcess.killSession': 'Kill session #{{id}}',
  'toolCards.execProcess.sessionNotFound': 'Session #{{id}} was not found.',
};

function t(key: string, options?: Record<string, unknown>): string {
  const template = messages[key] ?? String(options?.defaultValue ?? key);
  return template.replace(/{{(\w+)}}/g, (_, name) => String(options?.[name] ?? ''));
}

function writeStdinItem(
  result: unknown,
  input: Record<string, unknown> = {
    session_id: 42,
    chars: '',
  },
): FlowToolItem {
  return {
    id: 'tool-writestdin-1',
    type: 'tool',
    toolName: 'WriteStdin',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-writestdin-1',
      input,
    },
    toolResult: {
      success: true,
      result,
    },
  };
}

function execControlItem(input: Record<string, unknown>, result: unknown): FlowToolItem {
  return {
    id: 'tool-execcontrol-1',
    type: 'tool',
    toolName: 'ExecControl',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-execcontrol-1',
      input,
    },
    toolResult: {
      success: true,
      result,
    },
  };
}

describe('buildWriteStdinCardModel', () => {
  it('distinguishes receiving output from sending whitespace and preserves legacy process IDs', () => {
    const poll = buildWriteStdinCardModel(writeStdinItem({}, { session_id: '42', chars: '' }), t);
    const send = buildWriteStdinCardModel(writeStdinItem({}, { session_id: 42, chars: '\n' }), t);
    expect(poll.sessionId).toBe(42);
    expect(poll.interaction?.operation).toBe('receive');
    expect(send.interaction?.operation).toBe('send');
    expect(send.copyText).toBe('\n');
  });
  it('does not display the appended enter after the input text', () => {
    const model = buildWriteStdinCardModel(writeStdinItem({}, {
      session_id: 42,
      chars: 'yes',
      append_enter: true,
    }), t);

    expect(model.primaryText).toBe('yes');
    expect(model.copyText).toBe('yes');
  });

  it('surfaces session-not-found results as a completed notice', () => {
    const model = buildWriteStdinCardModel(writeStdinItem({
      status: 'session_not_found',
      requested_session_id: 42,
      session_id: null,
      output: '',
      message: 'backend message',
    }), t);

    expect(model.resultNoticeText).toBe('Session #42 was not found.');
    expect(model.resultOutput).toBe('');
    expect(model.noOutputText).toBe('No output');
    expect(model.sessionId).toBe(42);
  });
});

describe('buildExecControlCardModel', () => {
  it('renders interrupt controls with the requested session id', () => {
    const model = buildExecControlCardModel(execControlItem({
      session_id: 7,
      action: 'interrupt',
    }, {
      output: 'stopped',
      session_id: null,
      exit_code: 130,
      wall_time_seconds: 0.125,
      action: 'interrupt',
    }), t);

    expect(model.kind).toBe('control');
    expect(model.actionLabel).toBe('Interrupt process:');
    expect(model.primaryText).toBe('Interrupt session #7');
    expect(model.resultOutput).toBe('stopped');
    expect(model.sessionId).toBe(7);
    expect(model.exitCode).toBe(130);
  });

  it('surfaces session-not-found control results as a completed notice', () => {
    const model = buildExecControlCardModel(execControlItem({
      session_id: 99,
      action: 'kill',
    }, {
      status: 'session_not_found',
      requested_session_id: 99,
      session_id: null,
      output: '',
      action: 'kill',
    }), t);

    expect(model.actionLabel).toBe('Kill process:');
    expect(model.primaryText).toBe('Kill session #99');
    expect(model.resultNoticeText).toBe('Session #99 was not found.');
    expect(model.resultOutput).toBe('');
    expect(model.noOutputText).toBe('Kill sent; no output');
  });
});
