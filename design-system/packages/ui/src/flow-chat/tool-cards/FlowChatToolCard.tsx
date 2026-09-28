import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { useDesignSystem } from '../../overlay/useDesignSystem';
import { ToolProcessingDots } from './ToolProcessingDots';
import { ToolCapsulePresentationProvider, useToolCapsulePresentation } from './ToolCapsulePresentation';
import { TOOL_CAPSULE_COLLAPSE_DURATION_MS, useToolCapsuleMotion } from '../motion/capsuleMotion';
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./FlowChatToolCard.module.css";

export type FlowChatToolStatus =
  | "pending"
  | "queued"
  | "waiting"
  | "preparing"
  | "streaming"
  | "receiving"
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "rejected"
  | "analyzing"
  | "pending_confirmation"
  | "confirmed";

export type ToolCardAffordanceKind = "expand" | "open-panel-right";

const LOADING_STATUSES = new Set<FlowChatToolStatus>([
  "queued",
  "waiting",
  "preparing",
  "streaming",
  "receiving",
  "running",
  "analyzing",
]);

const TOOL_CARD_COLLAPSE_DURATION_MS = 300;

interface ToolCardRowLayoutContextValue {
  affordanceKind: ToolCardAffordanceKind;
  attention: "ambient" | "prominent";
  expandable: boolean;
  isExpanded: boolean;
  onAffordanceClick?: (event: ReactMouseEvent<HTMLElement>) => void;
}

const ToolCardRowLayoutContext = createContext<ToolCardRowLayoutContextValue>({
  affordanceKind: "expand",
  attention: "ambient",
  expandable: false,
  isExpanded: false,
});

function getAppearanceState({
  isExpanded,
  isFailed,
  isLoading,
  requiresConfirmation,
}: {
  isExpanded: boolean;
  isFailed: boolean;
  isLoading: boolean;
  requiresConfirmation: boolean;
}): string | undefined {
  const states = [
    isExpanded && "expanded",
    isFailed && "failed",
    isLoading && "loading",
    requiresConfirmation && "confirmation",
  ].filter(Boolean);

  return states.length > 0 ? states.join(" ") : undefined;
}

function shouldIgnoreToggleClick(
  event: ReactMouseEvent<HTMLElement>,
  root: HTMLElement,
): boolean {
  if (event.defaultPrevented || event.button !== 0) {
    return true;
  }

  const target = event.target as { closest?: (selectors: string) => Element | null } | null;
  if (
    typeof target?.closest === "function" &&
    target.closest("button,a,input,textarea,select,[contenteditable='true'],[data-flow-card-ignore-toggle]")
  ) {
    return true;
  }

  const selection = root.ownerDocument.defaultView?.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return false;
  }

  const anchorInside = selection.anchorNode ? root.contains(selection.anchorNode) : false;
  const focusInside = selection.focusNode ? root.contains(selection.focusNode) : false;
  return anchorInside || focusInside;
}

interface CollapsibleRegionProps {
  id?: string;
  children?: ReactNode;
  className?: string;
  disableAnimation?: boolean;
  durationMs?: number;
  isOpen: boolean;
  part: "error" | "expanded";
  preserveClosingInlineSize?: boolean;
  status: FlowChatToolStatus;
}

type CollapsePhase = "closed" | "closing" | "open" | "opening";

