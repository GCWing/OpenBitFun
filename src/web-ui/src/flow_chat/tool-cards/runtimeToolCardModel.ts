import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { getToolCardStatus } from './toolCardStatus';

type ToolRecord = Record<string, unknown>;

export function runtimeToolValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function runtimeToolRecord(value: unknown): ToolRecord {
  const parsed = runtimeToolValue(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ToolRecord : {};
}

export function runtimeToolText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function getRuntimeToolInput(item: FlowToolItem): ToolRecord {
  const effective = projectEffectiveToolItem(item);
  const input = runtimeToolRecord(effective.toolCall?.input);
  const partial = runtimeToolRecord(effective.partialParams);
  const params = partial.tool_name === effective.toolName ? runtimeToolRecord(partial.args) : partial;
  return effective.isParamsStreaming ? { ...input, ...params }
    : Object.keys(input).length > 0 ? input : params;
}

export function getControlHubInput(item: FlowToolItem): ToolRecord {
  const result = runtimeToolRecord(item.toolResult?.result);
  return { domain: result.domain, action: result.action, ...getRuntimeToolInput(item) };
}

const BROWSER_OBSERVATION_ACTIONS = new Set([
  'snapshot', 'get', 'get_text', 'get_url', 'get_title', 'get_html', 'screenshot',
  'read_article', 'list_pages', 'tab_query', 'list_sessions', 'wait', 'cookies',
]);

/** Unknown actions and script/protocol execution remain consequential. No action is replayed here. */
export function isControlHubObservation(input: unknown): boolean {
  const request = runtimeToolRecord(input);
  if (request.domain === 'meta') return request.action === 'capabilities' || request.action === 'route_hint';
  if (request.domain === 'terminal') return request.action === 'list_sessions';
  return request.domain === 'browser' && BROWSER_OBSERVATION_ACTIONS.has(String(request.action ?? ''));
}

/** Keep internal fields and binary image bytes out of textual detail disclosures. */
export function formatRuntimeToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return value === null ? 'null' : undefined;
  if (typeof value === 'string') return value || undefined;
  try {
    return JSON.stringify(value, (key, entry: unknown) => (
      key.startsWith('_') || ['data_base64', 'image_base64', 'screenshot_base64'].includes(key) ? undefined : entry
    ), 2);
  } catch { return String(value); }
}

export function runtimeToolNeedsConfirmation(item: FlowToolItem, status: FlowToolItem['status']): boolean {
  return status === 'pending_confirmation' || Boolean(item.requiresConfirmation && !item.userConfirmed
    && !['completed', 'error', 'cancelled', 'rejected'].includes(status));
}

export function buildListModelsCardModel(item: FlowToolItem) {
  const input = getRuntimeToolInput(item);
  const result = runtimeToolRecord(item.toolResult?.result);
  const rows = Array.isArray(result.models) ? result.models : undefined;
  const models = (rows ?? []).flatMap((row, index) => {
    const record = runtimeToolRecord(row);
    const id = runtimeToolText(record.model_id);
    const name = runtimeToolText(record.model_name) ?? id;
    if (!name) return [];
    return [{ key: `${id ?? name}:${index}`, name, id, provider: runtimeToolText(record.provider_name) }];
  });
  const status = getToolCardStatus(item, result.success === false);
  return {
    status, models,
    query: runtimeToolText(input.query) ?? runtimeToolText(result.query),
    hasModelList: rows !== undefined && models.length === rows.length,
    empty: status === 'completed' && rows?.length === 0,
    // Unrecognized historical results stay readable instead of appearing as an empty catalog.
    fallback: rows === undefined || models.length !== rows.length ? item.toolResult?.result : undefined,
    error: item.toolResult?.error ?? runtimeToolText(runtimeToolRecord(result.error).message) ?? runtimeToolText(result.error),
  };
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : [];
}

function capabilityRow(domain: string, target: string | undefined, value: unknown) {
  const record = runtimeToolRecord(value);
  return { key: target ? `${domain}.${target}` : domain, domain, target,
    available: typeof record.available === 'boolean' ? record.available : undefined,
    sessionCount: typeof record.session_count === 'number' ? record.session_count : undefined,
    reason: runtimeToolText(record.reason) };
}

