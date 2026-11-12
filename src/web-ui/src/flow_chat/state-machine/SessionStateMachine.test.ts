import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStateMachineImpl } from './SessionStateMachine';
import { SessionExecutionEvent, SessionExecutionState } from './types';

import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const cancelSessionTask = vi.fn();
const interruptDialogTurn = vi.fn();

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    cancelSessionTask,
    getState: () => ({
      sessions: new Map([['session-1', {
        sessionId: 'session-1',
        sessionKind: 'normal',
        mode: 'Standard',
        config: { agentType: 'Standard' },
      }]]),
    }),
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    interruptDialogTurn,
    cancelDialogTurn: vi.fn(),
  },
}));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => false,
}));

describe('SessionStateMachine recoverable interruption', () => {
  beforeEach(() => {
    activateSurface('local');
    cancelSessionTask.mockReset();
    interruptDialogTurn.mockReset();
    interruptDialogTurn.mockResolvedValue(undefined);
  });

  it('does not run the legacy optimistic turn persistence before Runtime interruption', async () => {
    const machine = new SessionStateMachineImpl('session-1');
    await machine.transition(SessionExecutionEvent.START, {
      taskId: 'session-1',
      dialogTurnId: 'turn-1',
    });

    await machine.transition(SessionExecutionEvent.USER_CANCEL);

    expect(interruptDialogTurn).toHaveBeenCalledWith('session-1', 'turn-1');
    expect(cancelSessionTask).not.toHaveBeenCalled();
  });
});

describe('cancellation ownership', () => {
  beforeEach(() => { activateSurface('local'); interruptDialogTurn.mockReset(); });

  it('does not issue a cancel through the newly selected device after an async import', async () => {
    const machine = new SessionStateMachineImpl('session-1');
    await machine.transition(SessionExecutionEvent.START, { taskId: 'session-1', dialogTurnId: 'turn-1' });
    const pending = machine.transition(SessionExecutionEvent.USER_CANCEL);
    activateSurface('peer-other');
    await pending;
    expect(interruptDialogTurn).not.toHaveBeenCalled();
    activateSurface('local');
  });

  it('still sends the requested stop if a running snapshot arrives during preparation', async () => {
    interruptDialogTurn.mockResolvedValue(undefined);
    const machine = new SessionStateMachineImpl('session-1');
    await machine.transition(SessionExecutionEvent.START, { taskId: 'session-1', dialogTurnId: 'turn-1' });
    const pending = machine.transition(SessionExecutionEvent.USER_CANCEL);
    machine.acceptRuntimeStatus({ state: SessionExecutionState.PROCESSING, turnId: 'turn-1',
      roundId: null, phase: null, pendingTools: [], error: null });
    await pending;
    expect(interruptDialogTurn).toHaveBeenCalledWith('session-1', 'turn-1');
  });

  it('restores processing after cancellation fails even if text arrived while waiting', async () => {
    let reject!: (error: Error) => void;
    interruptDialogTurn.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const machine = new SessionStateMachineImpl('session-1');
    await machine.transition(SessionExecutionEvent.START, { taskId: 'session-1', dialogTurnId: 'turn-1' });
    const pending = machine.transition(SessionExecutionEvent.USER_CANCEL);
    await vi.waitFor(() => expect(interruptDialogTurn).toHaveBeenCalled());
    await machine.transition(SessionExecutionEvent.TEXT_CHUNK_RECEIVED, { text: 'Still running' });
    reject(new Error('Stop request failed'));
    await pending;
    expect(machine.getCurrentState()).toBe(SessionExecutionState.PROCESSING);
    expect(machine.getContext().currentDialogTurnId).toBe('turn-1');
  });

  it('does not move a newer finishing turn back to processing after an old cancellation fails', async () => {
    let reject!: (error: Error) => void;
    interruptDialogTurn.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const machine = new SessionStateMachineImpl('session-1');
    await machine.transition(SessionExecutionEvent.START, { taskId: 'session-1', dialogTurnId: 'turn-1' });
    const pending = machine.transition(SessionExecutionEvent.USER_CANCEL);
    await vi.waitFor(() => expect(interruptDialogTurn).toHaveBeenCalled());
    machine.acceptRuntimeStatus({ state: SessionExecutionState.FINISHING, turnId: 'turn-2',
      roundId: null, phase: null, pendingTools: [], error: null });
    reject(new Error('Relay connection closed before the reply arrived'));
    await pending;
    expect(machine.getCurrentState()).toBe(SessionExecutionState.FINISHING);
    expect(machine.getContext().currentDialogTurnId).toBe('turn-2');
  });
});
