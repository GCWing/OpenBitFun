import type { FlowToolItem } from '../types/flow-chat';
import { getToolCardStatus } from './toolCardStatus';
import { runtimeToolRecord, runtimeToolText, runtimeToolValue } from './runtimeToolCardModel';
import { getBuiltinToolAttention, getBuiltinToolInput, type SemanticBuiltinToolName } from './builtinToolCardPolicy';
import { buildBuiltinContextCard } from './builtinContextCardModel';
import { buildBuiltinWorkflowCard } from './builtinWorkflowCardModel';

export type BuiltinCardFamily = 'goal' | 'agent-roster' | 'session-history' | 'image-analysis' | 'time'
  | 'mcp-resource' | 'worktree' | 'port-forward' | 'review-platform' | 'frontend-workbench'
  | 'miniapp-finalize' | 'marketplace-publish' | 'playbook';
export type BuiltinCardTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type BuiltinTranslate = (key: string, params?: Record<string, unknown>) => string;
export interface BuiltinCardField { label: string; value: string; links?: BuiltinCardLink[] }
export interface BuiltinCardSection { key: string; label: string; content: string; variant?: 'code' | 'prose' }
export interface BuiltinCardLink { kind: 'url' | 'file' | 'copy-path' | 'session' | 'miniapp' | 'market' | 'review'; value: string; label: string; intent?: 'primary' }
export interface BuiltinCardRecord {
  key: string;
  title: string;
  description?: string;
  state?: string;
  fields?: BuiltinCardField[];
  agentId?: string;
  links?: BuiltinCardLink[];
}
export interface BuiltinCardModel {
  name: SemanticBuiltinToolName;
  family: BuiltinCardFamily;
  status: FlowToolItem['status'];
  attention: 'ambient' | 'prominent';
  action: string;
  summary?: string;
  resultSummary?: string;
  outcome?: { label: string; tone: BuiltinCardTone };
  fields: BuiltinCardField[];
  sections: BuiltinCardSection[];
  records: BuiltinCardRecord[];
  recordsLabel: string;
  links: BuiltinCardLink[];
  ordered?: boolean;
  emptyContent?: string;
  notice?: string;
  error?: string;
  connection?: { from: string; to: string };
  sourcePath?: string;
  imageSources: string[];
  input: Record<string, unknown>;
  data: Record<string, unknown>;
  rawResult: unknown;
}

const SECRET_KEY = /^(?:token|(?:access|refresh|auth|private)[_-]?token|api[_-]?key|password|passwd|secret|client[_-]?secret|authorization|cookie|set-cookie)$/i;
const BINARY_KEY = /^(?:blob|data_base64|image_base64|screenshot_base64|data_url)$/i;

const OPERATION_KEYS: Partial<Record<SemanticBuiltinToolName, readonly string[]>> = {
  Worktree: ['list', 'create_session', 'create_branch', 'remove'],
  PortForward: ['targets', 'detect', 'start', 'list', 'stop'],
  FrontendWorkbench: ['prepare', 'status', 'inspect', 'invoke', 'apply', 'rollback'],
  ReviewPlatform: ['get_workspace_snapshot', 'list_remotes', 'list_pull_requests', 'count_pull_requests',
    'get_pull_request', 'get_pull_request_detail_page', 'get_pull_request_ci_log', 'create_pull_request',
    'reply_to_thread', 'submit_review', 'approve_pull_request', 'revoke_approval', 'request_changes',
    'resolve_thread', 'update_auth_token', 'clear_auth_token'],
  Playbook: ['list', 'run'],
};

