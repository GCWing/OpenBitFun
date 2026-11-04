import React from 'react';
import { flowChatStore } from '../store/FlowChatStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import GenerativeWidgetPanel from '@/tools/generative-widget/GenerativeWidgetPanel';
import { findGenerativeWidgetProjection, projectGenerativeWidgetTool } from '../utils/generativeWidgetProjection';
import type { FlowToolItem } from '../types/flow-chat';
import './GenerativeWidgetInline.scss';

export interface GenerativeWidgetInlineProps {
  toolItem: FlowToolItem;
  sessionId?: string;
  turnId?: string;
}

/** The FlowChat-native transient GenUI surface. */
export const GenerativeWidgetInline: React.FC<GenerativeWidgetInlineProps> = ({ toolItem, sessionId, turnId }) => {
  const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
  const projection = (() => {
    if (!session) return null;
    const direct = projectGenerativeWidgetTool(session, toolItem, { turnId }, getActiveSurfaceId());
    if (!direct || (!direct.isFailed && direct.status !== 'cancelled')) return direct;
    return findGenerativeWidgetProjection(flowChatStore.getState(), direct.origin, true) ?? direct;
  })();

  // Failed candidates remain in tool history for the model's repair loop, but
  // do not leave an error card (or duplicate a later repair) in the answer.
  if (!projection || projection.isFailed || projection.status === 'rejected') return null;
  // OpenUI can produce a usable prefix while the model is still thinking;
  // let the thinking handoff release this successor immediately.
  return (
    <div
      className="generative-widget-inline"
      data-openbitfun-component="generative-widget-inline"
      data-openbitfun-part="root"
      data-openbitfun-state={projection.interactionState ?? (projection.isStreaming ? 'streaming' : projection.isFailed ? 'failed' : projection.status)}
      data-thinking-handoff-priority="immediate"
      data-tool-card-id={toolItem.id}
    >
      <GenerativeWidgetPanel
        origin={projection.origin}
        presentation="inline"
      />
    </div>
  );
};

export default GenerativeWidgetInline;