function CollapsibleRegion({
  id,
  children,
  className,
  disableAnimation = false,
  durationMs = TOOL_CARD_COLLAPSE_DURATION_MS,
  isOpen,
  part,
  preserveClosingInlineSize = false,
  status,
}: CollapsibleRegionProps) {
  const hasContent = children !== undefined && children !== null && children !== false;
  const open = Boolean(isOpen && hasContent);
  const regionRef = useRef<HTMLDivElement>(null);
  const hasMountedRef = useRef(false);
  const [phase, setPhase] = useState<CollapsePhase>(() => (open ? "open" : "closed"));
  const [visuallyOpen, setVisuallyOpen] = useState(open);

  useEffect(() => {
    const region = regionRef.current;
    if (!preserveClosingInlineSize || !open || !region) return;

    // Exit content keeps its last open width so narrowing the capsule cannot
    // rewrap the result and change its height partway through the same exit.
    const rememberInlineSize = () => {
      const width = region.getBoundingClientRect().width;
      if (width > 0) region.style.setProperty('--_tool-card-expanded-inline-size', `${width}px`);
    };
    rememberInlineSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(rememberInlineSize);
    observer.observe(region);
    return () => observer.disconnect();
  }, [open, preserveClosingInlineSize]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    const shouldAnimate = !disableAnimation && !prefersReducedMotion;

    if (!shouldAnimate) {
      setPhase(open ? "open" : "closed");
      setVisuallyOpen(open);
      return;
    }

    let frameId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setPhase((currentPhase) => currentPhase === "open" ? currentPhase : "opening");
      setVisuallyOpen(false);

      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        frameId = window.requestAnimationFrame(() => setVisuallyOpen(true));
      } else {
        setVisuallyOpen(true);
      }

      timeoutId = setTimeout(() => setPhase("open"), durationMs);
    } else {
      setVisuallyOpen(false);
      setPhase((currentPhase) => currentPhase === "closed" ? currentPhase : "closing");
      timeoutId = setTimeout(() => setPhase("closed"), durationMs);
    }

    return () => {
      if (frameId !== undefined && typeof window !== "undefined") {
        window.cancelAnimationFrame(frameId);
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [disableAnimation, durationMs, open]);

  if (!hasContent) {
    return null;
  }

  const shouldRender = open || phase !== "closed";

  return (
    <div
      ref={regionRef}
      id={id}
      aria-hidden={!open}
      {...{ inert: !open ? '' : undefined }}
      className={styles.collapse}
      data-animate={disableAnimation ? "false" : "true"}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part={`${part}Collapse`}
      data-open={visuallyOpen ? "true" : "false"}
      data-phase={phase}
      style={{
        "--_tool-card-collapse-duration": `${durationMs}ms`,
      } as CSSProperties}
    >
      {shouldRender && (
        <div
          className={styles.collapseInner}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="collapseInner"
        >
          <div
            className={classNames(
              part === "expanded" ? styles.expanded : styles.error,
              className,
            )}
            data-openbitfun-component="flow-chat-tool-card"
            data-openbitfun-part={part}
            data-openbitfun-state={part === "error" ? "failed" : "expanded"}
            data-openbitfun-status={status}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

export interface ProminentToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  allowExpandedWhenFailed?: boolean;
  className?: string;
  collapsibleErrorContent?: boolean;
  disableExpandAnimation?: boolean;
  errorContent?: ReactNode;
  expandedContent?: ReactNode;
  expandedContentLayout?: "inset" | "flush";
  isExpanded?: boolean;
  isFailed?: boolean;
  onToggle?: (event: ReactMouseEvent<HTMLElement>) => void;
  requiresConfirmation?: boolean;
  status: FlowChatToolStatus;
  summary: ReactNode;
  summaryAffordanceKind?: ToolCardAffordanceKind;
  summaryExpandAffordance?: boolean;
  toggleTestId?: string;
}

export function ProminentToolCard({
  allowExpandedWhenFailed = false,
  className,
  collapsibleErrorContent = false,
  disableExpandAnimation = false,
  errorContent,
  expandedContent,
  expandedContentLayout = "inset",
  isExpanded = false,
  isFailed = false,
  onToggle,
  requiresConfirmation = false,
  status,
  summary,
  summaryAffordanceKind = "expand",
  summaryExpandAffordance,
  toggleTestId,
  ...props
}: ProminentToolCardProps) {
  const failed = isFailed || status === "error";
  const hasCollapsibleErrorContent = Boolean(
    collapsibleErrorContent && failed && errorContent,
  );
  const expandable = summaryExpandAffordance
    ?? Boolean(
      onToggle && (
        hasCollapsibleErrorContent
        || (expandedContent && (!failed || allowExpandedWhenFailed))
      ),
    );
  const loading = LOADING_STATUSES.has(status);
  const confirmation = requiresConfirmation && ![
    "completed",
    "confirmed",
    "cancelled",
    "rejected",
    "error",
  ].includes(status);
  const appearanceState = getAppearanceState({
    isExpanded,
    isFailed: failed,
    isLoading: loading,
    requiresConfirmation: confirmation,
  });

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onToggle || shouldIgnoreToggleClick(event, event.currentTarget)) {
      return;
    }
    onToggle(event);
  };

  return (
    <ToolCapsulePresentationProvider>
    <div
      {...props}
      className={classNames(
        styles.prominentRoot,
        className,
      )}
      data-openbitfun-attention="prominent"
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-expandable={expandable ? "true" : "false"}
      data-openbitfun-interactive={onToggle ? "true" : "false"}
      data-openbitfun-part="root"
      data-openbitfun-state={appearanceState}
      data-openbitfun-status={status}
    >
      <div
        className={classNames(
          styles.surface,
          styles.prominentSurface,
        )}
        data-openbitfun-attention="prominent"
        data-openbitfun-component="flow-chat-tool-card"
        data-openbitfun-expandable={expandable ? "true" : "false"}
        data-openbitfun-interactive={onToggle ? "true" : "false"}
        data-openbitfun-part="surface"
        data-overflow-trigger
        data-openbitfun-state={appearanceState}
        data-openbitfun-status={status}
        data-testid={onToggle ? toggleTestId : undefined}
        onClick={handleSurfaceClick}
      >
        <ToolCardRowLayoutContext.Provider
          value={{
            affordanceKind: summaryAffordanceKind,
            attention: "prominent",
            expandable,
            isExpanded,
            onAffordanceClick: onToggle,
          }}
        >
          {summary}
        </ToolCardRowLayoutContext.Provider>
      </div>

      <CollapsibleRegion
        className={expandedContentLayout === "flush" ? styles.expandedFlush : undefined}
        disableAnimation={disableExpandAnimation}
        isOpen={Boolean(isExpanded && expandedContent && (!failed || allowExpandedWhenFailed))}
        part="expanded"
        status={status}
      >
        {expandedContent}
      </CollapsibleRegion>

      <CollapsibleRegion
        isOpen={Boolean(
          failed
          && errorContent
          && (!collapsibleErrorContent || isExpanded)
        )}
        part="error"
        status={status}
      >
        {errorContent}
      </CollapsibleRegion>
    </div>
    </ToolCapsulePresentationProvider>
  );
}

export interface AmbientToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  className?: string;
  expandedContent?: ReactNode;
  expandedContentLayout?: "inset" | "flush";
  header: ReactNode;
  isExpanded?: boolean;
  requiresConfirmation?: boolean;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  status: FlowChatToolStatus;
  toggleTestId?: string;
}

