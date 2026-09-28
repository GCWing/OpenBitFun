import { OverflowText } from '../../primitives/OverflowText';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ExternalLink,
  Square,
} from "lucide-react";
import { Icon } from "../../components/Icon/Icon";
import { IconButton } from "../../components/IconButton/IconButton";
import { classNames } from "../../internal/classNames";
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardActions,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardCopyButton } from "./ToolCardCopyButton";
import { ToolCardSection } from "./ToolCardDetails";
import { ToolProcessingDots } from "./ToolProcessingDots";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";
import type { ToolCardInteraction } from './ToolCardInteraction';
import { ToolRelationRow } from './ToolRelationRow';
import styles from "./CommandToolCard.module.css";

export interface CommandToolCardAction {
  disabled?: boolean;
  label: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

export interface CommandToolCardCopyAction extends CommandToolCardAction {
  copied?: boolean;
  copiedLabel?: string;
}

export interface CommandToolCardFooterItem {
  grow?: boolean;
  label?: ReactNode;
  pushToEnd?: boolean;
  tone?: "danger" | "neutral" | "success" | "warning";
  value: ReactNode;
}

export interface CommandToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  action: ReactNode;
  attention?: "ambient" | "prominent";
  command?: string | null;
  commandTestId?: string;
  copyAction?: CommandToolCardCopyAction;
  emptyCommand: ReactNode;
  error?: ReactNode;
  footerItems?: readonly CommandToolCardFooterItem[];
  interruptAction?: CommandToolCardAction;
  interaction?: ToolCardInteraction;
  isExpanded: boolean;
  onToggle?: () => void;
  openAction?: CommandToolCardAction;
  output?: ReactNode;
  outputAction?: ReactNode;
  outputLabel?: ReactNode;
  outputDensity?: "compact" | "expanded";
  outputSizing?: "content" | "fixed";
  reserveFooter?: boolean;
  reserveOutput?: boolean;
  requiresConfirmation?: boolean;
  status: FlowChatToolStatus;
  statusLabel?: ReactNode;
  statusSummary?: ReactNode;
  statusTone?: "danger" | "neutral" | "success" | "warning";
  toggleTestId?: string;
  waitingContent?: ReactNode;
}

const ACTIVE_STATUSES = new Set<FlowChatToolStatus>([
  "preparing",
  "receiving",
  "running",
  "streaming",
]);

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const COMMAND_PREVIEW_LINES = 3;

function CommandPreview({ children, empty, testId }: {
  children: ReactNode;
  empty: boolean;
  testId?: string;
}) {
  const commandRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const command = commandRef.current;
    const text = textRef.current;
    const view = command?.ownerDocument.defaultView;
    if (!command || !text || !view) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(view.getComputedStyle(command).lineHeight);
      setOverflowing(text.clientWidth > 0 && text.scrollHeight > lineHeight * COMMAND_PREVIEW_LINES + 1);
    };
    measure();
    // Observe the full text so wrapping and font changes remain detectable
    // while the visible command is clamped to three lines.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(text);
    if (!observer) view.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      if (!observer) view.removeEventListener("resize", measure);
    };
  }, [children]);

  return (
    <div
      className={styles.commandPreview}
      data-openbitfun-part="commandPreview"
      data-overflow={overflowing ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      role={overflowing ? "button" : undefined}
      tabIndex={overflowing ? 0 : undefined}
      aria-expanded={overflowing ? expanded : undefined}
      onClick={overflowing ? (event) => {
        event.stopPropagation();
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed && (
          event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode)
        )) return;
        setExpanded(value => !value);
      } : undefined}
      onKeyDown={overflowing ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) setExpanded(value => !value);
      } : undefined}
    >
      <code
        ref={commandRef}
        className={classNames(styles.command, styles.expandedCommand)}
        data-openbitfun-part="command"
        data-empty={empty ? "true" : "false"}
        data-testid={testId}
      >
        <span ref={textRef} className={styles.commandText}>{children}</span>
      </code>
    </div>
  );
}