export function buildControlHubCardModel(item: FlowToolItem) {
  const input = getControlHubInput(item);
  const params = runtimeToolRecord(input.params);
  let payload = runtimeToolValue(item.toolResult?.result);
  let result = runtimeToolRecord(payload);
  const summary = runtimeToolText(result.summary) ?? runtimeToolText(item.toolResult?.resultForAssistant);
  const notices: string[] = [];
  let failed = false;
  let error: string | undefined = item.toolResult?.error;
  let errorCode: string | undefined;
  // Older sessions can contain an extra success envelope around a structured failure.
  for (let depth = 0; depth < 4; depth++) {
    result = runtimeToolRecord(payload);
    failed ||= result.ok === false || result.success === false;
    const resultError = runtimeToolRecord(result.error);
    error ??= runtimeToolText(resultError.message) ?? runtimeToolText(result.error);
    errorCode ??= runtimeToolText(resultError.code);
    notices.push(...textArray(result.warnings), ...textArray(resultError.hints));
    if (typeof result.ok !== 'boolean' || !Object.prototype.hasOwnProperty.call(result, 'data')) break;
    payload = runtimeToolValue(result.data);
  }
  const data = runtimeToolRecord(payload);
  const status = getToolCardStatus(item, failed);
  const domain = runtimeToolText(input.domain) ?? '';
  const action = runtimeToolText(input.action) ?? '';
  const target = runtimeToolText(params.url) ?? runtimeToolText(params.selector) ?? runtimeToolText(params.ref)
    ?? runtimeToolText(params.target_title) ?? runtimeToolText(params.target_url)
    ?? runtimeToolText(params.terminal_session_id) ?? runtimeToolText(params.session_id)
    ?? runtimeToolText(params.intent) ?? runtimeToolText(data.title) ?? runtimeToolText(data.url);
  const rawRecords = Array.isArray(data.pages) ? data.pages : Array.isArray(data.sessions) ? data.sessions : undefined;
  const records = rawRecords?.map((entry, index) => {
    const record = runtimeToolRecord(entry);
    const id = runtimeToolText(record.id) ?? runtimeToolText(record.session_id) ?? runtimeToolText(record.terminal_session_id)
      ?? runtimeToolText(entry);
    return { key: `${id ?? 'record'}:${index}`, id,
      title: runtimeToolText(record.title) ?? runtimeToolText(record.name) ?? id,
      description: runtimeToolText(record.url) ?? runtimeToolText(record.cwd),
      status: runtimeToolText(record.status),
    };
  }).filter(record => record.title !== undefined) ?? [];
  const textKey = ['snapshot', 'text', 'content', 'html', 'article'].find(key => runtimeToolText(data[key]));
  const resultText = textKey ? data[textKey] as string : undefined;
  // Plain text gets a reader; structured/unknown payloads retain the complete JSON evidence.
  const metadataKeys = ['success', 'action', 'url', 'title', 'session_id', 'terminal_session_id', 'target', 'selector', 'ref', 'ms'];
  const metadataOnly = Object.keys(data).length > 0 && Object.keys(data).every(key => metadataKeys.includes(key));
  const output = resultText ?? (typeof payload === 'string' ? payload : metadataOnly ? summary : undefined);
  const hasRecordList = rawRecords !== undefined && rawRecords.length === records.length;
  const images = (item.toolResult?.imageAttachments ?? []).filter(image =>
    /^image\/(png|jpeg|webp|gif)$/.test(image.mime_type) && Boolean(image.data_base64));
  const capabilities = domain === 'meta' && action === 'capabilities'
    ? Object.entries(runtimeToolRecord(data.domains)).flatMap(([name, value]) => {
      const capability = runtimeToolRecord(value);
      const targets = Object.entries(runtimeToolRecord(capability.targets));
      return [capabilityRow(name, undefined, capability),
        ...targets.map(([target, targetValue]) => capabilityRow(name, target, targetValue))];
    }) : [];
  const route = domain === 'meta' && action === 'route_hint' && runtimeToolText(data.suggested_domain)
    ? { domain: runtimeToolText(data.suggested_domain), tool: runtimeToolText(data.suggested_tool), action: runtimeToolText(data.suggested_action) }
    : undefined;
  return {
    input, params, data, domain, action, target, records, hasRecordList, output, images,
    capabilities, route,
    outputIsCode: textKey === 'snapshot' || textKey === 'html',
    status, attention: isControlHubObservation(input) ? 'ambient' as const : 'prominent' as const,
    error, errorCode, notices: [...new Set(notices)],
    // An error envelope already has a semantic presentation above.
    fallback: !output && !hasRecordList && !Object.prototype.hasOwnProperty.call(data, 'error') ? payload : undefined,
  };
}
