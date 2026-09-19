/**
 * Streaming tool card component.
 * Renders a dedicated card based on tool type.
 */

import React from 'react';
import { getToolCardComponent } from '../tool-cards';
import { getToolItemCardConfig } from '../tool-cards/toolCardMetadata';
import type { FlowToolItem, ToolCardDisplayContext, ToolRejectOptions } from '../types/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import { FlowToolCardErrorBoundary } from './FlowToolCardErrorBoundary';
import { useTranslation } from 'react-i18next';
import { getToolInterruptionNote } from '../utils/toolInterruption';
import { ToolApprovalBar } from './ToolApprovalBar';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { useFlowChatVolatileContext } from './modern/FlowChatContext';
import './FlowToolCard.scss';

const log = createLogger('FlowToolCard');

interface FlowToolCardProps {
  toolItem: FlowToolItem;
  onConfirm?: (toolId: string, permissionOptionId?: string, approve?: boolean) => void;
  onReject?: (toolId: string, options?: ToolRejectOptions) => void;
  onOpenInEditor?: (filePath: string) => void;
  onOpenInPanel?: (panelType: string, data: any) => void;
  onExpand?: (toolId: string) => void;
  sessionId?: string;
  turnId?: string;
  className?: string;
  displayContext?: ToolCardDisplayContext;
  isLastItem?: boolean;
}

export const FlowToolCard: React.FC<FlowToolCardProps> = React.memo(({
  toolItem,
  onConfirm,
  onReject,
  onOpenInEditor,
  onOpenInPanel,
  onExpand,
  sessionId,
  className = '',
  displayContext = 'default',
  isLastItem,
}) => {
  const { t } = useTranslation('flow-chat');
  const effectiveToolItem = projectEffectiveToolItem(toolItem);
  const { pendingPermissionToolCallIds } = useFlowChatVolatileContext();
  const config = getToolItemCardConfig(effectiveToolItem);
  const CardComponent = getToolCardComponent(effectiveToolItem.toolName);
  const interruptionNote = getToolInterruptionNote(effectiveToolItem, t);
  const cardHandlesInterruptionNote = effectiveToolItem.toolName === 'Task';
  const toolCardTestId =
    effectiveToolItem.toolName === 'ExecCommand'
      ? 'chat-shell-tool-card'
      : effectiveToolItem.toolName === 'WebFetch'
        ? 'chat-browser-tool-card'
        : undefined;
  const permissionPending =
    effectiveToolItem.status === 'pending_confirmation' ||
    pendingPermissionToolCallIds?.has(toolItem.toolCall.id) === true;
  const attention =
    effectiveToolItem.toolName === 'Task' && effectiveToolItem.status === 'cancelled'
      ? 'ambient'
      : config.attention;

  const handleConfirm = React.useCallback((permissionOptionId?: string, approve?: boolean) => {
    log.debug('handleConfirm called', {
      toolId: toolItem.id,
      toolName: effectiveToolItem.toolName,
      hasPermissionOption: Boolean(permissionOptionId),
      approve
    });
    onConfirm?.(toolItem.id, permissionOptionId, approve);
  }, [effectiveToolItem.toolName, toolItem.id, onConfirm]);

  const handleReject = React.useCallback((options?: ToolRejectOptions) => {
    onReject?.(toolItem.id, options);
  }, [toolItem.id, onReject]);

  const handleExpand = React.useCallback(() => {
    onExpand?.(toolItem.id);
  }, [toolItem.id, onExpand]);

  return (
    <div
      className={`flow-tool-card-wrapper ${permissionPending ? 'flow-tool-card-wrapper--permission-pending' : ''} ${className}`.trim()}
      data-openbitfun-component="flow-tool-card"
      data-openbitfun-part="root"
      data-openbitfun-state={permissionPending ? 'permission-pending' : undefined}
      data-testid={toolCardTestId}
      data-tool-name={effectiveToolItem.toolName}
      data-tool-card-id={toolItem.id}
      data-openbitfun-attention={attention}
      data-openbitfun-presentation={config.presentation}
    >
      <FlowToolCardErrorBoundary
        toolItem={effectiveToolItem}
        displayName={config.displayName}
        sessionId={sessionId}
      >
        <CardComponent
          toolItem={effectiveToolItem}
          config={config}
          interruptionNote={interruptionNote}
          onOpenInEditor={onOpenInEditor}
          onOpenInPanel={onOpenInPanel}
          onExpand={handleExpand}
          sessionId={sessionId}
          displayContext={displayContext}
          isLastItem={isLastItem}
        />
      </FlowToolCardErrorBoundary>
      <ToolApprovalBar
        toolItem={effectiveToolItem}
        onConfirm={handleConfirm}
        onReject={handleReject}
      />
      {interruptionNote && !cardHandlesInterruptionNote && (
        <div
          className="flow-tool-card-note"
          data-openbitfun-component="flow-tool-card"
          data-openbitfun-part="note"
          role="note"
        >
          {interruptionNote}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Compare streaming parameters and progress messages to avoid stale renders.
  const prevProgress = (prevProps.toolItem as any)._progressMessage;
  const nextProgress = (nextProps.toolItem as any)._progressMessage;
  const prevProgressLogs = (prevProps.toolItem as any)._progressLogs;
  const nextProgressLogs = (nextProps.toolItem as any)._progressLogs;
  
  return (
    prevProps.toolItem.id === nextProps.toolItem.id &&
    prevProps.toolItem.toolName === nextProps.toolItem.toolName &&
    prevProps.toolItem.toolCall === nextProps.toolItem.toolCall &&
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.toolItem.status === nextProps.toolItem.status &&
    prevProps.toolItem.interruptionReason === nextProps.toolItem.interruptionReason &&
    prevProps.toolItem.terminalSessionId === nextProps.toolItem.terminalSessionId &&
    prevProps.toolItem.userConfirmed === nextProps.toolItem.userConfirmed &&
    prevProps.toolItem.acpPermission === nextProps.toolItem.acpPermission &&
    prevProps.toolItem.isParamsStreaming === nextProps.toolItem.isParamsStreaming &&
    prevProps.toolItem.subagentSessionId === nextProps.toolItem.subagentSessionId &&
    prevProps.toolItem.subagentDialogTurnId === nextProps.toolItem.subagentDialogTurnId &&
    prevProps.toolItem.subagentModelId === nextProps.toolItem.subagentModelId &&
    prevProps.toolItem.subagentModelDisplayName === nextProps.toolItem.subagentModelDisplayName &&
    prevProps.displayContext === nextProps.displayContext &&
    prevProps.isLastItem === nextProps.isLastItem &&
    prevProgress === nextProgress &&
    prevProgressLogs === nextProgressLogs &&
    prevProps.toolItem.partialParams === nextProps.toolItem.partialParams &&
    prevProps.toolItem.toolResult === nextProps.toolItem.toolResult
  );
});