/** Redact known credentials even if a service echoed them into an error or nested JSON string. */
export function redactBuiltinToolValue(value: unknown, input: unknown, replacement: string): unknown {
  const secrets: string[] = [];
  const collect = (entry: unknown) => {
    entry = runtimeToolValue(entry);
    if (Array.isArray(entry)) { entry.forEach(collect); return; }
    if (!entry || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (SECRET_KEY.test(key) && typeof child === 'string' && child) secrets.push(child);
      else collect(child);
    }
  };
  collect(runtimeToolValue(input));
  const redact = (entry: unknown, key = ''): unknown => {
    if (SECRET_KEY.test(key)) return replacement;
    if (key.startsWith('_') || BINARY_KEY.test(key)) return undefined;
    if (typeof entry === 'string') {
      const parsed = runtimeToolValue(entry);
      if (parsed !== entry && parsed !== null && typeof parsed === 'object') return redact(parsed);
      return secrets.reduce((text, secret) => text.split(secret).join(replacement), entry);
    }
    if (Array.isArray(entry)) return entry.map(child => redact(child));
    if (entry && typeof entry === 'object') {
      const binaryContent = ['image', 'audio'].includes(String((entry as Record<string, unknown>).type));
      return Object.fromEntries(Object.entries(entry)
        .filter(([name]) => !(binaryContent && name === 'data'))
        .map(([name, child]) => [name, redact(child, name)]).filter(([, child]) => child !== undefined));
    }
    return entry;
  };
  return redact(value);
}

export function builtinText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = runtimeToolText(value);
    if (text) return text;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}
