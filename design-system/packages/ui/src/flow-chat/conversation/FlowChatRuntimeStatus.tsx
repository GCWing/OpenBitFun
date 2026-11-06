import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { OverflowText } from '../../primitives/OverflowText';
import { Spinner } from '../../components/Spinner/Spinner';
import './ConversationBlocks.css';

export interface FlowChatRuntimeStatusProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  visible: boolean;
  placement?: 'footer' | 'inline';
  revealDelayMs?: number;
}

/** A resident status slot; submission receipts and the selected hint belong to the host. */
export function FlowChatRuntimeStatus({ label, visible, placement = 'inline', revealDelayMs = 0, className = '', ...props }: FlowChatRuntimeStatusProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [retainPlayback, setRetainPlayback] = useState(visible);
  useEffect(() => {
    if (visible) {
      setRetainPlayback(true);
      return;
    }
    if (!retainPlayback) return;
    // The slot stays mounted. Let its authored exit finish before stopping the
    // glyph; opacity alone does not stop a descendant's decorative animation.
    // Only inspect this element's transitions, never the looping descendants.
    const exitAnimations = contentRef.current?.getAnimations?.() ?? [];
    if (exitAnimations.length === 0) {
      setRetainPlayback(false);
      return;
    }
    let current = true;
    void Promise.allSettled(exitAnimations.map(animation => animation.finished)).then(() => {
      if (current) setRetainPlayback(false);
    });
    return () => { current = false; };
  }, [retainPlayback, visible]);

  return <div {...props}
    className={`runtime-status-slot runtime-status-slot--${placement} ${visible ? 'runtime-status-slot--visible' : ''} ${className}`.trim()}
    data-openbitfun-component="runtime-status-slot" data-openbitfun-part="root"
    aria-hidden={!visible} data-runtime-status-visible={visible ? 'true' : 'false'}>
    <div ref={contentRef} className="runtime-status-slot__content" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="content"
      style={revealDelayMs > 0 ? { transitionDelay: `${revealDelayMs}ms` } : undefined}>
      <span className="runtime-status-slot__icon" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="leadingIcon" aria-hidden="true">
        <Spinner size="md" active={visible || retainPlayback} />
      </span>
      <OverflowText className="runtime-status-slot__hint" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="hint">{label}</OverflowText>
    </div>
  </div>;
}
