import { Button, Icon } from '@openbitfun/ui';
import { AlertTriangle } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { AmbientToolCard, AmbientToolCardHeader } from '@openbitfun/ui/flow-chat';
import type { FlowToolItem } from '../types/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import {
  buildReactCrashLogPayload,
  safeReactErrorInfo,
} from '@/shared/utils/reactProductionError';

const log = createLogger('FlowToolCardErrorBoundary');
const DETAIL_PREVIEW_LIMIT = 4000;

interface Props {
  children: ReactNode;
  toolItem: FlowToolItem;
  displayName: string;
  sessionId?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: unknown;
}

function truncateDetail(text: string, maxLength: number = DETAIL_PREVIEW_LIMIT): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

function safeSerialize(value: unknown): string {
  try {
    return truncateDetail(JSON.stringify(value, null, 2));
  } catch (error) {
    return `Failed to serialize payload: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function getFirstLine(error?: Error): string {
  const message = error?.message?.trim();
  if (!message) {
    return 'Tool card render failed.';
  }

  return message.split('\n')[0] || 'Tool card render failed.';
}

function RenderFallback({
  displayName,
  error,
  errorInfo,
  onRetry,
  toolItem,
}: {
  displayName: string;
  error?: Error;
  errorInfo?: unknown;
  onRetry: () => void;
  toolItem: FlowToolItem;
}) {
  const componentStack = safeReactErrorInfo(errorInfo).componentStack;
  const toolId = toolItem.id ?? toolItem.toolCall?.id ?? 'unknown-tool-id';

  return (
    <div data-tool-card-id={toolId} role="alert">
      <AmbientToolCard
        status="error"
        isExpanded={true}
        header={(
          <AmbientToolCardHeader
            icon={<Icon glyph={AlertTriangle} size="md" />}
            action={displayName}
            content="Tool card render failed"
          />
        )}
        expandedContent={(
          <div
            style={{
              display: 'grid',
              gap: 12,
            }}
          >
            <div
              style={{
                color: 'var(--openbitfun-color-content-secondary)',
                fontSize: 'var(--openbitfun-type-flow-support-font-size)',
                lineHeight: 'var(--openbitfun-type-flow-support-line-height)',
              }}
            >
              {getFirstLine(error)}
            </div>

            <div>
              <Button
                onClick={onRetry}
                type="button"
                variant="outline"
                size="sm"
                leadingIcon={<Icon name="refresh" size="xs" />}
              >
                Retry render
              </Button>
            </div>

            <details>
              <summary style={{ cursor: 'pointer' }}>Raw tool payload</summary>
              <pre
                style={{
                  marginTop: 8,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--openbitfun-type-body-sm-font-family)',
                  fontSize: 'var(--openbitfun-type-flow-code-font-size)',
                  lineHeight: 'var(--openbitfun-type-flow-code-line-height)',
                  maxHeight: 220,
                  overflow: 'auto',
                }}
              >
                {safeSerialize(toolItem)}
              </pre>
            </details>

            {import.meta.env.DEV && (
              <details>
                <summary style={{ cursor: 'pointer' }}>Technical details</summary>
                <pre
                  style={{
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'var(--openbitfun-type-body-sm-font-family)',
                    fontSize: 'var(--openbitfun-type-flow-code-font-size)',
                    lineHeight: 'var(--openbitfun-type-flow-code-line-height)',
                    maxHeight: 260,
                    overflow: 'auto',
                  }}
                >
                  {truncateDetail(
                    [error?.stack || error?.message, componentStack]
                      .filter(Boolean)
                      .join('\n\n')
                  )}
                </pre>
              </details>
            )}
          </div>
        )}
      />
    </div>
  );
}

export class FlowToolCardErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    this.setState({ error, errorInfo });
    log.error('[CRASH] Flow tool card render failed', {
      sessionId: this.props.sessionId,
      toolId: this.props.toolItem.id,
      toolName: this.props.toolItem.toolName,
      toolStatus: this.props.toolItem.status,
      ...buildReactCrashLogPayload(error, errorInfo),
    });
  }

  componentDidUpdate(prevProps: Props) {
    if (!this.state.hasError) {
      return;
    }

    const shouldReset =
      prevProps.toolItem.id !== this.props.toolItem.id ||
      prevProps.toolItem.status !== this.props.toolItem.status ||
      prevProps.toolItem.toolResult !== this.props.toolItem.toolResult ||
      prevProps.toolItem.partialParams !== this.props.toolItem.partialParams ||
      prevProps.toolItem.userConfirmed !== this.props.toolItem.userConfirmed;

    if (shouldReset) {
      this.setState({
        hasError: false,
        error: undefined,
        errorInfo: undefined,
      });
    }
  }

  private handleRetry = () => {
    this.setState({
      hasError: false,
      error: undefined,
      errorInfo: undefined,
    });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <RenderFallback
        displayName={this.props.displayName}
        error={this.state.error}
        errorInfo={this.state.errorInfo}
        onRetry={this.handleRetry}
        toolItem={this.props.toolItem}
      />
    );
  }
}

export default FlowToolCardErrorBoundary;
