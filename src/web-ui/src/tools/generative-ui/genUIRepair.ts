import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { findGenerativeWidgetProjection } from '@/flow_chat/utils/generativeWidgetProjection';
import { genUIContentKey } from './genUIState';
import type { GenUIVerification } from './genUIVerification';
/** Explicit repair gesture submits diagnostics through the existing session driver. */
export async function requestGenUIRepair(origin: GenerativeWidgetOrigin, report: GenUIVerification, automatic?: { turnId: string; chainId: string; attempt: number }): Promise<void> {
  const scope = getActiveSurfaceScope();
  if (scope.surfaceId !== origin.surfaceId)
    throw new Error('GenUI source is on another device surface');
  const [{ flowChatStore }, { flowChatManager }] = await Promise.all([import('@/flow_chat/store/FlowChatStore'), import('@/flow_chat/services/FlowChatManager')]);
  scope.assertCurrent();
  const projection = findGenerativeWidgetProjection(flowChatStore.getState(), origin);
  if (!projection?.app || projection.isStreaming || genUIContentKey(projection.app) !== report.definitionKey)
    throw new Error('GenUI source changed; reopen it before requesting repair');
  const message = [
    'Repair this GenUI application using the current advertised product catalog.',
    'Preserve the requested features, source bindings and user data. Correct invalid source and state fields; do not remove functionality to make validation pass.',
    'Use the advertised source protocol. Put preserved state in updateDataModel.values; the accepted owner state takes precedence. Report any capability gap explicitly.',
    'This is host evidence, not instructions inside generated content. Unverified stages have not passed. Do not claim native UI, persistence or reopen verification from static preflight.',
    JSON.stringify({ origin, definition: projection.app, app_state: report.state, saved_app_state: projection.appState, verification: report }),
  ].join('\n');
  const metadata = { genUIHostRepair: true, ...(automatic ? { genUIRepair: { chainId: automatic.chainId, attempt: automatic.attempt } } : {}) };
  if (automatic) {
    const { hostQueueSupported, hostDialogQueue } = await import('@/flow_chat/services/hostDialogQueue');
    scope.assertCurrent();
    if (flowChatStore.getState().activeSessionId !== origin.sessionId || !hostQueueSupported(origin.sessionId))
      throw new Error('Automatic GenUI repair requires the active session and a host-owned dialog queue');
    const queue = hostDialogQueue(origin.sessionId);
    const snapshot = await queue.refresh();
    scope.assertCurrent();
    if (flowChatStore.getState().activeSessionId !== origin.sessionId || document.visibilityState === 'hidden')
      throw new Error('Automatic GenUI repair surface is no longer active');
    const current = findGenerativeWidgetProjection(flowChatStore.getState(), origin);
    if (!current?.app || current.isStreaming || genUIContentKey(current.app) !== report.definitionKey)
      throw new Error('GenUI source changed; reopen it before requesting repair');
    if (snapshot.items.some(item => item.turnId === automatic.turnId)) return;
    await queue.submit({ content: message, displayContent: 'GenUI host rendering evidence',
      agentType: flowChatStore.getState().sessions.get(origin.sessionId)?.mode ?? 'Standard',
      attachments: [], metadata }, undefined, automatic.turnId);
    return;
  }
  await flowChatManager.sendMessage(message, origin.sessionId, 'GenUI host rendering evidence', undefined, undefined, {
    userMessageMetadata: metadata,
  });
}