export function CommandToolCard({
  action,
  attention = "prominent",
  className,
  command,
  commandTestId,
  copyAction,
  emptyCommand,
  error,
  footerItems = [],
  interruptAction,
  interaction,
  isExpanded,
  onToggle,
  openAction,
  output,
  outputAction,
  outputLabel,
  outputDensity = "expanded",
  outputSizing = "fixed",
  reserveFooter = false,
  reserveOutput = false,
  requiresConfirmation = false,
  status,
  statusLabel,
  statusSummary,
  statusTone = "neutral",
  toggleTestId,
  waitingContent,
  ...props
}: CommandToolCardProps) {
  const loading = ACTIVE_STATUSES.has(status);
  const failed = status === "error";
  const resolvedCommand = command?.trim() ? command : null;
  const hasCommand = Boolean(resolvedCommand || emptyCommand);
  const hasOutputFrame = Boolean(output || waitingContent || reserveOutput);
  const hasFooter = reserveFooter || footerItems.length > 0;
  const hasDetails = hasCommand || hasOutputFrame || hasFooter || Boolean(error);
  const expanded = isExpanded && hasDetails;
  const ambient = attention === "ambient";

  const renderAction = (
    kind: "copy" | "interrupt" | "open",
    item: CommandToolCardAction | CommandToolCardCopyAction | undefined,
  ) => {
    if (!item) return null;
    const copied = kind === "copy" && "copied" in item && item.copied;
    const label = copied && "copiedLabel" in item && item.copiedLabel
      ? item.copiedLabel
      : item.label;
    if (kind === "copy") {
      const copyItem = item as CommandToolCardCopyAction;
      return (
        <ToolCardCopyButton
          className={styles.copyAction}
          copied={copied}
          copiedLabel={copyItem.copiedLabel}
          disabled={copyItem.disabled}
          label={copyItem.label}
          onPress={copyItem.onPress}
          testId={copyItem.testId}
        />
      );
    }

    const icon = kind === "open"
      ? <Icon glyph={ExternalLink} size="sm" />
      : <Icon glyph={Square} size="sm" />;

    return (
      <IconButton
        aria-label={label}
        className={kind === "interrupt" ? styles.criticalAction : undefined}
        disabled={item.disabled}
        icon={icon}
        onClick={item.onPress}
        size="sm"
        data-testid={item.testId}
        title={label}
        tone={kind === "interrupt" ? "danger" : "neutral"}
        variant="quiet"
      />
    );
  };

  const details = hasDetails ? (
    <div className={styles.details} data-openbitfun-part="details">
      {(hasCommand || hasOutputFrame) && (
        <div className={styles.contentSection}>
          {hasCommand && (
            <div className={styles.commandRow} data-openbitfun-part="commandRow" data-tool-card-action-scope>
              <CommandPreview empty={!resolvedCommand} testId={expanded ? commandTestId : undefined}>
                {resolvedCommand ?? emptyCommand}
              </CommandPreview>
              {copyAction && (
                <ToolCardActions className={styles.commandActions} revealOnHover>
                  {renderAction("copy", copyAction)}
                </ToolCardActions>
              )}
            </div>
          )}
          {hasOutputFrame && (
            <ToolCardSection label={outputLabel} actions={outputAction}>
              <div
                className={styles.outputFrame}
                data-openbitfun-part="outputFrame"
                data-density={outputDensity}
                data-sizing={outputSizing}
              >
                {output
                  ? <div className={styles.output} data-openbitfun-part="output">{output}</div>
                  : <div className={styles.waiting} data-openbitfun-part="waiting">{waitingContent}</div>}
              </div>
            </ToolCardSection>
          )}
        </div>
      )}
      {hasFooter && (
        <div className={styles.footer} data-openbitfun-part="footer">
          <div className={styles.footerRow}>
            {footerItems.map((item, index) => (
              <span
                className={styles.footerItem}
                data-grow={item.grow ? "true" : "false"}
                data-push-to-end={item.pushToEnd ? "true" : "false"}
                data-tone={item.tone ?? "neutral"}
                key={index}
              >
                {item.label !== undefined && item.label !== null && (
                  <span className={styles.footerLabel}>{item.label}</span>
                )}
                <OverflowText className={styles.footerValue}>{item.value}</OverflowText>
              </span>
            ))}
          </div>
        </div>
      )}
      {ambient && error && <div className={styles.error}>{error}</div>}
    </div>
  ) : undefined;

  const actions = openAction ? (
    <ToolCardActions>
      {renderAction("open", openAction)}
    </ToolCardActions>
  ) : undefined;
  const commandContent = (
    <code
      className={styles.command}
      data-openbitfun-part="command"
      data-empty={resolvedCommand ? "false" : "true"}
      data-testid={commandTestId}
    ><OverflowText overflowStyle="ellipsis">
      {resolvedCommand ?? emptyCommand}
    </OverflowText></code>
  );
  const statusContent = (statusSummary || statusLabel) ? (
    <span className={styles.statusSummary} data-openbitfun-part="statusSummary">
      {statusSummary}
      {statusLabel && (
        <span className={styles.statusLabel} data-openbitfun-part="statusLabel" data-tone={statusTone}>
          {statusTone === "success" && <Icon className={styles.resultIcon} glyph={Check} size="sm" />}
          {statusLabel}
        </span>
      )}
    </span>
  ) : undefined;
  const errorContent = error ? <div className={styles.error}>{error}</div> : undefined;

  if (interaction) return <ToolRelationRow {...props} className={className} interaction={interaction}
    status={status} result={statusLabel ?? statusSummary ?? action} details={details} detailsTitle={action} />;

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="command-tool-card"
      data-openbitfun-part="root"
      data-openbitfun-status={status}
    >
      {ambient ? (
        <>
          <AmbientToolCard
            className={expanded ? styles.expandedCard : undefined}
            expandedContent={details}
            expandedContentLayout="flush"
            header={(
              <AmbientToolCardHeader
                action={action}
                content={expanded ? undefined : commandContent}
                statusDescription={typeof error === 'string' ? error : typeof statusLabel === 'string' ? statusLabel : undefined}
                contentActions={actions}
                extra={renderAction("interrupt", interruptAction)}
                icon={<ToolCardStatusSlot status={status} toolIcon={<Icon name="square-terminal" size="sm" />} />}
              />
            )}
            isExpanded={isExpanded}
            requiresConfirmation={requiresConfirmation}
            onClick={hasDetails && onToggle ? () => onToggle() : undefined}
            status={status}
            toggleTestId={toggleTestId}
          />
        </>
      ) : <ProminentToolCard
        allowExpandedWhenFailed
        className={expanded ? styles.expandedCard : undefined}
        errorContent={errorContent}
        expandedContent={details}
        expandedContentLayout="flush"
        summary={(
          <ProminentToolCardSummary
            action={action}
            actions={actions}
            content={expanded ? undefined : commandContent}
            extra={statusContent}
            primaryActions={renderAction("interrupt", interruptAction)}
            icon={<Icon name="square-terminal" size="sm" />}
            statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
          />
        )}
        summaryExpandAffordance={hasDetails}
        isExpanded={isExpanded}
        isFailed={failed}
        onToggle={hasDetails && onToggle ? () => onToggle() : undefined}
        requiresConfirmation={requiresConfirmation}
        status={status}
        toggleTestId={toggleTestId}
      />}
    </div>
  );
}