export function AmbientToolCard({
  className,
  expandedContent: nativeExpandedContent,
  expandedContentLayout = "inset",
  header,
  isExpanded: nativeExpanded = false,
  requiresConfirmation = false,
  onClick: nativeOnClick,
  onKeyDown: onRootKeyDown,
  role,
  status,
  tabIndex,
  toggleTestId,
  ...props
}: AmbientToolCardProps) {
  const capsule = useToolCapsulePresentation();
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // Keep open-file/image actions, and keep every existing specialized result body.
  const expandedContent = nativeExpandedContent || (!nativeOnClick || capsule?.expanded ? capsule?.fallbackContent : undefined);
  const isExpanded = capsule ? capsule.expanded : nativeExpanded;
  const onClick = capsule && expandedContent
    ? () => capsule.onExpandedChange(!isExpanded)
    : nativeOnClick;
  const hasExpandedContent = Boolean(expandedContent);
  const loading = LOADING_STATUSES.has(status);
  const expandedShell = Boolean(isExpanded && hasExpandedContent);
  useToolCapsuleMotion(rootRef, Boolean(capsule), expandedShell, status);
  const interactive = Boolean(onClick);
  const directAction = !capsule && interactive && !hasExpandedContent;
  const confirmation = status === "pending_confirmation" || (requiresConfirmation
    && !["completed", "confirmed", "error", "cancelled", "rejected"].includes(status));
  const appearanceState = getAppearanceState({
    isExpanded,
    isFailed: status === "error",
    isLoading: loading,
    requiresConfirmation: confirmation,
  });
  const expandable = interactive && hasExpandedContent;

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onClick || (!capsule && shouldIgnoreToggleClick(event, event.currentTarget))) {
      return;
    }
    onClick(event);
  };
  const Surface = capsule && interactive ? 'button' : 'div';

  const handleDirectActionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onRootKeyDown?.(event);
    if (!directAction || event.defaultPrevented || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    const surface = event.currentTarget.querySelector<HTMLElement>(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]',
    );
    surface?.click();
  };

  return (
    <div
      {...props}
      ref={rootRef}
      className={classNames(
        styles.ambientRoot,
        expandedShell && styles.ambientExpandedShell,
        className,
      )}
      data-openbitfun-attention="ambient"
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-direct-action={directAction ? "true" : "false"}
      data-openbitfun-expandable={expandable ? "true" : "false"}
      data-openbitfun-interactive={interactive ? "true" : "false"}
      data-openbitfun-part="root"
      data-openbitfun-state={appearanceState}
      data-openbitfun-status={status}
      data-openbitfun-expanded-shell={expandedShell ? "true" : "false"}
      data-tool-capsule={capsule ? 'true' : undefined}
      onKeyDown={directAction || onRootKeyDown ? handleDirectActionKeyDown : undefined}
      role={directAction ? "button" : role}
      tabIndex={directAction ? 0 : tabIndex}
    >
      <Surface
        type={capsule && interactive ? 'button' : undefined}
        aria-label={capsule?.description}
        aria-expanded={capsule && expandable ? isExpanded : undefined}
        aria-controls={capsule && expandable ? contentId : undefined}
        title={capsule?.description}
        className={classNames(
          styles.surface,
          styles.ambientSurface,
        )}
        data-openbitfun-attention="ambient"
        data-openbitfun-component="flow-chat-tool-card"
        data-openbitfun-expandable={expandable ? "true" : "false"}
        data-openbitfun-interactive={interactive ? "true" : "false"}
        data-openbitfun-part="surface"
        data-overflow-trigger
        data-openbitfun-state={appearanceState}
        data-openbitfun-status={status}
        data-testid={interactive ? toggleTestId : undefined}
        onClick={handleSurfaceClick}
      >
        {capsule && <span aria-hidden="true" data-capsule-skin className={styles.capsuleSkin} />}
        <ToolCardRowLayoutContext.Provider
          value={{
            affordanceKind: "expand",
            attention: "ambient",
            expandable,
            isExpanded,
            onAffordanceClick: onClick,
          }}
        >
          {header}
        </ToolCardRowLayoutContext.Provider>
      </Surface>

      <ToolCapsulePresentationProvider>
      <CollapsibleRegion
        className={classNames(
          styles.ambientExpanded,
          expandedContentLayout === "flush" && styles.expandedFlush,
        )}
        id={capsule ? contentId : undefined}
        preserveClosingInlineSize={Boolean(capsule)}
        durationMs={capsule && !isExpanded ? TOOL_CAPSULE_COLLAPSE_DURATION_MS : undefined}
        isOpen={Boolean(isExpanded && expandedContent)}
        part="expanded"
        status={status}
      >
        {expandedContent}
      </CollapsibleRegion>
      </ToolCapsulePresentationProvider>
    </div>
  );
}

