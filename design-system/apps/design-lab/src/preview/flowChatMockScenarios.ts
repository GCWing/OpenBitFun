import { execScenarios, type ExecScenario } from '@openbitfun/flow-chat-presentation/scenarios';
import type { ExecToolSnapshot } from '@openbitfun/flow-chat-presentation/exec';

export type FlowChatMockPhase = 'thinking' | 'exploring' | 'question' | 'editing' | 'command' | 'result';
export interface FlowChatMockStep {
  phase: FlowChatMockPhase;
  at: number;
  command?: ExecToolSnapshot;
}
export interface FlowChatMockScenario {
  id: 'completed' | 'running' | 'question' | 'error' | 'cancelled';
  steps: readonly FlowChatMockStep[];
  initialStep: number;
}

function conversationSteps(id: string, question = false): FlowChatMockStep[] {
  const command = execScenarios.find((scenario) => scenario.id === id) as ExecScenario;
  const steps: FlowChatMockStep[] = [
    { phase: 'thinking', at: 0 },
    { phase: 'exploring', at: 200 },
    ...(question ? [{ phase: 'question' as const, at: 400 }] : []),
    { phase: 'editing', at: 600 },
  ];
  // Keep raw command snapshots and production lifecycle policy in their existing owner.
  for (const step of command.steps) {
    steps.push({ phase: 'command', at: 1000 + step.at, command: step.item });
  }
  steps.push({ phase: 'result', at: 2400, command: command.steps[command.steps.length - 1]!.item });
  return steps;
}

const completed = conversationSteps('ExecCommand-lifecycle');
const question = conversationSteps('ExecCommand-lifecycle', true);
const error = conversationSteps('ExecCommand-error');
const cancelled = conversationSteps('ExecCommand-cancelled');

/** Lab-only conversation composition; no runtime store, transport or command execution. */
export const flowChatMockScenarios: readonly FlowChatMockScenario[] = [
  { id: 'completed', steps: completed, initialStep: completed.length - 1 },
  { id: 'running', steps: completed, initialStep: completed.findIndex((step) => Array.isArray(step.command?._progressLogs)) },
  { id: 'question', steps: question, initialStep: question.findIndex((step) => step.phase === 'question') },
  { id: 'error', steps: error, initialStep: error.length - 1 },
  { id: 'cancelled', steps: cancelled, initialStep: cancelled.length - 1 },
];
