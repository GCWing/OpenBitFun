import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  type GenerativeWidgetOrigin,
} from '@/flow_chat/utils/generativeWidgetProjection';
import { useGenerativeWidgetProjection } from '@/flow_chat/hooks/useGenerativeWidgetProjection';
import GenUIApplication from '@/tools/generative-ui/GenUIApplication';
import { isGenUIAppEnvelope, type GenUIAppEnvelope, type GenUIAppState } from '@/tools/generative-ui/genUITypes';
import { resolveGenUIInteractionState } from '@/tools/generative-ui/genUIInteractionState';
import { useChatMcpCatalog } from '@/flow_chat/hooks/useChatMcpCatalog';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createGenUIMcpProvider } from '@/tools/generative-ui/genUIMcpProvider';
import { createGenUINativeProvider, mergeGenUIProviders } from '@/tools/generative-ui/genUINativeProvider';
import type { GenUITargetEvent } from '@/tools/generative-ui/genUIAsyncCapabilities';
import { requiresGenUIAsyncProvider } from '@/tools/generative-ui/genUIAsyncSource';
import type { GenUIVerification } from '@/tools/generative-ui/genUIVerification';
import { requestGenUIAutoRepair } from '@/tools/generative-ui/genUIAutoRepair';
import { isRepairWorthyGenUIError } from '@/tools/generative-ui/genUIRenderDiagnostics';
import { genUIContentKey } from '@/tools/generative-ui/genUIState';
import { requestGenUIRepair } from '@/tools/generative-ui/genUIRepair';
import './GenerativeWidgetPanel.scss';

export interface GenerativeWidgetPanelProps {
  app?: GenUIAppEnvelope;
  appState?: GenUIAppState;
  origin?: GenerativeWidgetOrigin;
  presentation?: 'panel' | 'inline';
  /** Optional host delivery for component events such as Map marker selection. */
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
  onExpand?: (value: { origin: GenerativeWidgetOrigin; app: GenUIAppEnvelope; appState?: GenUIAppState; widgetId: string }) => void;
}

