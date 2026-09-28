import type { HTMLAttributes } from 'react';
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
  return <div {...props}
    className={`runtime-status-slot runtime-status-slot--${placement} ${visible ? 'runtime-status-slot--visible' : ''} ${className}`.trim()}
    data-openbitfun-component="runtime-status-slot" data-openbitfun-part="root"
    aria-hidden={!visible} data-runtime-status-visible={visible ? 'true' : 'false'}>
    <div className="runtime-status-slot__content" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="content"
      style={revealDelayMs > 0 ? { transitionDelay: `${revealDelayMs}ms` } : undefined}>
      <span className="runtime-status-slot__icon" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="leadingIcon" aria-hidden="true">
        <Spinner size="sm" />
      </span>
      <OverflowText className="runtime-status-slot__hint" data-openbitfun-component="runtime-status-slot" data-openbitfun-part="hint">{label}</OverflowText>
    </div>
  </div>;
}
