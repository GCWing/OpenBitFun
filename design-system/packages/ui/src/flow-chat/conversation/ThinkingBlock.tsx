import { forwardRef, useCallback, useId, useRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { OverflowText } from '../../primitives/OverflowText';
import { useThinkingAnnotation } from './useThinkingAnnotation';
import './ConversationBlocks.css';

export interface ThinkingBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode;
  expanded: boolean;
  streaming?: boolean;
  visuallyStreaming?: boolean;
  reasoningKind?: 'reasoning' | 'summary';
  status?: string;
  context?: 'default' | 'subagent-projection';
  label: string;
  /** Accessible name and tooltip for the completed reasoning side icon. */
  capsuleLabel?: string;
  /** Dock a settled disclosure beside the next sibling marked data-thinking-continuation. */
  collapseIntoNext?: boolean;
  /** A containing FlowGroup can own scrolling for the entire execution stream. */
  scrollOwner?: 'self' | 'parent';
  onToggle?: () => void;
  /** Open host-owned details without changing the inline streaming disclosure. */
  onOpenDetails?: () => void;
  contentRef?: Ref<HTMLDivElement>;
  expandContainerRef?: Ref<HTMLDivElement>;
  /** Keep the disclosure shell while omitting an inactive Markdown tree. */
  mountContent?: boolean;
  contentProps?: HTMLAttributes<HTMLDivElement>;
  scrollState?: { hasScroll: boolean; atTop: boolean; atBottom: boolean };
}

/** Controlled view. Reveal, stream and scrolling ownership remain with the consumer. */
export const ThinkingBlock = forwardRef<HTMLDivElement, ThinkingBlockProps>(function ThinkingBlock({
  children, expanded, streaming = false, visuallyStreaming = streaming,
  reasoningKind = 'reasoning', status, context = 'default', label, capsuleLabel = label, onToggle, onOpenDetails, collapseIntoNext = false, scrollOwner = 'self',
  contentRef, expandContainerRef, mountContent = true, contentProps, scrollState = { hasScroll: false, atTop: true, atBottom: true },
  className = '', ...props
}, ref) {
  const contentId = useId();
  const toggleId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const setRootRef = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref) ref.current = element;
  }, [ref]);
  const docked = collapseIntoNext && !expanded && !visuallyStreaming;
  const accessibleLabel = docked ? capsuleLabel : label;
  const onActivate = onOpenDetails ?? onToggle;

  const { tooltipBlocked, tooltipActive, canShowTooltip } = useThinkingAnnotation(rootRef, toggleRef, docked);

  return <div {...props} ref={setRootRef}
    data-openbitfun-component="model-thinking-display" data-openbitfun-part="root"
    data-openbitfun-context={context}
    data-openbitfun-state={[expanded && 'expanded', visuallyStreaming && 'streaming'].filter(Boolean).join(' ')}
    data-testid="chat-thinking-panel" data-status={status}
    data-streaming={streaming ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'}
    data-reasoning-kind={reasoningKind}
    data-scroll-owner={scrollOwner}
    data-thinking-attachment={collapseIntoNext ? (docked ? 'side' : 'block') : undefined}
    className={`flow-thinking-item ${reasoningKind} ${expanded ? 'expanded' : 'collapsed'} ${className}`.trim()}
  >
    <div className="thinking-header-slot">
      <div data-openbitfun-component="model-thinking-display" data-openbitfun-part="header"
        className="thinking-collapsed-header"
      >
        {/* Keep one tooltip owner across docking; retained click focus must not
            reopen a title fallback when the disclosure changes state. */}
        <span className="thinking-annotation-line thinking-annotation-line--before" aria-hidden="true" />
        <Tooltip content={capsuleLabel} disabled={!docked || tooltipBlocked} trigger="hover"
          active={tooltipActive} onBeforeShow={canShowTooltip}>
          <IconButton ref={toggleRef} id={toggleId} data-testid="chat-thinking-toggle" className="thinking-toggle"
            size="xs" shape="square" variant="quiet" disabled={!onActivate}
            aria-label={accessibleLabel}
            aria-expanded={!onOpenDetails && onToggle ? expanded : undefined}
            aria-controls={!onOpenDetails && onToggle ? contentId : undefined}
            onClick={onActivate}
            icon={<span className="thinking-leading-icon" data-openbitfun-component="model-thinking-display" data-openbitfun-part="leadingIcon">
              {onOpenDetails ? <Icon name="thinking" size="sm" /> : <>
                <Icon name="thinking" size="sm" className="thinking-leading-icon__default" />
                <Icon name="chevron-right" size="sm" className="thinking-leading-icon__collapsed-hover" />
                <Icon name="chevron-down" size="sm" className="thinking-leading-icon__expanded" />
              </>}
            </span>}
          />
        </Tooltip>
        <span className="thinking-annotation-line thinking-annotation-line--after" aria-hidden="true" />
        <label data-overflow-trigger className="thinking-label-target" htmlFor={toggleId}>
          <OverflowText data-openbitfun-component="model-thinking-display" data-openbitfun-part="label"
            className="thinking-label" title={docked ? '' : reasoningKind === 'summary' && !expanded ? label : undefined}>{label}</OverflowText>
        </label>
      </div>
    </div>
    <div id={contentId} aria-hidden={!expanded} {...{ inert: !expanded ? '' : undefined }}
      ref={expandContainerRef}
      className={`thinking-expand-container${expanded ? ' thinking-expand-container--open' : ''}`}
      data-openbitfun-component="model-thinking-display" data-openbitfun-part="expandContainer">
      {mountContent && <div className={`thinking-content-wrapper ${scrollState.hasScroll ? 'has-scroll' : ''} ${scrollState.atTop ? 'at-top' : ''} ${scrollState.atBottom ? 'at-bottom' : ''}`}
        data-openbitfun-component="model-thinking-display" data-openbitfun-part="contentWrapper">
        <div {...contentProps} ref={contentRef} data-openbitfun-component="model-thinking-display"
          data-openbitfun-part="content" data-testid="chat-thinking-content" data-status={status}
          data-streaming={streaming ? 'true' : 'false'} className={`thinking-content expanded ${contentProps?.className ?? ''}`.trim()}>
          {children}
        </div>
      </div>}
    </div>
  </div>;
});