export const GenerativeWidgetPanel: React.FC<GenerativeWidgetPanelProps> = ({
  app: suppliedApp,
  appState: suppliedState,
  origin,
  presentation = 'panel',
  onTargetEvent,
  onExpand,
}) => {
  const { t } = useI18n('flow-chat');
  const projection = useGenerativeWidgetProjection(origin);
  const app = origin ? projection?.app : (isGenUIAppEnvelope(suppliedApp) ? suppliedApp : undefined);
  const appState = origin ? projection?.appState : suppliedState;
  const session = origin ? flowChatStore.getState().sessions.get(origin.sessionId) : undefined;
  const mcpCatalog = useChatMcpCatalog({
    // A plain OpenUI document does not need a host catalog. Loading it only
    // for sources that can actually call Query/Mutation or remote media/map
    // providers avoids a relay request for every transient FlowChat answer.
    // Capability admission remains enforced by the async runtime itself.
    enabled: Boolean(origin?.sessionId && app && requiresGenUIAsyncProvider(app)),
    surfaceEpoch: getActiveSurfaceScope().epoch,
    modeId: session?.mode ?? session?.config?.agentType ?? 'Standard',
    workspaceId: origin?.scope.workspaceId,
  });
  const asyncTarget: 'local' | 'peer' = origin?.scope.surfaceId && origin.scope.surfaceId !== 'local' ? 'peer' : 'local';
  const asyncTargetId = asyncTarget === 'peer' ? origin?.scope.surfaceId : undefined;
  const mcpProvider = useMemo(() => {
    const mcp = createGenUIMcpProvider(mcpCatalog.catalog ?? { modeRestricted: false, tools: [] }, {
      target: asyncTarget,
      eventCapabilities: {
        'map.marker.select': { target: asyncTarget, description: 'A user selected a marker on the generated map' },
      },
      onTargetEvent,
    });
    return mergeGenUIProviders(mcp, createGenUINativeProvider(asyncTarget), onTargetEvent);
  }, [asyncTarget, mcpCatalog.catalog, onTargetEvent]);
  const requiresDelivery = false;
  const [verification, setVerification] = useState<GenUIVerification>();
  const originKey = JSON.stringify(origin);
  const observedGeneration = useRef({ originKey, live: false });
  if (observedGeneration.current.originKey !== originKey) {
    observedGeneration.current = { originKey, live: false };
  }
  const autoRepairKey = useRef('');
  const [repairPending, setRepairPending] = useState(false);
  const [repairQueued, setRepairQueued] = useState(false);
  const [repairError, setRepairError] = useState('');
  useEffect(() => {
    autoRepairKey.current = '';
    setRepairPending(false);
    setRepairQueued(false);
    setRepairError('');
  }, [originKey]);
  const sourceTurn = projection?.origin ? flowChatStore.getState().sessions.get(projection.origin.sessionId)
    ?.dialogTurns.find(turn => turn.id === projection.origin.turnId) : undefined;
  // Deferred calls can be identified as GenUI only once their arguments close,
  // after the tool has finished. Their owning turn is still live at that point;
  // requiring this component to have seen streaming misses those generations.
  const sourceTurnRunning = !sourceTurn?.recovery
    && (sourceTurn?.status === 'processing' || sourceTurn?.status === 'finishing');
  if ((projection?.isStreaming || sourceTurnRunning) && projection && !projection.readOnly
    && flowChatStore.getState().activeSessionId === origin?.sessionId
    && document.visibilityState !== 'hidden') observedGeneration.current.live = true;
  const onVerification = (report: GenUIVerification) => {
    setVerification(report);
    if (!projection?.origin || !projection.app || !observedGeneration.current.live || projection.isStreaming || projection.readOnly || projection.isFailed) return;
    const repairKey = `${report.definitionKey}:${JSON.stringify(report.diagnostics ?? [])}`;
    if (report.definitionKey !== genUIContentKey(projection.app) || report.render === 'unverified' || !report.diagnostics?.some(isRepairWorthyGenUIError)
      || autoRepairKey.current === repairKey) return;
    autoRepairKey.current = repairKey;
    setRepairPending(true);
    void requestGenUIAutoRepair(projection.origin, report).then(setRepairQueued, error => {
      setRepairError(error instanceof Error ? error.message : String(error));
    }).finally(() => setRepairPending(false));
  };
  const canInteract = Boolean(app && !projection?.readOnly && !projection?.isFailed && projection?.status !== 'cancelled' && projection?.status !== 'rejected');
  const interactionState = resolveGenUIInteractionState({
    app,
    toolStatus: projection?.status,
    isStreaming: projection?.isStreaming,
    isFailed: projection?.isFailed,
    isCancelled: projection?.status === 'cancelled',
    isRejected: projection?.status === 'rejected',
    ownerReady: true,
    ownerError: projection?.readOnlyReason,
    deliveryAccepted: false,
    requiresDelivery,
  });
  const terminalStatus = t(`toolCards.generativeUI.state.${interactionState}`);
  const showToolbar = presentation === 'panel' || requiresDelivery;

  // Keep the tool failure available to the model without surfacing a failed
  // candidate while it repairs the source. Owner/save errors remain visible.
  if (projection?.isFailed || projection?.status === 'rejected') return null;
  const currentVerification = app && verification?.definitionKey === genUIContentKey(app) ? verification : undefined;
  const fatalRender = currentVerification?.render === 'failed';
  let repairControl: React.ReactNode = null;
  if (currentVerification?.diagnostics?.some(isRepairWorthyGenUIError)) {
    const repairable = Boolean(projection?.origin && currentVerification.diagnostics?.some(isRepairWorthyGenUIError));
    if (repairable && !projection?.readOnly && !repairQueued && !repairPending) repairControl = <div className="openbitfun-generative-widget-panel__repair" data-openbitfun-component="generative-widget" data-openbitfun-part="repair" data-openbitfun-state="repairRequired">
      <button type="button" disabled={repairPending} onClick={() => {
        if (!projection?.origin) return;
        setRepairPending(true);
        setRepairError('');
        void requestGenUIRepair(projection.origin, currentVerification).catch(error => {
          setRepairError(error instanceof Error ? error.message : String(error));
        }).finally(() => setRepairPending(false));
      }}>{t('toolCards.generativeUI.repair')}</button>
      {repairError ? <span role="alert">{t('toolCards.generativeUI.repairFailed')}</span> : null}
    </div>;
  }
  if (app) {
    return (
      <div
        className={`openbitfun-generative-widget-panel openbitfun-generative-widget-panel--app openbitfun-generative-widget-panel--${presentation}`}
        data-openbitfun-component="generative-widget"
        data-openbitfun-part="application"
        data-openbitfun-state={interactionState}
      >
        {showToolbar && !fatalRender ? <div className="openbitfun-generative-widget-panel__toolbar" data-openbitfun-component="generative-widget" data-openbitfun-part="toolbar">
          <span className="openbitfun-generative-widget-panel__title">{app.title}</span>
          <span className="openbitfun-generative-widget-panel__status" role="status" aria-live="polite">{terminalStatus}</span>
          {presentation === 'inline' && projection?.origin && onExpand ? <button
            type="button"
            className="openbitfun-generative-widget-panel__expand"
            onClick={() => onExpand({ origin: projection.origin, app, appState, widgetId: projection.widgetId })}
            aria-label="Open expanded GenUI view"
          >↗</button> : null}
        </div> : null}
        {projection?.readOnlyReason ? <p role="status">{projection.readOnlyReason}</p> : null}
        {repairControl}
        <div hidden={fatalRender} className="openbitfun-generative-widget-panel__app" data-openbitfun-component="generative-widget" data-openbitfun-part="app">
          <GenUIApplication
            key={JSON.stringify([projection?.origin ?? origin, app.id])}
            definition={app}
            streaming={projection?.isStreaming}
            initialState={appState}
            restoredFromStorage={false}
            readOnly={!canInteract}
            persistState={false}
            asyncProvider={mcpProvider}
            asyncTarget={asyncTarget}
            asyncTargetId={asyncTargetId}
            onTargetEvent={onTargetEvent}
            onVerification={onVerification}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="openbitfun-generative-widget-panel openbitfun-generative-widget-panel--empty"
      data-openbitfun-component="generative-widget" data-openbitfun-part="empty"
      data-openbitfun-state={interactionState}>
      {interactionState === 'starting' ? <div className="openbitfun-generative-widget-panel__skeleton" aria-label={terminalStatus} aria-busy="true">
        <span /><span /><span />
      </div> : <div className="openbitfun-generative-widget-panel__empty-copy">
        {projection?.readOnlyReason ?? terminalStatus}
      </div>}
    </div>
  );
};
export default GenerativeWidgetPanel;
