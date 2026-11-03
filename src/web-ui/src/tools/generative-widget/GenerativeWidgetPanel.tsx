import React, { useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  type GenerativeWidgetOrigin,
} from '@/flow_chat/utils/generativeWidgetProjection';
import { useGenerativeWidgetProjection } from '@/flow_chat/hooks/useGenerativeWidgetProjection';
import GenUIApplication from '@/tools/generative-ui/GenUIApplication';
import { isGenUIAppEnvelope, type GenUIAppEnvelope, type GenUIAppState } from '@/tools/generative-ui/genUITypes';
import type { GenUIVerification } from '@/tools/generative-ui/genUIVerification';
import { GenUIVerificationPanel } from '@/tools/generative-ui/GenUIVerificationPanel';
import { genUIContentKey } from '@/tools/generative-ui/genUIState';
import { requestGenUIRepair } from '@/tools/generative-ui/genUIRepair';
import { useGenUIOwner } from '@/tools/generative-ui/useGenUIOwner';
import { resolveGenUIInteractionState } from '@/tools/generative-ui/genUIInteractionState';
import { useChatMcpCatalog } from '@/flow_chat/hooks/useChatMcpCatalog';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createGenUIMcpProvider } from '@/tools/generative-ui/genUIMcpProvider';
import { createGenUINativeProvider, mergeGenUIProviders } from '@/tools/generative-ui/genUINativeProvider';
import type { GenUITargetEvent } from '@/tools/generative-ui/genUIAsyncCapabilities';
import { requiresGenUIAsyncProvider } from '@/tools/generative-ui/genUIAsyncSource';
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
  const [reloading, setReloading] = useState(false);
  const [evidence, setEvidence] = useState<{ source: string; report: GenUIVerification }>();
  const [reloaded, setReloaded] = useState<{ source: string; state: GenUIAppState; revision: number; baseline: string }>();
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
  const appIdentity = app as unknown as Record<string, unknown> | undefined;
  const deliveryMode: 'transient' | 'delivery' = projection?.deliveryMode
    ?? ((typeof appIdentity?.libraryId === 'string' && appIdentity.libraryId.includes('.harmony.')) || (typeof appIdentity?.template === 'string' && appIdentity.template.includes('.harmony.')) ? 'delivery' : 'transient');
  const requiresDelivery = deliveryMode === 'delivery';
  const owner = useGenUIOwner(projection?.origin, app, projection?.ownerRevision);
  const canEdit = Boolean(requiresDelivery && projection?.origin && owner.enabled && !projection.readOnly && projection.status === 'completed' && !projection.isFailed && app && app.schemaVersion === 2 && owner.ready);
  const canInteract = Boolean(app && !projection?.readOnly && !projection?.isFailed && projection?.status !== 'cancelled' && projection?.status !== 'rejected' && !reloading);
  const canPersist = requiresDelivery && canEdit && !projection?.isStreaming;
  const sourceKey = JSON.stringify([projection?.origin ?? origin, app]);
  const verification = evidence?.source === sourceKey ? evidence.report : undefined;
  const loaded = reloaded?.source === sourceKey ? reloaded : undefined;
  const loadedState = owner.enabled ? owner.state : appState;
  const interactionState = resolveGenUIInteractionState({
    app,
    toolStatus: projection?.status,
    isStreaming: projection?.isStreaming,
    isFailed: projection?.isFailed,
    isCancelled: projection?.status === 'cancelled',
    isRejected: projection?.status === 'rejected',
    verification,
    ownerReady: !owner.enabled || owner.ready,
    ownerError: projection?.readOnlyReason ?? owner.error,
    deliveryAccepted: Boolean(projection?.deliveryEvidence && projection.deliveryEvidence.persistence === 'saved' && projection.deliveryEvidence.reopen === 'passed'),
    requiresDelivery,
  });
  const terminalStatus = t(`toolCards.generativeUI.state.${interactionState}`);
  const showToolbar = presentation === 'panel' || requiresDelivery;

  if (app) {
    return (
      <div
        className={`openbitfun-generative-widget-panel openbitfun-generative-widget-panel--app openbitfun-generative-widget-panel--${presentation}`}
        data-openbitfun-component="generative-widget"
        data-openbitfun-part="application"
        data-openbitfun-state={interactionState}
      >
        {showToolbar ? <div className="openbitfun-generative-widget-panel__toolbar" data-openbitfun-component="generative-widget" data-openbitfun-part="toolbar">
          <span className="openbitfun-generative-widget-panel__title">{app.title}</span>
          <span className="openbitfun-generative-widget-panel__status" role="status" aria-live="polite">{terminalStatus}</span>
          {presentation === 'panel' ? <span className="openbitfun-generative-widget-panel__readonly">{t(canEdit ? 'toolCards.generativeUI.hostedState' : 'toolCards.generativeUI.readOnly')}</span> : null}
          {presentation === 'inline' && projection?.origin && onExpand ? <button
            type="button"
            className="openbitfun-generative-widget-panel__expand"
            onClick={() => onExpand({ origin: projection.origin, app, appState, widgetId: projection.widgetId })}
            aria-label="Open expanded GenUI view"
          >↗</button> : null}
        </div> : null}
        {projection?.readOnlyReason ? <p role="status">{projection.readOnlyReason}</p> : null}
        {owner.error ? <p role="alert">{owner.error}</p> : null}
        <div className="openbitfun-generative-widget-panel__app" data-openbitfun-component="generative-widget" data-openbitfun-part="app">
          <GenUIApplication
            key={JSON.stringify([projection?.origin ?? origin, app.id, loaded?.revision])}
            definition={app}
            streaming={projection?.isStreaming}
            initialState={loadedState}
            restoredFromStorage={requiresDelivery && owner.enabled && owner.ready}
            readOnly={!canInteract}
            persistState={canPersist}
            onVerification={requiresDelivery ? report => setEvidence({ source: sourceKey, report }) : undefined}
            onStateChange={canPersist ? owner.save : undefined}
            asyncProvider={mcpProvider}
            asyncTarget={asyncTarget}
            asyncTargetId={asyncTargetId}
            onTargetEvent={onTargetEvent}
          />
          {requiresDelivery && verification?.definitionKey === genUIContentKey(app) ? <GenUIVerificationPanel report={verification}
            delivery={projection?.deliveryEvidence}
            onRepair={projection?.origin && !projection.isStreaming ? () => requestGenUIRepair(projection.origin, verification) : undefined}
            onReload={canEdit && projection ? async () => {
              setReloading(true);
              try {
                const state = await owner.reload();
                setReloaded(current => ({ source: sourceKey, state, baseline: genUIContentKey(projection.appState), revision: (current?.revision ?? 0) + 1 }));
              } finally { setReloading(false); }
            } : undefined} /> : null}
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
