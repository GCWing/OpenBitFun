import React, { useCallback } from 'react';
import { flowChatStore } from '../store/FlowChatStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { openContentInBestTarget } from '@/shared/services/workbenchContentService';
import GenerativeWidgetPanel from '@/tools/generative-widget/GenerativeWidgetPanel';
import { findGenerativeWidgetProjection, projectGenerativeWidgetTool } from '../utils/generativeWidgetProjection';
import type { FlowToolItem } from '../types/flow-chat';
import './GenerativeWidgetInline.scss';

export interface GenerativeWidgetInlineProps {
  toolItem: FlowToolItem;
  sessionId?: string;
  turnId?: string;
}

/** The FlowChat-native GenUI surface. OpenUI stays inline; only explicit
 * Harmony delivery may hand off to the workbench for a larger view. */
export const GenerativeWidgetInline: React.FC<GenerativeWidgetInlineProps> = ({ toolItem, sessionId, turnId }) => {
  const session = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
  const projection = (() => {
    if (!session) return null;
    const direct = projectGenerativeWidgetTool(session, toolItem, { turnId }, getActiveSurfaceId());
    if (!direct || (!direct.isFailed && direct.status !== 'cancelled')) return direct;
    return findGenerativeWidgetProjection(flowChatStore.getState(), direct.origin, true) ?? direct;
  })();

  const handleExpand = useCallback((value: Parameters<NonNullable<React.ComponentProps<typeof GenerativeWidgetPanel>['onExpand']>>[0]) => {
    const key = JSON.stringify([
      'generative-widget', value.origin.surfaceId, value.origin.sessionId,
      value.origin.turnId ?? '', value.origin.toolCallId ?? value.origin.toolItemId ?? '',
    ]);
    openContentInBestTarget({
      type: 'generative-widget',
      title: value.app.title,
      data: {
        widgetId: value.widgetId,
        app: value.app,
        appState: value.appState,
        origin: value.origin,
        _source: value.origin,
      },
      metadata: { duplicateCheckKey: key, fromTool: true, toolName: 'GenerativeUI' },
    }, {
      scope: value.origin.scope,
      resourceKey: key,
      replaceExisting: true,
      focus: true,
      sessionId: value.origin.sessionId,
    });
  }, []);

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
        // OpenUI answers stay in FlowChat. Only an explicit Harmony delivery
        // may offer a workbench expansion, where the durable owner is visible.
        onExpand={projection.deliveryMode === 'delivery' && projection.isComplete ? handleExpand : undefined}
      />
    </div>
  );
};

export default GenerativeWidgetInline;