export interface ToolCardIconSlotProps {
  affordanceKind?: ToolCardAffordanceKind;
  className?: string;
  description?: string;
  expandable?: boolean;
  icon: ReactNode;
  isExpanded?: boolean;
  onAffordanceClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  showDivider?: boolean;
}

export function ToolCardIconSlot({
  affordanceKind,
  className,
  description,
  expandable,
  icon,
  isExpanded,
  onAffordanceClick,
  showDivider = false,
}: ToolCardIconSlotProps) {
  const { messages } = useDesignSystem();
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const layout = useContext(ToolCardRowLayoutContext);
  const resolvedExpandable = expandable ?? layout.expandable;
  const resolvedKind = affordanceKind ?? layout.affordanceKind;
  const resolvedExpanded = isExpanded ?? layout.isExpanded;
  const handleAffordance = onAffordanceClick ?? layout.onAffordanceClick;
  const showInlineAffordance = layout.attention === "ambient" && resolvedExpandable;
  const isPanelAffordance = resolvedKind === "open-panel-right";

  return (
    <>
      <span
        ref={descriptionRef}
        aria-label={!showInlineAffordance ? description : undefined}
        role={description && !showInlineAffordance ? "img" : undefined}
        tabIndex={description && !showInlineAffordance ? 0 : undefined}
        className={classNames(
          styles.iconSlot,
          className,
        )}
        data-openbitfun-affordance={resolvedKind}
        data-openbitfun-component="flow-chat-tool-card"
        data-openbitfun-expandable={showInlineAffordance ? "true" : "false"}
        data-openbitfun-part="icon"
        data-divider={showDivider ? "true" : "false"}
      >
        <span
          className={styles.iconMarks}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="iconMarks"
        >
          <span
            className={styles.mainIcon}
            data-openbitfun-icon-slot="true"
            data-openbitfun-component="flow-chat-tool-card"
            data-openbitfun-part="iconGraphic"
          >
            {icon}
          </span>
          {showInlineAffordance && (
            <span
              aria-hidden="true"
              className={styles.inlineAffordance}
              data-openbitfun-icon-slot="true"
              data-openbitfun-affordance={resolvedKind}
              data-openbitfun-component="flow-chat-tool-card"
              data-openbitfun-part="iconAffordance"
              data-expanded={resolvedExpanded ? "true" : "false"}
            >
              {isPanelAffordance
                ? <Icon name="arrow-up-right" size="sm" />
                : <Icon name="chevron-down" size="sm" />}
            </span>
          )}
        </span>
        {showInlineAffordance && handleAffordance && (
          <button
            aria-expanded={isPanelAffordance ? undefined : resolvedExpanded}
            aria-label={[description, isPanelAffordance ? messages.toolCardOpenDetails : resolvedExpanded ? messages.toolCardCollapseDetails : messages.toolCardExpandDetails].filter(Boolean).join(". ")}
            className={styles.iconAffordanceHit}
            data-openbitfun-affordance={resolvedKind}
            data-openbitfun-component="flow-chat-tool-card"
            data-openbitfun-part="iconAffordanceButton"
            onClick={(event) => {
              event.stopPropagation();
              handleAffordance(event);
            }}
            type="button"
          />
        )}
      </span>
      {description && <Tooltip content={description} triggerRef={descriptionRef} trigger="hover-focus" />}
    </>
  );
}

