// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useDialogCompletionNotify } from './useDialogCompletionNotify';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ complete: null as any, failed: null as any, send: vi.fn(), release: vi.fn() }));
vi.mock('@/infrastructure/api', () => ({ agentAPI: {
  onDialogTurnCompleted: (callback: any) => { mocks.complete = callback; return mocks.release; },
  onDialogTurnFailed: (callback: any) => { mocks.failed = callback; return mocks.release; },
} }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: { sendSystemNotification: mocks.send } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { getConfig: async () => true } }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: new Map([['session', { title: 'Monitor', dialogTurns: [], sessionKind: 'normal' }]]) }) } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('suppresses quiet OS delivery, reports an actual failure and coalesces duplicate terminal events', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  function Fixture() { useDialogCompletionNotify(); return null; }
  const quiet = { sessionId: 'session', turnId: 'quiet-run', success: true, backgroundDelivery: { schemaVersion: 1, source: 'scheduled_job', taskId: 'monitor', runId: 'quiet-run', policy: 'conditional', disposition: 'quiet', resolvedAtMs: 1 } };
  try {
    await act(async () => root.render(<Fixture />));
    await mocks.complete(quiet);
    expect(mocks.send).not.toHaveBeenCalled();
    const failure = { sessionId: 'session', turnId: 'failed-run', error: 'Provider disconnected' };
    await mocks.failed(failure);
    await mocks.complete({ ...failure, success: false });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('notify.dialogFailedTitle', 'notify.dialogFailedWithSession');
  } finally { await act(async () => root.unmount()); node.remove(); hidden.mockRestore(); }
  expect(mocks.release).toHaveBeenCalledTimes(2);
});
