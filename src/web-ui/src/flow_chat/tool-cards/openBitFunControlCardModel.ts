import type { FlowToolItem } from '../types/flow-chat';

type ControlRecord = Record<string, unknown>;
export type OpenBitFunControlAction = 'list' | 'search' | 'get' | 'open' | 'execute' | 'configure';

export function controlRecord(value: unknown): ControlRecord {
  if (typeof value === 'string') {
    try { return controlRecord(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ControlRecord
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function id(record: ControlRecord, snake: string, camel: string): string | undefined {
  return text(record[snake]) ?? text(record[camel]);
}

function records(value: unknown): ControlRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ControlRecord => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

export function controlTitle(record: ControlRecord, language: string): string | undefined {
  const [preferred, fallback] = language.startsWith('zh') ? ['titleZh', 'titleEn'] : ['titleEn', 'titleZh'];
  return text(record[preferred]) ?? text(record[fallback]) ?? text(record.title);
}

export function controlDescription(record: ControlRecord, language: string): string | undefined {
  return text(record[language.startsWith('zh') ? 'summaryZh' : 'summaryEn']);
}

export function getOpenBitFunControlInput(toolItem: Pick<FlowToolItem, 'toolCall' | 'partialParams' | 'isParamsStreaming'>): ControlRecord {
  const input = controlRecord(toolItem.toolCall?.input);
  const partial = controlRecord(toolItem.partialParams);
  // Deferred calls retain gateway-shaped streaming parameters after identity projection.
  const params = partial.tool_name === 'OpenBitFunControl' ? controlRecord(partial.args) : partial;
  return toolItem.isParamsStreaming ? { ...input, ...params }
    : Object.keys(input).length > 0 ? input : params;
}

export function isOpenBitFunControlDiscovery(input: unknown): boolean {
  return ['list', 'search', 'get'].includes(String(controlRecord(input).action ?? '').trim());
}

function actionOf(input: ControlRecord): OpenBitFunControlAction | undefined {
  const action = text(input.action);
  return action && ['list', 'search', 'get', 'open', 'execute', 'configure'].includes(action)
    ? action as OpenBitFunControlAction
    : undefined;
}

function requestedValue(input: ControlRecord): unknown {
  if (input.value_null === true) return null;
  for (const key of ['value_boolean', 'value_string', 'value_integer', 'value_number', 'value_object', 'value_array', 'value']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

/** Read-only projection. The executing host remains the authority for outcomes and availability. */
export function buildOpenBitFunControlCardModel(
  toolItem: FlowToolItem,
  language: string,
  localCapability?: unknown,
) {
  const input = getOpenBitFunControlInput(toolItem);
  const result = controlRecord(toolItem.toolResult?.result);
  const returnedCapability = controlRecord(result.capability);
  const capabilityId = id(result, 'capability_id', 'capabilityId')
    ?? text(returnedCapability.id)
    ?? id(input, 'capability_id', 'capabilityId');
  const local = controlRecord(localCapability);
  const capability = Object.keys(returnedCapability).length > 0
    ? returnedCapability
    : local.id === capabilityId ? local : {};
  const action = actionOf(input);
  const optionId = id(result, 'option_id', 'optionId') ?? id(input, 'option_id', 'optionId');
  const operationId = id(result, 'operation_id', 'operationId') ?? id(input, 'operation_id', 'operationId');
  const itemId = id(result, 'item_id', 'itemId') ?? id(input, 'item_id', 'itemId');
  const subjectId = action === 'configure' ? optionId : action === 'execute' ? operationId : itemId;
  const subjects = records(capability[action === 'configure' ? 'options' : action === 'execute' ? 'operations' : 'items']);
  const subject = subjects.find(item => item.id === subjectId);
  const target = [controlTitle(capability, language) ?? capabilityId, subject ? controlTitle(subject, language) ?? subjectId : subjectId]
    .filter(Boolean).join(' · ');
  const acknowledgement = action === 'configure' ? result.configured
    : action === 'execute' ? result.executed
      : action === 'open' ? result.opened
        : action === 'get' ? Object.keys(returnedCapability).length > 0
          : action === 'list' || action === 'search' ? Array.isArray(result.items) : undefined;
  const stopped = toolItem.status === 'cancelled' || toolItem.status === 'rejected';
  const failed = !stopped && (toolItem.status === 'error' || toolItem.toolResult?.success === false
    || result.success === false || acknowledgement === false && ['open', 'execute', 'configure'].includes(action ?? ''));
  const status = failed ? 'error' : toolItem.status;
  const confirmed = status === 'completed' && acknowledgement === true;
  const availability = controlRecord(result.controlAvailability);
  const presentationSync = controlRecord(result.presentationSync);

  return {
    input, result, action, capabilityId, optionId, operationId, itemId, target,
    capability, status, confirmed, failed,
    query: text(input.query),
    requestedValue: requestedValue(input),
    // Never substitute the requested value for an acknowledged, effective value.
    effectiveValue: result.effectiveValue,
    error: failed ? toolItem.toolResult?.error || text(result.error) || text(result.message) : undefined,
    items: records(result.items),
    totalCount: typeof result.totalCount === 'number' && Number.isFinite(result.totalCount) && result.totalCount >= 0
      ? result.totalCount : undefined,
    hasMore: result.nextCursor !== undefined && result.nextCursor !== null,
    currentValues: Object.entries(controlRecord(result.currentOptionValues)).map(([option, value]) => ({
      id: option,
      label: controlTitle(records(capability.options).find(item => item.id === option) ?? {}, language) ?? option,
      value,
    })),
    availability: text(availability.status),
    availabilityReason: text(availability.reason),
    syncPending: confirmed && ['degraded', 'notAttached'].includes(String(presentationSync.status)),
    syncReason: text(presentationSync.reason),
  };
}

export type OpenBitFunControlCardModel = ReturnType<typeof buildOpenBitFunControlCardModel>;