export interface ToolCardStatusIconProps {
  className?: string;
  icon: ReactNode;
  withDivider?: boolean;
}

export function ToolCardStatusIcon({
  className,
  icon,
  withDivider = false,
}: ToolCardStatusIconProps) {
  return (
    <span
      className={classNames(styles.statusIcon, className)}
      data-openbitfun-icon-slot="true"
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="status"
      data-divider={withDivider ? "true" : "false"}
    >
      {icon}
    </span>
  );
}

export interface ToolCardActionsProps {
  children: ReactNode;
  className?: string;
  /** Reserve the controls' width and reveal on the owning region's hover/focus. */
  revealOnHover?: boolean;
}

export function ToolCardActions({ children, className, revealOnHover = false }: ToolCardActionsProps) {
  return (
    <span
      className={classNames(styles.toolCardActions, className)}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="actions"
      data-reveal={revealOnHover ? "hover" : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  );
}

export interface ToolCardSubjectProps extends HTMLAttributes<HTMLSpanElement> {
  actions?: ReactNode;
}

/** An object and its auxiliary controls form one reading and interaction unit. */
export function ToolCardSubject({ children, actions, className, ...props }: ToolCardSubjectProps) {
  return (
    <span {...props} className={classNames(styles.subject, className)} data-tool-card-action-scope data-overflow-trigger>
      {children !== undefined && children !== null && children !== false && children !== "" && (
        <span className={styles.subjectText}>
          {typeof children === "string" || typeof children === "number" ? <OverflowText>{children}</OverflowText> : children}
        </span>
      )}
      {actions && <span className={styles.actionRegion} data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="actionRegion">
        <ToolCardActions revealOnHover>{actions}</ToolCardActions>
      </span>}
    </span>
  );
}


export interface ToolCardChangeSummaryProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  additions?: number | string;
  deletions?: number | string;
}

