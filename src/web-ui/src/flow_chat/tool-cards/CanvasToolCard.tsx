import React, { useCallback, useMemo, useState } from 'react';
import { OverflowText, Icon } from '@openbitfun/ui';
import { AlertTriangle } from 'lucide-react';
import type { ToolCardProps } from '../types/flow-chat';
import { ProminentToolCard, ProminentToolCardSummary } from '@openbitfun/ui/flow-chat';
import { getToolCardConfig } from './toolCardMetadata';
import { flowChatStore } from '../store/FlowChatStore';
import { CodePreview } from '../components/CodePreview';
import { useTypewriter } from '../hooks/useTypewriter';
import { useReportTypewriterReveal } from '../hooks/typewriterRevealGateContext';
import { i18nService } from '@/infrastructure/i18n';
import { openCanvasArtifactTab } from '@/shared/utils/tabUtils';
import { createLogger } from '@/shared/utils/logger';
import { CanvasPreflight, type CanvasPreflightStatus } from '@/tools/openbitfun-canvas/CanvasPreflight';
import './CanvasToolCard.scss';

const log = createLogger('CanvasToolCard');

interface CanvasToolResult {
  action?: string;
  artifactReference?: string;
  compiled?: boolean;
  renderValidated?: boolean;
  diagnosticCount?: number;
  compiledPayload?: {
    contentHash?: string;
    sourceRevision?: string;
    sdkVersion?: string;
    runtimeVersion?: string;
  } | null;
  canvas?: {
    artifact?: {
      title?: string;
      status?: string;
      sourceRevision?: string;
      latestRenderedRevision?: string;
      lastKnownGoodRevision?: string;
    };
    status?: string;
    diagnostics?: Array<{ message?: string; code?: string; severity?: string }>;
    source?: {
      source?: string;
      filename?: string;
      revision?: string;
    };
  };
}

function parseCanvasResult(raw: unknown): CanvasToolResult | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CanvasToolResult;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') {
    return raw as CanvasToolResult;
  }
  return null;
}

function canvasTitle(result: CanvasToolResult | null, fallback: unknown): string {
  const fromResult = result?.canvas?.artifact?.title;
  if (typeof fromResult === 'string' && fromResult.trim()) {
    return fromResult.trim();
  }
  if (fallback && typeof fallback === 'object') {
    const fromInput = (fallback as Record<string, unknown>).title;
    if (typeof fromInput === 'string' && fromInput.trim()) {
      return fromInput.trim();
    }
  }
  return 'OpenBitFun Canvas';
}

const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled', 'rejected']);

