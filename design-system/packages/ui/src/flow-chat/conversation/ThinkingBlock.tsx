import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton';
import { ThinkingIndicator } from '../../components/ThinkingIndicator';
import { Tooltip } from '../../components/Tooltip';
import { OverflowText } from '../../primitives/OverflowText';
import { useThinkingAnnotation } from './useThinkingAnnotation';
import type { ThinkingContinuationResolver } from './useThinkingAnnotation';
import { useThinkingHandoff } from './useThinkingHandoff';
import { useThinkingSuccessor } from './useThinkingSuccessor';
import './ConversationBlocks.css';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface ThinkingBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode;
  expanded: boolean;
  streaming?: boolean;
  visuallyStreaming?: boolean;
  /** The reader's seven-line viewport during streaming and visual reveal. */
  streamingExpanded?: boolean;
  onStreamingExpandedChange?: (expanded: boolean) => void;
  /** A closing parent owns the fold; preserve the last live viewport until unmount. */
  retainStreamingViewport?: boolean;
  reasoningKind?: 'reasoning' | 'summary';
  status?: string;
  context?: 'default' | 'subagent-projection';
  label: string;
  /** Accessible name and tooltip for the completed reasoning side icon. */
  capsuleLabel?: string;
  /** Dock a settled disclosure beside a continuation marked data-thinking-continuation. */
  collapseIntoNext?: boolean;
  /** Recycled rows settle initial placement and measure resting side controls on interaction. */
  virtualized?: boolean;
  /** Resolve a continuation in a peer container when it is not a direct sibling. */
  resolveContinuation?: ThinkingContinuationResolver;
  /** Coordinate the first live successor with the outgoing row, without remounting it. */
  coordinateContinuation?: boolean;
  /** Scope a handoff to the host's session/item/attempt identity. */
  handoffIdentity?: string;
  /** Availability, attention bypass, and whether the local handoff is still pending. */
  onContinuationReadyChange?: (ready: boolean, immediate: boolean, pending: boolean) => void;
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
  streamingExpanded = false, onStreamingExpandedChange, retainStreamingViewport = false,
  reasoningKind = 'reasoning', status, context = 'default', label, capsuleLabel = label, onToggle, onOpenDetails, collapseIntoNext = false, resolveContinuation, scrollOwner = 'self',
  coordinateContinuation = false, handoffIdentity, onContinuationReadyChange, virtualized = false,
  contentRef, expandContainerRef, mountContent = true, contentProps, scrollState = { hasScroll: false, atTop: true, atBottom: true },
  className = '', style, ...props
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
  const hasStreamingDisclosure = visuallyStreaming && Boolean(onStreamingExpandedChange);
  const liveViewport = hasStreamingDisclosure && expanded
    ? (streamingExpanded ? 'expanded' : 'compact') : undefined;
  const lastLiveViewport = useRef(liveViewport);
  // Interaction ends immediately, but the outgoing body must keep its geometry.
  // Retain the inline header layout after release as well: restoring a separate
  // header row would replay a second height change at the end of the fold.
  const viewport = liveViewport ?? ((!expanded || retainStreamingViewport) ? lastLiveViewport.current : undefined);
  useIsomorphicLayoutEffect(() => {
    if (liveViewport !== undefined || (expanded && !retainStreamingViewport)) lastLiveViewport.current = liveViewport;
  }, [expanded, liveViewport, retainStreamingViewport]);
  const wantsDock = collapseIntoNext && !expanded && !visuallyStreaming;
  const { hasContinuation, tooltipBlocked, tooltipActive, canShowTooltip } = useThinkingAnnotation(rootRef, toggleRef, wantsDock, resolveContinuation, virtualized);
  const docked = wantsDock && hasContinuation;
  const handoff = useThinkingHandoff(rootRef, docked, label, wantsDock, virtualized);
  const exchange = useThinkingSuccessor(rootRef, {
    identity: handoffIdentity, enabled: coordinateContinuation,
    expanded, visuallyStreaming, resolveContinuation, onReadyChange: onContinuationReadyChange,
  });
  const accessibleLabel = docked ? capsuleLabel : label;
  const compactViewport = expanded && viewport === 'compact';
  const onActivate = hasStreamingDisclosure
    ? () => onStreamingExpandedChange?.(!streamingExpanded)
    : onOpenDetails ?? onToggle;

  return <div {...props} ref={setRootRef}
    data-openbitfun-component="model-thinking-display" data-openbitfun-part="root"
    data-openbitfun-context={context}
    data-openbitfun-state={[expanded && 'expanded', visuallyStreaming && 'streaming'].filter(Boolean).join(' ')}
    data-testid="chat-thinking-panel" data-status={status}
    data-streaming={streaming ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'}
    data-streaming-expanded={hasStreamingDisclosure && expanded ? String(streamingExpanded) : undefined}
    data-thinking-viewport={viewport}
    data-reasoning-kind={reasoningKind}
    data-scroll-owner={scrollOwner}
    data-thinking-attachment={collapseIntoNext ? (docked ? 'side' : 'block') : undefined}
    data-thinking-phase={handoff.phase} data-thinking-origin={handoff.origin}
    data-thinking-exchange={exchange}
    data-thinking-motion={handoff.motionReady ? undefined : 'initial'}
    style={{ ...style, '--_thinking-handoff-top': handoff.top } as CSSProperties}
    className={`flow-thinking-item ${reasoningKind} ${expanded ? 'expanded' : 'collapsed'} ${className}`.trim()}
  >
    <div className="thinking-header-slot">
      <div data-openbitfun-component="model-thinking-display" data-openbitfun-part="header"
        className="thinking-collapsed-header"
      >
        {/* Keep one tooltip owner across docking; retained click focus must not
            reopen a title fallback when the disclosure changes state. */}
        <span className="thinking-annotation-line thinking-annotation-line--before" aria-hidden="true" />
        <Tooltip content={capsuleLabel} disabled={handoff.phase !== 'side' || tooltipBlocked} trigger="hover"
          active={tooltipActive} onBeforeShow={canShowTooltip}>
          <IconButton ref={toggleRef} id={toggleId} data-testid="chat-thinking-toggle" className="thinking-toggle"
            size="xs" shape="square" variant="quiet" disabled={!onActivate}
            aria-label={accessibleLabel}
            aria-expanded={hasStreamingDisclosure ? streamingExpanded : !onOpenDetails && onToggle ? expanded : undefined}
            aria-controls={hasStreamingDisclosure || (!onOpenDetails && onToggle) ? contentId : undefined}
            onClick={onActivate}
            icon={<span className="thinking-leading-icon" data-openbitfun-component="model-thinking-display" data-openbitfun-part="leadingIcon">
              <ThinkingIndicator active={streaming} size="sm"
                className={onOpenDetails || streaming ? undefined : 'thinking-leading-icon__default'} />
              {!onOpenDetails && !streaming && <>
                <Icon name="chevron-right" size="sm" className="thinking-leading-icon__collapsed-hover" />
                <Icon name="chevron-down" size="sm" className="thinking-leading-icon__expanded" />
              </>}
            </span>}
          />
        </Tooltip>
        <span className="thinking-annotation-line thinking-annotation-line--after" aria-hidden="true" />
        <label data-overflow-trigger className="thinking-label-target" htmlFor={toggleId}>
          <OverflowText data-openbitfun-component="model-thinking-display" data-openbitfun-part="label"
            className="thinking-label" title={docked ? '' : reasoningKind === 'summary' && !expanded ? label : undefined}>{handoff.label}</OverflowText>
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
          aria-hidden={compactViewport || undefined} {...{ inert: compactViewport ? '' : undefined }}
          data-streaming={streaming ? 'true' : 'false'} className={`thinking-content expanded ${contentProps?.className ?? ''}`.trim()}>
          <div className="thinking-content-body">{children}</div>
        </div>
      </div>}
    </div>
  </div>;
});