export function ToolCardChangeSummary({
  additions,
  className,
  deletions,
  ...props
}: ToolCardChangeSummaryProps) {
  const hasAdditions = additions !== undefined && additions !== null && additions !== "";
  const hasDeletions = deletions !== undefined && deletions !== null && deletions !== "";

  if (!hasAdditions && !hasDeletions) {
    return null;
  }

  return (
    <span
      {...props}
      className={classNames(styles.changeSummary, className)}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="changeSummary"
    >
      {hasAdditions && (
        <span data-openbitfun-change="added">+{additions}</span>
      )}
      {hasDeletions && (
        <span data-openbitfun-change="removed">-{deletions}</span>
      )}
    </span>
  );
}

export interface ProminentToolCardSummaryProps {
  action?: ReactNode;
  actionDataAttributes?: Record<`data-${string}`, boolean | number | string | undefined>;
  actionTestId?: string;
  actions?: ReactNode;
  affordanceKind?: ToolCardAffordanceKind;
  /** Visible primary decisions in the prominent card's right-hand control region. */
  primaryActions?: ReactNode;
  content?: ReactNode;
  /** Auxiliary subject controls share the prominent card's trailing region. */
  contentActions?: ReactNode;
  expandAffordance?: boolean;
  extra?: ReactNode;
  summaryExpanded?: boolean;
  icon?: ReactNode;
  onAffordanceClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  statusIcon?: ReactNode;
  trailingActions?: ReactNode;
}