export const CanvasToolCard: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { status, toolCall, toolResult, partialParams, isParamsStreaming } = toolItem;
  const toolDisplayName = getToolCardConfig(toolItem.toolName).displayName;
  const resultData = useMemo(() => parseCanvasResult(toolResult?.result), [toolResult?.result]);
  // Params stream in progressively; fall back to the finalized input afterwards.
  const liveParams = partialParams ?? toolCall?.input;
  const title = useMemo(() => canvasTitle(resultData, liveParams), [resultData, liveParams]);
  const diagnostics = useMemo(
    () => resultData?.canvas?.diagnostics || [],
    [resultData?.canvas?.diagnostics],
  );
  const artifactReference = resultData?.artifactReference;
  const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : null;
  const source = resultData?.canvas?.source?.source;
  const canvasStatus = resultData?.canvas?.status || resultData?.canvas?.artifact?.status;
  const [preflightStatus, setPreflightStatus] = useState<CanvasPreflightStatus>('idle');
  const sourceRevision = resultData?.canvas?.artifact?.sourceRevision;
  const hasRuntimeFailure = canvasStatus === 'runtime_failed' || canvasStatus === 'runtimeFailed';
  const renderValidated = !hasRuntimeFailure && (
    resultData?.renderValidated
      || Boolean(sourceRevision && resultData?.canvas?.artifact?.lastKnownGoodRevision === sourceRevision)
      || preflightStatus === 'ready'
  );
  const isLoading =
    status === 'preparing' || status === 'streaming' || status === 'running' || status === 'pending';
  const isFailed = status === 'error' || toolResult?.success === false;
  const isOpenable = status === 'completed' && Boolean(artifactReference);

  // CreateCanvas/UpdateCanvas stream their `source` argument; render it live like Write does.
  const liveSource = typeof liveParams?.source === 'string' ? liveParams.source : '';
  const isSourceAnimating =
    Boolean(isParamsStreaming) && !TERMINAL_STATUSES.has(status) && liveSource.length > 0;
  const sourceTypewriter = useTypewriter(liveSource, isSourceAnimating);
  useReportTypewriterReveal(
    `${toolCall?.id ?? toolItem.id}:canvas-source`,
    sourceTypewriter.isRevealing,
  );
  const isSourceVisuallyStreaming = isSourceAnimating || sourceTypewriter.isRevealing;
  const showSourcePreview =
    liveSource.length > 0 && !isFailed && (status !== 'completed' || sourceTypewriter.isRevealing);
  const sourceDisplayContent = isSourceVisuallyStreaming ? sourceTypewriter.displayText : liveSource;
  const metaText = liveSource.length > 0
    ? `Source · ${i18nService.formatNumber(liveSource.length)} chars`
    : isOpenable ? 'Canvas artifact' : 'Waiting for Canvas';

  const handleOpenPanel = useCallback(() => {
    if (!isOpenable) return;

    log.info('Opening Canvas panel', {
      artifactReference,
      title,
      canvasStatus,
      compiled: resultData?.compiled,
      diagnosticCount: resultData?.diagnosticCount ?? diagnostics.length,
      hasInlineSource: Boolean(source),
      inlineSourceLength: source?.length ?? 0,
      inlineSourceRevision: resultData?.canvas?.source?.revision,
      inlineCompiledRevision: resultData?.compiledPayload?.sourceRevision,
      inlineCompiledHash: resultData?.compiledPayload?.contentHash,
      workspaceId: session?.workspaceId ?? session?.config.workspaceId,
      workspacePath: session?.workspacePath,
      remoteConnectionId: session?.remoteConnectionId,
      remoteSshHost: session?.remoteSshHost,
    });

    openCanvasArtifactTab({
      artifactReference: artifactReference!,
      title,
      source,
      status: canvasStatus,
      diagnostics,
      workspaceId: session?.workspaceId ?? session?.config.workspaceId,
      workspacePath: session?.workspacePath,
      remoteConnectionId: session?.remoteConnectionId,
      remoteSshHost: session?.remoteSshHost,
      sourceMetadata: {
        type: 'tool-call',
        toolName: toolItem.toolName,
        sessionId,
        toolCallId: toolCall?.id,
        toolItemId: toolItem.id,
      },
      metadata: {
        fromTool: true,
        toolName: toolItem.toolName,
      },
    });
  }, [
    artifactReference,
    canvasStatus,
    diagnostics,
    isOpenable,
    resultData?.canvas?.source?.revision,
    resultData?.compiled,
    resultData?.compiledPayload?.contentHash,
    resultData?.compiledPayload?.sourceRevision,
    resultData?.diagnosticCount,
    session?.remoteConnectionId,
    session?.remoteSshHost,
    session?.workspacePath,
    sessionId,
    source,
    title,
    toolCall?.id,
    toolItem.id,
    toolItem.toolName,
    session?.config.workspaceId,
    session?.workspaceId,
  ]);

  const summary = (
    <ProminentToolCardSummary
      icon={<span className="canvas-tool-card__icon"><Icon name="creative" size="md" /></span>}
      action={toolDisplayName}
      content={<span data-openbitfun-component="canvas-tool-card" data-openbitfun-part="title" className="canvas-tool-card__title">{title}</span>}
      extra={(
        <div data-openbitfun-component="canvas-tool-card" data-openbitfun-part="extra" className="canvas-tool-card__extra">
          {diagnostics.length > 0 && (
            <span data-openbitfun-component="canvas-tool-card" data-openbitfun-part="diagnostics" className="canvas-tool-card__diagnostics">
              <AlertTriangle size={13} />
              {diagnostics.length}
            </span>
          )}
          <span data-openbitfun-component="canvas-tool-card" data-openbitfun-part="status" className="canvas-tool-card__status">
            {isLoading
              ? (isSourceVisuallyStreaming ? 'Writing source' : 'Rendering')
              : renderValidated
                ? 'Preview ready'
                : preflightStatus === 'failed'
                  ? 'Runtime failed'
                  : preflightStatus === 'timeout'
                    ? 'Validation timed out'
                    : resultData?.compiled
                      ? 'Validating preview'
                      : canvasStatus || 'Saved'}
          </span>
        </div>
      )}
      statusIcon={null}
    />
  );

  const body = (
    <div data-openbitfun-component="canvas-tool-card" data-openbitfun-part="body" className="canvas-tool-card__body">
      {showSourcePreview && (
        <div data-openbitfun-component="canvas-tool-card" data-openbitfun-part="sourcePreview" className="canvas-tool-card__source-preview">
          <CodePreview
            content={sourceDisplayContent}
            language="tsx"
            isStreaming={isSourceVisuallyStreaming}
            showLineNumbers={false}
            maxHeight={260}
            autoScrollToBottom={false}
          />
        </div>
      )}
      <div data-openbitfun-component="canvas-tool-card" data-openbitfun-part="meta" className="canvas-tool-card__meta"><OverflowText behavior="marquee">
        <span>{metaText}</span>
      </OverflowText></div>
      {diagnostics.length > 0 && (
        <ul data-openbitfun-component="canvas-tool-card" data-openbitfun-part="diagnosticList" className="canvas-tool-card__diagnostic-list">
          {diagnostics.slice(0, 3).map((diagnostic, index) => (
            <li key={`${diagnostic.code || diagnostic.message || 'diagnostic'}-${index}`}>
              {diagnostic.message || diagnostic.code || 'Canvas diagnostic'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div
      data-openbitfun-component="canvas-tool-card"
      data-openbitfun-part="root"
      data-openbitfun-state={[isOpenable && 'clickable', isFailed && 'failed', isLoading && 'loading'].filter(Boolean).join(' ')}
    >
      {status === 'completed' && resultData?.compiled && !renderValidated && artifactReference ? (
        <CanvasPreflight
          artifactReference={artifactReference}
          title={title}
          workspaceId={session?.workspaceId ?? session?.config.workspaceId}
          workspacePath={session?.workspacePath}
          remoteConnectionId={session?.remoteConnectionId}
          remoteSshHost={session?.remoteSshHost}
          onStatusChange={setPreflightStatus}
        />
      ) : null}
      <ProminentToolCard
        status={status}
        isExpanded={!isOpenable || diagnostics.length > 0 || isFailed}
        onToggle={isOpenable ? handleOpenPanel : undefined}
        className={`canvas-tool-card ${isOpenable ? 'clickable' : ''}`.trim()}
        summary={summary}
        expandedContent={body}
        errorContent={isFailed ? body : undefined}
        isFailed={isFailed}
        summaryExpandAffordance={isOpenable}
        summaryAffordanceKind="open-panel-right"
      />
    </div>
  );
};

export default CanvasToolCard;
