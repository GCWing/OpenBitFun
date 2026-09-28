import type { ExecToolSnapshot, PresentationClock } from './exec/contracts';

export const SCENARIO_EPOCH = 100_000;
export type ExecToolName = 'ExecCommand' | 'WriteStdin' | 'ExecControl';
export interface ExecScenarioStep {
  at: number;
  phase: 'parameters' | 'waiting' | 'output' | 'completed' | 'settled' | 'confirmation' | 'error' | 'cancelled' | 'rejected';
  item: ExecToolSnapshot;
}
export interface ExecScenario {
  id: string;
  toolName: ExecToolName;
  steps: readonly ExecScenarioStep[];
}

const inputs: Record<ExecToolName, Record<string, unknown>> = {
  ExecCommand: { cmd: 'pnpm run test:unit', workdir: '/workspace/project', yield_time_ms: 1000 },
  WriteStdin: { session_id: 42, chars: '', yield_time_ms: 1000 },
  ExecControl: { session_id: 42, action: 'interrupt' },
};

export function execSnapshot(toolName: ExecToolName, overrides: Partial<ExecToolSnapshot> = {}): ExecToolSnapshot {
  return {
    id: `scenario-${toolName}`, toolName, status: 'running', startTime: SCENARIO_EPOCH,
    toolCall: { id: `call-${toolName}`, input: { ...inputs[toolName] } }, ...overrides,
  };
}

const output = 'Running unit tests…\n12 tests passed\n';
const result = { output, exit_code: 0, wall_time_seconds: 0.6, workdir: '/workspace/project', remote: true };
const step = (toolName: ExecToolName, at: number, phase: ExecScenarioStep['phase'], overrides: Partial<ExecToolSnapshot>): ExecScenarioStep => ({
  at, phase, item: execSnapshot(toolName, overrides),
});

/** Raw boundary inputs, consumed by the real projection and presenter in both Lab and tests. */
export const execScenarios: readonly ExecScenario[] = (['ExecCommand', 'WriteStdin', 'ExecControl'] as const).flatMap((toolName) => [
  { id: `${toolName}-lifecycle`, toolName, steps: [
    step(toolName, 0, 'parameters', { status: 'preparing', isParamsStreaming: true }),
    step(toolName, 100, 'waiting', { status: 'running' }),
    step(toolName, 200, 'output', { status: 'running', _progressLogs: ['Running unit tests…\n'] }),
    step(toolName, 700, 'completed', { status: 'completed', toolResult: { result } }),
    step(toolName, 1200, 'settled', { status: 'completed', toolResult: { result } }),
  ] },
  { id: `${toolName}-approval`, toolName, steps: [
    step(toolName, 0, 'confirmation', { status: 'pending_confirmation' }),
    step(toolName, 300, 'rejected', { status: 'cancelled', userConfirmed: false, toolResult: { error: 'User rejected' } }),
  ] },
  { id: `${toolName}-error`, toolName, steps: [
    step(toolName, 0, 'waiting', { status: 'running' }),
    step(toolName, 300, 'error', { status: 'error', toolResult: { error: 'Remote process is unavailable' } }),
  ] },
  { id: `${toolName}-cancelled`, toolName, steps: [
    step(toolName, 0, 'output', { status: 'running', _progressMessage: 'Partial output\n' }),
    step(toolName, 300, 'cancelled', { status: 'cancelled', _progressMessage: 'Partial output\n' }),
    step(toolName, 1000, 'settled', { status: 'cancelled', _progressMessage: 'Partial output\n' }),
  ] },
  { id: `${toolName}-empty`, toolName, steps: [
    step(toolName, 0, 'waiting', { status: 'running' }),
    step(toolName, 300, 'completed', { status: 'completed', toolResult: { result: { output: '', exit_code: 0 } } }),
  ] },
]).concat([
  { id: 'ExecCommand-nonzero', toolName: 'ExecCommand', steps: [step('ExecCommand', 0, 'completed', {
    status: 'completed', toolResult: { result: { ...result, exit_code: 1, output: 'One test failed\n' } },
  })] },
  { id: 'ExecCommand-legacy', toolName: 'ExecCommand', steps: [step('ExecCommand', 0, 'completed', {
    status: 'completed', toolResult: { result: JSON.stringify(result) },
  })] },
  { id: 'WriteStdin-missing', toolName: 'WriteStdin', steps: [step('WriteStdin', 0, 'completed', {
    status: 'completed', toolResult: { result: { status: 'session_not_found', requested_session_id: 42 } },
  })] },
  { id: 'WriteStdin-input', toolName: 'WriteStdin', steps: [step('WriteStdin', 0, 'completed', {
    status: 'completed', toolCall: { input: { session_id: 42, chars: 'yes\n' } }, toolResult: { result: { output: 'Accepted\n', session_id: 42 } },
  })] },
  { id: 'ExecControl-kill', toolName: 'ExecControl', steps: [step('ExecControl', 0, 'completed', {
    status: 'completed', toolCall: { input: { session_id: '42', action: 'kill' } }, toolResult: { result: { session_id: 42, action: 'kill', output: '' } },
  })] },
]);

/** Advancing this clock exercises production grace timers; replay creates a new clock. */
export function createScenarioClock(initialTime = SCENARIO_EPOCH): PresentationClock & { advanceTo: (at: number) => void } {
  let now = initialTime;
  const scheduled = new Map<symbol, { at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback, delayMs) {
      const id = Symbol();
      scheduled.set(id, { at: now + Math.max(0, delayMs), callback });
      return () => { scheduled.delete(id); };
    },
    advanceTo(at) {
      if (!Number.isFinite(at) || at < now) throw new RangeError('Scenario time must move forward.');
      while (true) {
        const next = [...scheduled].filter(([, timer]) => timer.at <= at).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        scheduled.delete(next[0]);
        next[1].callback();
      }
      now = at;
    },
  };
}