export function ProminentToolCardSummary({
  action,
  actionDataAttributes,
  actionTestId,
  actions,
  affordanceKind,
  content,
  contentActions,
  expandAffordance,
  extra,
  summaryExpanded,
  icon,
  onAffordanceClick,
  primaryActions,
  statusIcon,
  trailingActions,
}: ProminentToolCardSummaryProps) {
  const { messages } = useDesignSystem();
  const layout = useContext(ToolCardRowLayoutContext);
  const expandable = expandAffordance ?? layout.expandable;
  const resolvedKind = affordanceKind ?? layout.affordanceKind;
  const expanded = summaryExpanded ?? layout.isExpanded;
  const handleAffordance = onAffordanceClick ?? layout.onAffordanceClick;
  const affordanceAction = expandable ? handleAffordance : undefined;
  const affordanceButtonRef = useRef<HTMLButtonElement>(null);
  const isExpandAction = resolvedKind === "expand" && Boolean(affordanceAction);
  const hasPanelAction = resolvedKind === "open-panel-right" && Boolean(affordanceAction);
  const hasContent = content !== undefined && content !== null && content !== false && content !== "";
  const hasAuxiliaryActions = Boolean(actions || contentActions || hasPanelAction || trailingActions);
  const hasActionRegion = Boolean(primaryActions || hasAuxiliaryActions);
  const affordanceLabel = hasPanelAction ? messages.toolCardOpenDetails
    : expanded ? messages.toolCardCollapseDetails : messages.toolCardExpandDetails;
  const affordanceButton = affordanceAction && hasPanelAction ? (
    <IconButton aria-label={affordanceLabel} title={affordanceLabel} size="sm" variant="quiet"
      data-openbitfun-affordance={resolvedKind} data-openbitfun-part="affordanceButton"
      icon={<Icon name="arrow-up-right" size="sm" />} ref={affordanceButtonRef}
      onClick={event => { event.stopPropagation(); affordanceAction(event); }} />
  ) : affordanceAction ? (
    <button
      aria-expanded={resolvedKind === "expand" ? expanded : undefined}
      aria-label={affordanceLabel}
      className={isExpandAction ? styles.summaryToggleButton : styles.affordanceButton}
      data-openbitfun-icon-slot="true"
      data-openbitfun-affordance={resolvedKind}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="affordanceButton"
      onClick={(event) => {
        event.stopPropagation();
        affordanceAction(event);
      }}
      ref={affordanceButtonRef}
      type="button"
    >
      {resolvedKind === "open-panel-right" && <Icon name="arrow-up-right" size="sm" />}
    </button>
  ) : null;
  const subjectText = typeof content === "string" || typeof content === "number"
    ? <OverflowText>{content}</OverflowText>
    : content;

  return (
    <div
      className={classNames(styles.summaryRow, styles.prominentSummary)}
      data-openbitfun-affordance={resolvedKind}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-expandable={expandable ? "true" : "false"}
      data-openbitfun-part="summary"
      onClick={isExpandAction ? (event) => {
        if (shouldIgnoreToggleClick(event, event.currentTarget)) {
          return;
        }
        event.stopPropagation();
        affordanceButtonRef.current?.click();
      } : undefined}
    >
      {isExpandAction && affordanceButton}
      {icon !== undefined && icon !== null && icon !== false && icon !== "" && (
        <ToolCardIconSlot icon={icon} />
      )}
      {action !== undefined && action !== null && action !== false && action !== "" && (
        <span
          {...actionDataAttributes}
          className={styles.actionLabel}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="action"
          data-testid={actionTestId}
        >
          {typeof action === "string" || typeof action === "number"
            ? <OverflowText>{action}</OverflowText>
            : action}
        </span>
      )}
      {hasContent && (
        <span
          className={styles.content}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="content"
        >
          {subjectText}
        </span>
      )}
      {extra !== undefined && extra !== null && extra !== false && (
        <span
          className={styles.extra}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="extra"
        >
          {extra}
        </span>
      )}
      {statusIcon !== undefined && statusIcon !== null && statusIcon !== false && (
        <ToolCardStatusIcon icon={statusIcon} withDivider={Boolean(extra)} />
      )}
      {hasActionRegion && (
        <span className={styles.actionRegion} data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="actionRegion">
          {primaryActions && <ToolCardActions>{primaryActions}</ToolCardActions>}
          {hasAuxiliaryActions && <ToolCardActions revealOnHover>
            {actions}
            {contentActions}
            {hasPanelAction && affordanceButton}
            {trailingActions && <span className={styles.trailingActions} data-openbitfun-component="flow-chat-tool-card"
              data-openbitfun-part="trailingActions" data-divider="false">{trailingActions}</span>}
          </ToolCardActions>}
        </span>
      )}
    </div>
  );
}


export interface AmbientToolCardHeaderProps {
  action?: ReactNode;
  affordanceKind?: ToolCardAffordanceKind;
  content?: ReactNode;
  /** Auxiliary controls for the subject, separate from status and primary actions. */
  contentActions?: ReactNode;
  /** Operation targets are plain by default. Prefer result for returned evidence. */
  contentVariant?: "tinted" | "plain";
  /** A concise, recorded result; never a generic success or progress label. */
  result?: ReactNode;
  /** Quiet status detail attached to the leading icon, including keyboard access. */
  statusDescription?: string;
  expandable?: boolean;
  extra?: ReactNode;
  icon?: ReactNode;
  isExpanded?: boolean;
  onAffordanceClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  rightStatusIcon?: ReactNode;
  rightStatusIconWithDivider?: boolean;
  showDivider?: boolean;
}

