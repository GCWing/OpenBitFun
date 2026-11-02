import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';
import ChatPage from '../../src/pages/ChatPage';
import { useWideLayout } from '../../src/hooks/useWideLayout';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';
import { useMobileStore } from '../../src/services/store';
import type { RemoteSessionManager } from '../../src/services/RemoteSessionManager';

/** Real chat, message actions and sheets; host IO is isolated from live sessions. */
export function mountRollbackFixture(text: string) {
  const element = document.createElement('main');
  document.body.replaceChildren(element);
  useMobileStore.setState({
    connectionHealth: 'connected', currentWorkspace: null, authenticatedUserId: null,
    controlTarget: null, activeTurn: null, messagesBySession: {}, error: null,
  });
  const calls: string[] = [];
  const manager = {
    controlTargetEpoch: 0,
    onControlTargetChange: () => () => {},
    supportsHostCapability: (name: string) => name === 'session_rollback_v1',
    getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }),
    invokeHost: async (command: string) => {
      if (command !== 'get_session_interaction_mailbox') throw new Error(`Unexpected command: ${command}`);
      return { sessionId: 'session', permissions: { revision: 0, requests: [] }, userQuestions: { revision: 0, questions: [] } };
    },
    subscribeSessionStream: async (_id: string, handlers: Parameters<RemoteSessionManager['subscribeSessionStream']>[1]) => {
      handlers.onEvent({ event: 'session-record', session_id: 'session', seq: 1, payload: {
        sessionId: 'session', id: 'turn/first', revision: 1,
        turn: { turnId: 'first', sessionId: 'session', turnIndex: 0, status: 'completed', timestamp: 1,
          userMessage: { id: 'user-1', content: text, timestamp: 1 } },
      } });
      handlers.onHistoryState?.({ hasMore: false, oldestSeq: 1, cursor: 1, truncated: false });
      handlers.onCaughtUp?.();
      return { close() {}, wake() {}, loadOlder: async () => {} };
    },
    rollbackSessionToTurn: async () => { calls.push('rollback'); throw new Error('Unexpected rollback in layout fixture'); },
    sendMessage: async () => { calls.push('send'); throw new Error('Unexpected send in layout fixture'); },
  } as unknown as RemoteSessionManager;
  function Fixture() {
    const wide = useWideLayout();
    return <ThemeProvider><I18nProvider>
      <div className="mobile-app" data-layout={wide ? 'wide' : 'compact'}>
        <div className="remote-shell">
          {wide && <aside className="remote-shell__master" />}
          <section className="remote-shell__detail">
            <ChatPage sessionMgr={manager} sessionId="session" sessionName="Layout fixture" onBack={() => {}} wideLayout={wide} />
          </section>
        </div>
      </div>
    </I18nProvider></ThemeProvider>;
  }
  const root = createRoot(element);
  root.render(<Fixture />);
  return { calls, dispose: () => root.unmount() };
}
