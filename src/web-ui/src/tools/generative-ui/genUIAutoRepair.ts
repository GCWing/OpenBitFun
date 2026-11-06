import type { GenUIRenderDiagnostic } from './genUIRenderDiagnostics';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
import type { GenUIVerification } from './genUIVerification';
import { isRepairWorthyGenUIError } from './genUIRenderDiagnostics';
import { requestGenUIRepair } from './genUIRepair';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';

const MAX_ATTEMPTS_PER_APP = 2;
const STORAGE_KEY = 'openbitfun.genui.auto-repair.v1';
type Entry = { attempts: number; errors: string[] };
type State = Record<string, Entry>;

function repairErrorKey(errors: GenUIRenderDiagnostic[]): string {
  return JSON.stringify(errors.filter(isRepairWorthyGenUIError).map(({ source, code, message, statementId }) =>
    ({ source, code, message, statementId })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function readState(): State {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as State; }
  catch { return {}; }
}

function appIdentity(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** Only a just-finished, active rendering surface calls this; persisted claims
 * deduplicate multiple tabs and keep a failed error from retrying on reload. */
export async function requestGenUIAutoRepair(origin: GenerativeWidgetOrigin, report: GenUIVerification): Promise<boolean> {
  if (report.render === 'unverified' || !report.diagnostics?.some(isRepairWorthyGenUIError)) return false;
  if (getActiveSurfaceScope().surfaceId !== origin.surfaceId
    || flowChatStore.getState().activeSessionId !== origin.sessionId) return false;
  if (document.visibilityState === 'hidden') return false;
  const session = flowChatStore.getState().sessions.get(origin.sessionId);
  const inherited = session?.dialogTurns.find(turn => turn.id === origin.turnId)?.userMessage?.metadata?.genUIRepair;
  // Follow the repair Turn, even if the model gives the replacement a new app id.
  const chainId = typeof inherited?.chainId === 'string' ? inherited.chainId
    : appIdentity(JSON.stringify([origin.sessionId, report.appId ?? origin.toolCallId]));
  const inheritedAttempts = Number.isSafeInteger(inherited?.attempt) ? inherited.attempt as number : 0;
  const scopeKey = appIdentity(JSON.stringify([origin.surfaceId, chainId]));
  const diagnosticKey = repairErrorKey(report.diagnostics);
  if (diagnosticKey === '[]') return false;
  const errorKey = appIdentity(JSON.stringify([report.definitionKey, diagnosticKey]));
  const send = async () => {
    const state = readState();
    const previous = state[scopeKey] ?? { attempts: 0, errors: [] };
    const attempts = Math.max(previous.attempts, inheritedAttempts);
    if (attempts >= MAX_ATTEMPTS_PER_APP || previous.errors.includes(errorKey)) return false;
    const attempt = attempts + 1;
    state[scopeKey] = { attempts: attempt, errors: [...previous.errors, errorKey] };
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { return false; }
    // The host queue owns this slot across devices; controller-local surface ids
    // must not enter it. Concurrent controllers cannot create separate repairs.
    const turnId = `genui_repair_${chainId}_${attempt}`;
    await requestGenUIRepair(origin, report, { turnId, chainId, attempt });
    return true;
  };
  return navigator.locks
    ? navigator.locks.request(`genui-repair:${scopeKey}`, { ifAvailable: true }, lock => lock ? send() : false)
    : send();
}
