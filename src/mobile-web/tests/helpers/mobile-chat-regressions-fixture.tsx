import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatTranscript from '../../src/components/ChatTranscript';
import { I18nProvider } from '../../src/i18n';
import type { ChatMessage, ChatMessageItem, RemoteToolStatus } from '../../src/services/RemoteSessionManager';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';

let root: ReturnType<typeof createRoot>;
export function showTranscript(approval = false, variant: 'legacy' | 'ordered' | 'subagent' = 'legacy', taskStatus: RemoteToolStatus['status'] = 'completed') {
  if (!root) {
    document.body.innerHTML = '<main id="transcript-fixture" style="padding:24px;max-width:720px;margin:auto"></main>';
    root = createRoot(document.querySelector('#transcript-fixture')!);
  }
  const tools: RemoteToolStatus[] = Array.from({ length: 7 }, (_, i) => ({ id: `tool-${i}`, name: 'WebFetch',
    status: i === 2 ? 'failed' : 'completed', tool_input: { url: `https://example.com/${i}` },
    error_preview: i === 2 ? 'HTTP 404: requested page does not exist' : undefined }));
  if (approval) tools.push({ id: 'approval', name: 'Write', status: 'pending_confirmation', tool_input: { url: '/tmp/report.md' }, error_preview: undefined });
  let items: ChatMessageItem[] | undefined;
  let displayedTools = tools;
  if (variant === 'ordered') {
    tools.forEach((tool, index) => { tool.name = 'Read'; if (index === 3) tool.status = 'cancelled'; });
    items = tools.map(tool => ({ type: 'tool', tool }));
  } else if (variant === 'subagent') {
    const task: RemoteToolStatus = { id: 'task', name: 'Task', status: taskStatus };
    displayedTools = [task, ...tools];
    items = [{ type: 'tool', tool: task }, ...tools.map(tool => ({ type: 'tool', tool, is_subagent: true }))];
  }
  const messages: ChatMessage[] = [
    { id: 'user', role: 'user', content: 'Check the links and summarize the findings.', timestamp: '1700000000' },
    { id: 'assistant', role: 'assistant', content: 'The remaining sources confirm the result.', timestamp: '1700000001000', tools: displayedTools, items },
  ];
  root.render(<I18nProvider><ChatTranscript messages={messages} activeTurn={null} now={1700000001000}
    expandedMessageIds={new Set()} imageAnalyzing={false} optimisticMessage={null}
    onAnswerQuestion={async () => {}} onApproveTool={async () => {}} onRejectTool={async () => {}}
    onCancelActiveTool={() => {}} onCancelLegacyTool={() => {}} onMessageContextMenu={() => {}}
    onMessageTouchEnd={() => {}} onMessageTouchMove={() => {}} onMessageTouchStart={() => {}} onToggleMessage={() => {}} />
  </I18nProvider>);
}
