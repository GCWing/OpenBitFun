import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatTranscript from '../../src/components/ChatTranscript';
import { I18nProvider } from '../../src/i18n';
import { SessionEventReducer } from '../../src/services/SessionEventReducer';
import type { ChatMessage } from '../../src/services/RemoteSessionManager';
import type { SessionEvent } from '../../../shared/relay-transport/HostStream';

const hostDelivery = { schemaVersion: 1, source: 'scheduled_job', taskId: 'arbitrary-monitor', runId: 'run', policy: 'conditional', disposition: 'pending', executionGeneration: 0 };
const event = (name: string, payload: Record<string, unknown>) => ({ event: `agentic://${name}`, payload: { turnId: 'run', ...payload } }) as SessionEvent;

export function reduceBackgroundExecution() {
  const reducer = new SessionEventReducer();
  const start = reducer.apply(event('dialog-turn-started', { originalUserInput: 'Report only meaningful changes.', userMessageMetadata: { backgroundDelivery: hostDelivery } }))!;
  reducer.apply(event('text-chunk', { text: 'Nothing changed; remaining quiet.', roundId: 'r', attemptId: 'a' }));
  const finished = reducer.apply(event('dialog-turn-completed', { success: true, backgroundDelivery: { ...hostDelivery, disposition: 'quiet', resolvedAtMs: 1 } }))!;
  return { start, finished };
}

export function rejectsOldGeneration() {
  const reducer = new SessionEventReducer();
  reducer.apply(event('dialog-turn-started', { userMessageMetadata: { backgroundDelivery: hostDelivery } }));
  reducer.apply(event('dialog-turn-recovered', { executionGeneration: 1 }));
  const old = reducer.apply(event('dialog-turn-completed', { backgroundDelivery: { ...hostDelivery, disposition: 'quiet', resolvedAtMs: 1 } }));
  return { old, active: reducer.active };
}

let root: ReturnType<typeof createRoot>;
export function showBackgroundTranscript(mode: 'quiet' | 'legacy' | 'failure' | 'question') {
  if (!root) {
    document.body.innerHTML = '<main id="background-fixture" style="padding:16px"></main>';
    root = createRoot(document.querySelector('#background-fixture')!);
  }
  const delivery = mode === 'legacy' ? undefined : { ...hostDelivery, disposition: mode === 'question' ? 'pending' : 'quiet', resolvedAtMs: 1 };
  const messages: ChatMessage[] = [
    { id: 'user', turn_id: 'run', role: 'user', content: 'Report only meaningful changes.', timestamp: '1', status: mode === 'question' ? 'active' : 'completed', metadata: { backgroundDelivery: delivery } },
    { id: 'assistant', turn_id: 'run', role: 'assistant', content: 'Nothing changed; remaining quiet.', timestamp: '1', status: mode === 'failure' ? 'failed' : 'completed', metadata: { backgroundDelivery: delivery } },
  ];
  const activeTurn = mode === 'question' ? { turn_id: 'run', status: 'active', text: '', thinking: '', round_index: 0, backgroundDelivery: delivery,
    tools: [{ id: 'question', name: 'AskUserQuestion', status: 'running', tool_input: { questions: [{ question: 'Choose a value', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] } }] } : null;
  root.render(<I18nProvider><ChatTranscript messages={mode === 'question' ? messages.slice(0, 1) : messages} activeTurn={activeTurn}
    now={1} expandedMessageIds={new Set()} imageAnalyzing={false} optimisticMessage={null}
    onAnswerQuestion={async () => {}} onApproveTool={async () => {}} onRejectTool={async () => {}}
    onCancelActiveTool={() => {}} onCancelLegacyTool={() => {}} onMessageContextMenu={() => {}}
    onMessageTouchEnd={() => {}} onMessageTouchMove={() => {}} onMessageTouchStart={() => {}} onToggleMessage={() => {}} />
  </I18nProvider>);
}
