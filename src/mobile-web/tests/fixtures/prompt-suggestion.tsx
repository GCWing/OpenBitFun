import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/reset.scss';
import '@openbitfun/theme-openbitfun/default.css';
import '@openbitfun/ui/mobile.css';
import '../../src/styles/index.scss';
import ChatComposerBar from '../../src/components/ChatComposerBar';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';
import { SessionSynchronizer } from '../../src/services/SessionSynchronizer';
import type { RemoteSessionManager } from '../../src/services/RemoteSessionManager';

/** Production stream projection and composer; only host IO is simulated. */
export function mountPromptSuggestionFixture() {
  const element = document.createElement('main');
  document.body.replaceChildren(element);
  type StreamHandlers = Parameters<RemoteSessionManager['subscribeSessionStream']>[1];
  let handlers: StreamHandlers;
  let setOffline: (value: boolean) => void;
  let setSending: (value: boolean) => void;
  const calls: string[] = [];
  const manager = { subscribeSessionStream: async (_id: string, next: StreamHandlers) => {
    handlers = next;
    return { close() {}, wake() {}, loadOlder: async () => {} };
  } } as unknown as RemoteSessionManager;
  const root = createRoot(element);
  function Fixture() {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [input, setInput] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [suggestion, setSuggestion] = useState<string | null>(null);
    const [streaming, setStreaming] = useState(false);
    const [offline, updateOffline] = useState(false);
    const [sending, updateSending] = useState(false);
    setOffline = updateOffline;
    setSending = updateSending;
    useEffect(() => {
      const stream = new SessionSynchronizer(manager, 'session', update => {
        setSuggestion(update.prompt_suggestion ?? null);
        setStreaming(Boolean(update.active_turn));
      });
      stream.start();
      return () => stream.stop();
    }, []);
    const noop = () => {};
    return <ThemeProvider><I18nProvider><div className="chat-page">
      <ChatComposerBar cancelling={false} containerRef={null} expanded={expanded}
        imageAnalyzing={false} sending={sending} input={input} inputRef={inputRef} modelControls={null}
        onActivate={() => setExpanded(true)} onAttach={noop} onCancel={noop} onChange={setInput}
        onCompositionEnd={noop} onCompositionStart={noop} onKeyDown={noop} onRemoveImage={noop}
        onSend={() => calls.push('send')} pendingImages={[]} remoteUnavailable={offline} streaming={streaming}
        promptSuggestion={suggestion} onAcceptPromptSuggestion={value => {
          calls.push(value); setInput(value); setExpanded(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }} />
    </div></I18nProvider></ThemeProvider>;
  }
  root.render(<Fixture />);
  return { calls, ready: () => Boolean(handlers), event: (event: Parameters<StreamHandlers['onEvent']>[0]) => handlers.onEvent(event),
    caughtUp: () => handlers.onCaughtUp?.(), gap: () => handlers.onGap?.('fixture restart'),
    offline: (value: boolean) => setOffline(value), sending: (value: boolean) => setSending(value), dispose: () => root.unmount() };
}