export function builtinRecords(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))
    ? value.map(runtimeToolRecord) : undefined;
}
export function builtinBasename(value?: string): string | undefined {
  return value?.split(/[\\/]/).filter(Boolean).at(-1) || value;
}
export function builtinSafeUrl(value: unknown): string | undefined {
  const text = runtimeToolText(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

const STATE_KEYS: Record<string, string> = {
  active: 'active', running: 'running', completed: 'complete', complete: 'complete', paused: 'paused', blocked: 'blocked',
  usageLimited: 'usageLimited', budgetLimited: 'budgetLimited', queued: 'queued', waiting: 'waiting',
  failed: 'failed', error: 'failed', cancelled: 'cancelled', canceled: 'cancelled', interrupted: 'interrupted', partial_timeout: 'partialTimeout',
  submitted: 'submitted', pending_review: 'pendingReview', sign_in_required: 'signIn', needs_auth: 'signIn',
  confirmed: 'confirmed', rolled_back: 'rolledBack', prepared: 'prepared', ready: 'ready',
  awaiting_confirmation: 'awaitingConfirmation', awaiting_candidate_ready: 'awaitingReady',
  loading_candidate: 'awaitingReady', idle: 'idle', managed: 'managed', permanent: 'permanent', external: 'external',
  deleted: 'deleted', open: 'open', closed: 'closed', merged: 'merged', draft: 'draft',
};
export function builtinState(value: unknown, t: BuiltinTranslate): string | undefined {
  const state = runtimeToolText(value);
  if (!state) return undefined;
  return Object.prototype.hasOwnProperty.call(STATE_KEYS, state) ? t(`toolCards.builtin.states.${STATE_KEYS[state]}`) : state;
}

export interface BuiltinCardContext {
  model: BuiltinCardModel;
  input: Record<string, unknown>;
  data: Record<string, unknown>;
  done: boolean;
  t: BuiltinTranslate;
  number: (value: number) => string;
  field: (key: string, value: unknown, target?: BuiltinCardField[]) => void;
  section: (key: string, value: unknown, variant?: 'code' | 'prose') => void;
  outcome: (key: string, tone?: BuiltinCardTone) => void;
  operation: (operation: unknown) => void;
  list: (rows: BuiltinCardRecord[] | undefined) => void;
  link: (kind: BuiltinCardLink['kind'], value: unknown, label: string, target?: BuiltinCardLink[], intent?: 'primary') => void;
}

const FAMILIES: Record<SemanticBuiltinToolName, BuiltinCardFamily> = {
  get_goal: 'goal', create_goal: 'goal', update_goal: 'goal', AgentList: 'agent-roster', AgentDelete: 'agent-roster',
  SessionHistory: 'session-history', analyze_image: 'image-analysis', GetTime: 'time',
  ListMCPResources: 'mcp-resource', ReadMCPResource: 'mcp-resource', ListMCPPrompts: 'mcp-resource', GetMCPPrompt: 'mcp-resource',
  Worktree: 'worktree', PortForward: 'port-forward', ReviewPlatform: 'review-platform', FrontendWorkbench: 'frontend-workbench',
  FinalizeMiniApp: 'miniapp-finalize', PublishMiniApp: 'marketplace-publish', PublishAppearance: 'marketplace-publish', Playbook: 'playbook',
};

export function buildBuiltinToolCardModel(item: FlowToolItem, name: SemanticBuiltinToolName,
  t: BuiltinTranslate, number: (value: number) => string): BuiltinCardModel {
  const originalInput = getBuiltinToolInput(item);
  const redacted = t('toolCards.builtin.redacted');
  const clean = (value: unknown) => redactBuiltinToolValue(value, originalInput, redacted);
  const input = runtimeToolRecord(clean(originalInput));
  const rawResult = clean(runtimeToolValue(item.toolResult?.result));
  let data = runtimeToolRecord(rawResult);
  let failed = false;
  let error = runtimeToolText(clean(item.toolResult?.error));
  for (let depth = 0; depth < 4; depth++) {
    failed ||= data.success === false || data.ok === false || data.isError === true;
    error ??= builtinText(runtimeToolRecord(data.error).message, data.error);
    if (typeof data.ok !== 'boolean' || !Object.prototype.hasOwnProperty.call(data, 'data')) break;
    data = runtimeToolRecord(data.data);
  }
  const resultEnvelope = runtimeToolRecord(data.result);
  failed ||= resultEnvelope.success === false || resultEnvelope.ok === false;
  error ??= builtinText(runtimeToolRecord(resultEnvelope.error).message, resultEnvelope.error);
  const status = getToolCardStatus(item, failed);
  const model: BuiltinCardModel = {
    name, family: FAMILIES[name], status, attention: getBuiltinToolAttention(name, input),
    action: t(`toolCards.builtin.tools.${name}`), fields: [], sections: [], records: [], links: [],
    recordsLabel: t('toolCards.builtin.fields.results'), input, data, rawResult,
    error: status === 'error' ? error ?? t('toolCards.default.failed') : error,
    imageSources: (item.toolResult?.imageAttachments ?? []).filter(image =>
      /^image\/(png|jpeg|webp|gif)$/.test(image.mime_type) && Boolean(image.data_base64))
      .map(image => `data:${image.mime_type};base64,${image.data_base64}`),
  };
  const done = status === 'completed';
  const context: BuiltinCardContext = {
    model, input, data, done, t, number,
    field(key, value, target = model.fields) {
      const text = typeof value === 'number' && Number.isFinite(value) ? number(value)
        : typeof value === 'boolean' ? t(value ? 'toolCards.builtin.yes' : 'toolCards.builtin.no') : runtimeToolText(value);
      if (text !== undefined) target.push({ label: t(`toolCards.builtin.fields.${key}`), value: text });
    },
    section(key, value, variant = 'prose') {
      const text = runtimeToolText(value);
      if (text) model.sections.push({ key: `${key}:${model.sections.length}`, label: t(`toolCards.builtin.fields.${key}`), content: String(value), variant });
    },
    outcome(key, tone = 'neutral') { if (done) model.outcome = { label: t(`toolCards.builtin.states.${key}`), tone }; },
    operation(value) {
      const key = runtimeToolText(value);
      // The operation maps are explicit so unknown/new actions retain their original identity.
      const known = OPERATION_KEYS[name]?.includes(key ?? '');
      if (key) model.action = known ? t(`toolCards.builtin.operations.${key}`) : `${model.action} · ${key}`;
    },
    list(rows) {
      if (rows === undefined) return;
      model.records = rows;
      if (done) {
        model.resultSummary = t('toolCards.builtin.count', { value: number(rows.length) });
        if (rows.length === 0) model.emptyContent = t('toolCards.builtin.empty');
      }
    },
    link(kind, value, label, target = model.links, intent) {
      const text = kind === 'url' ? builtinSafeUrl(value) : runtimeToolText(value);
      if (text) target.push({ kind, value: text, label: t(`toolCards.builtin.links.${label}`), ...(intent ? { intent } : {}) });
    },
  };
  if (!buildBuiltinContextCard(context)) buildBuiltinWorkflowCard(context);
  if (model.sections.length === 0 && typeof rawResult === 'string') context.section('results', rawResult);
  return model;
}
