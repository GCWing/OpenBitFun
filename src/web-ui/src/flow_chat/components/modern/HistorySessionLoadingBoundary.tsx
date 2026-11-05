import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FlowChatOpeningBoundary } from './FlowChatOpeningBoundary';
import { SESSION_LOADING_DELAY_MS } from '../../services/sessionOpenIntent';
import './HistorySessionLoadingBoundary.scss';

interface Props {
  identity: string;
  loading: boolean;
  hasTranscript: boolean;
  disabled: boolean;
  intent: boolean;
  label: string;
  onPresentationChange?: (identity: string, ready: boolean) => void;
  children: ReactNode;
}

type Phase = 'idle' | 'loading';

/** Presentation only. The existing viewport owner decides when the transcript is settled. */
export function HistorySessionLoadingBoundary({
  identity, loading, hasTranscript, disabled, intent, label, onPresentationChange, children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const initialPhase: Phase = loading || hasTranscript ? 'loading' : 'idle';
  const [state, setState] = useState<{ identity: string; phase: Phase }>({
    identity, phase: initialPhase,
  });
  if (state.identity !== identity) {
    setState({ identity, phase: initialPhase });
  }
  const phase = state.identity === identity ? state.phase : initialPhase;
  const covering = !disabled && (loading || phase !== 'idle');

  useLayoutEffect(() => {
    onPresentationChange?.(identity, !covering);
  }, [identity, covering, onPresentationChange]);

  useLayoutEffect(() => {
    const setPhase = (next: Phase) => setState(previous => (
      previous.identity === identity && previous.phase !== next
        ? { identity, phase: next }
        : previous
    ));
    // Inactive scenes expose their placeholder and recheck the viewport on resume.
    if (disabled) { setPhase(hasTranscript ? 'loading' : 'idle'); return; }
    if (loading) { setPhase('loading'); return; }
    if (phase === 'idle') return;

    const root = rootRef.current;
    const content = root?.querySelector<HTMLElement>('.history-session-loading__content');
    if (!root || !content) { setPhase('idle'); return; }

    let cancelled = false;
    const observer = new MutationObserver(checkReady);
    function cleanup() {
      cancelled = true;
      observer.disconnect();
      root!.ownerDocument.removeEventListener('visibilitychange', onVisibility);
    }
    function settle() {
      if (cancelled) return;
      cleanup();
      setPhase('idle');
    }
    function onVisibility() {
      if (root!.ownerDocument.hidden) settle();
    }
    function checkReady() {
      if (cancelled || !content) return;
      if (root!.ownerDocument.hidden) { settle(); return; }
      const transcript = content.querySelector<HTMLElement>('.virtual-message-list');
      if (hasTranscript && !transcript) return;
      if (transcript?.dataset.openViewportSettled === 'false') {
        observer.observe(transcript, { attributes: true, attributeFilter: ['data-open-viewport-settled'] });
        return;
      }
      // The complete Turn and viewport are ready. Publish this commit directly.
      settle();
    }

    root.ownerDocument.addEventListener('visibilitychange', onVisibility);
    observer.observe(content, { childList: true, subtree: true });
    checkReady();
    return cleanup;
    // Phase changes belong to this request's readiness observer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, loading, hasTranscript, disabled]);

  const skeleton = <HistorySessionSkeleton key={identity} />;
  const overlayProps = {
    className: 'history-session-loading__overlay',
    role: 'status',
    'aria-label': label,
  };

  return (
    <div ref={rootRef} className="history-session-loading" data-history-loading-phase={covering ? phase : 'idle'}>
      <FlowChatOpeningBoundary
        opening={covering}
        className="history-session-loading__content"
        style={{ opacity: covering ? 0 : undefined }}
        data-openbitfun-component="modern-flow-chat"
        data-openbitfun-part="historyContent"
      >
        {children}
      </FlowChatOpeningBoundary>
      {covering && (intent ? (
        <div {...overlayProps} data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOpenIntent">
          {skeleton}
          {/* Keep saved appearance packages readable after retiring the visible spinner. */}
          <span hidden data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOpenIntentSpinner" />
        </div>
      ) : (
        <div {...overlayProps} data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historyOverlay">
          {skeleton}
        </div>
      ))}
    </div>
  );
}

/** The history loading skeleton, shared with presentations that precede a session (a device switch). */
export function HistorySessionSkeleton() {
  return (
    <div className="history-session-skeleton" style={{ animationDelay: `${SESSION_LOADING_DELAY_MS}ms` }}
      aria-hidden="true" data-openbitfun-component="modern-flow-chat" data-openbitfun-part="historySkeleton">
      <div className="history-session-skeleton__column">
        <div className="history-session-skeleton__user"><span /><span /></div>
        <div className="history-session-skeleton__group history-session-skeleton__group--first">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
        <div className="history-session-skeleton__group history-session-skeleton__group--second">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
        <div className="history-session-skeleton__group history-session-skeleton__group--third">
          <span className="history-session-skeleton__bar" data-history-loading-line />
          <span className="history-session-skeleton__bar" data-history-loading-line />
        </div>
      </div>
    </div>
  );
}