export function AmbientToolCardHeader({
  action,
  affordanceKind = "expand",
  content,
  contentActions,
  contentVariant = "plain",
  result,
  statusDescription,
  expandable,
  extra,
  icon,
  isExpanded,
  onAffordanceClick,
  rightStatusIcon,
  rightStatusIconWithDivider = false,
  showDivider = false,
}: AmbientToolCardHeaderProps) {
  const layout = useContext(ToolCardRowLayoutContext);
  const capsule = useToolCapsulePresentation();
  const { locale } = useDesignSystem();
  const hasContent = content !== undefined && content !== null && content !== false && content !== "";
  const hasResult = result !== undefined && result !== null && result !== false && result !== "";
  const hasAction = action !== undefined && action !== null && action !== false && action !== "";
  // Accept existing localized labels during migration without doubling punctuation.
  const actionLabel = typeof action === "string" ? action.replace(/[:：]\s*$/u, "") : action;
  const separator = locale.toLowerCase().startsWith("zh") ? "：" : ": ";

  if (capsule) {
    return <>
      {icon && <ToolCardIconSlot icon={icon} expandable={false} />}
      <span className={styles.ambientContent} data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="content">
        <OverflowText>{capsule.label}</OverflowText>
      </span>
      {extra !== undefined && extra !== null && extra !== false && (
        <span className={styles.capsuleExtra} data-openbitfun-part="extra">{extra}</span>
      )}
      {capsule.countLabel !== undefined && <span className={styles.capsuleStatus} aria-hidden="true">{capsule.countLabel}</span>}
      {capsule.status !== 'completed' && capsule.status !== 'confirmed' && (
        <span className={styles.capsuleStatus} aria-hidden="true">
          {LOADING_STATUSES.has(capsule.status) && capsule.status !== 'waiting' && capsule.status !== 'queued'
            ? <ToolProcessingDots size={14} /> : capsule.statusLabel}
        </span>
      )}
      {layout.expandable && <Icon name="chevron-down" size="xs" className={styles.capsuleChevron} />}
    </>;
  }

  return (
    <>
      {icon !== undefined && icon !== null && icon !== false && icon !== "" && (
        <ToolCardIconSlot
          description={statusDescription}
          affordanceKind={affordanceKind}
          expandable={expandable ?? layout.expandable}
          icon={icon}
          isExpanded={isExpanded ?? layout.isExpanded}
          onAffordanceClick={onAffordanceClick}
          showDivider={showDivider}
        />
      )}
      {hasAction && (
        <span
          className={styles.ambientAction}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="action"
        >
          {typeof actionLabel === "string" || typeof actionLabel === "number"
            ? <OverflowText>{actionLabel}{(hasContent || hasResult) && separator}</OverflowText>
            : <>{actionLabel}{(hasContent || hasResult) && separator}</>}
        </span>
      )}
      {(hasContent || hasResult || contentActions) && (
        <span
          className={styles.ambientContent}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="content"
        >
          {(hasContent || contentActions) && <ToolCardSubject actions={contentActions}>
            {hasContent && <span className={styles.ambientSubject} data-variant={contentVariant}>
              {typeof content === "string" || typeof content === "number"
                ? <OverflowText>{content}</OverflowText>
                : content}
            </span>}
          </ToolCardSubject>}
          {hasResult && <span className={styles.ambientResult} data-openbitfun-part="resultSummary">
            {typeof result === "string" || typeof result === "number" ? <OverflowText>{result}</OverflowText> : result}
          </span>}
        </span>
      )}
      {extra !== undefined && extra !== null && extra !== false && (
        <span
          className={styles.ambientExtra}
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="extra"
        >
          {extra}
        </span>
      )}
      {rightStatusIcon !== undefined && rightStatusIcon !== null && rightStatusIcon !== false && (
        <ToolCardStatusIcon
          icon={rightStatusIcon}
          withDivider={rightStatusIconWithDivider}
        />
      )}
    </>
  );
}
