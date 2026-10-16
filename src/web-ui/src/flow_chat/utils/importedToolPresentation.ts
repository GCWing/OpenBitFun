import type { FlowToolItem } from '../types/flow-chat';

type ImportedToolIdentity = Pick<FlowToolItem, 'toolName' | 'toolCall' | 'importedSource'>;
type NativeCardName = 'RunCode' | 'ExecCommand' | 'WriteStdin' | 'Read' | 'Write' | 'Edit'
  | 'Grep' | 'Glob' | 'LS' | 'WebSearch' | 'WebFetch' | 'TodoWrite' | 'view_image';

// Match contracts as well as names. Product workflow cards (approval, subagents,
// deployment, etc.) require native runtime state that foreign history cannot supply.
const nativeNames = new Map<string, NativeCardName>([
  ['runcode', 'RunCode'], ['execcommand', 'ExecCommand'], ['writestdin', 'WriteStdin'],
  ['bash', 'ExecCommand'], ['read', 'Read'], ['write', 'Write'], ['edit', 'Edit'],
  ['grep', 'Grep'], ['glob', 'Glob'], ['ls', 'LS'], ['websearch', 'WebSearch'],
  ['webfetch', 'WebFetch'], ['todowrite', 'TodoWrite'], ['view_image', 'view_image'],
]);
const codexAliases = new Map<string, NativeCardName>([
  ['exec', 'RunCode'], ['exec_command', 'ExecCommand'], ['shell_command', 'ExecCommand'],
  ['shell', 'ExecCommand'], ['write_stdin', 'WriteStdin'], ['update_plan', 'TodoWrite'],
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return record(value);
}

/** Text blocks become readable text; unknown blocks remain visible as JSON. */
export function importedToolOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(importedToolOutput).join('\n\n');
  const block = record(value);
  if (['text', 'input_text', 'output_text'].includes(String(block.type))
    && typeof block.text === 'string') return block.text;
  if (Array.isArray(block.content)) return importedToolOutput(block.content);
  if (typeof block.output === 'string') return block.output;
  if (typeof block.stdout === 'string' || typeof block.stderr === 'string') {
    return [text(block.stdout), text(block.stderr)].filter(Boolean).join('\n');
  }
  return JSON.stringify(value, null, 2);
}

/** Undefined means use DefaultToolCard, even if an unrelated native name collides. */
export function importedToolCardName(item: ImportedToolIdentity): NativeCardName | undefined {
  if (!item.importedSource) return undefined;
  const name = item.importedSource === 'codex' ? item.toolName.replace(/^functions\./, '') : item.toolName;
  if (item.importedSource === 'codex') {
    const alias = codexAliases.get(name);
    if (alias) return alias;
    if (name === 'web.run' || name === 'web__run') {
      const input = inputRecord(item.toolCall?.input);
      // web.run also handles finance, images, weather, navigation, etc.; only
      // an actual search belongs in the existing WebSearch card.
      if (Array.isArray(input.search_query) && input.search_query.length > 0
        && input.search_query.every(query => typeof record(query).q === 'string')
        && Object.keys(input).every(key => key === 'search_query' || key === 'response_length')) return 'WebSearch';
      return undefined;
    }
  }
  return nativeNames.get(name.toLowerCase());
}

export function importedToolDisplayName(item: ImportedToolIdentity): string {
  return importedToolCardName(item) ?? item.toolName;
}

function processResult(raw: unknown): Record<string, unknown> {
  const parsed = inputRecord(raw);
  return ['output', 'stdout', 'stderr', 'exit_code', 'wall_time_seconds', 'session_id']
    .some(key => key in parsed) ? parsed : {};
}

const projections = new WeakMap<FlowToolItem, FlowToolItem>();

/** Display-only conversion to existing card contracts. Never persist this clone. */
export function projectImportedToolItem(item: FlowToolItem): FlowToolItem {
  if (!item.importedSource) return item;
  const cached = projections.get(item);
  if (cached) return cached;
  const card = importedToolCardName(item);
  const rawInput: unknown = item.toolCall?.input;
  const input = inputRecord(rawInput);
  const rawResult: unknown = item.toolResult?.result;
  const isProcess = card === 'ExecCommand' || card === 'WriteStdin';
  const result = isProcess ? processResult(rawResult) : record(rawResult);
  let output = importedToolOutput(isProcess && Object.keys(result).length > 0 ? result : rawResult);
  let exitCode = isProcess ? finiteNumber(result.exit_code) : undefined;
  let elapsedSeconds = isProcess ? finiteNumber(result.wall_time_seconds) : undefined;
  let failed = record(rawResult).is_error === true || record(rawResult).isError === true;

  if (item.importedSource === 'codex') {
    // Inspect only known envelope headers, never error examples in program output.
    if (card === 'RunCode') failed ||= /^Script error:\r?\n/.test(output);
    const headerEnd = output.search(/\r?\n(?:Output|Final output):/);
    const header = headerEnd >= 0 ? output.slice(0, headerEnd) : '';
    const legacyProcess = /^(?:Chunk ID: [^\r\n]+\r?\n)?Wall time: [\d.]+ seconds\r?\nProcess /.test(header);
    const script = /^Script (?:completed|failed|running)\b/.test(header);
    const scriptTool = card === 'RunCode' || /^(?:functions\.)?wait$/.test(item.toolName);
    if ((isProcess && legacyProcess) || (scriptTool && script)) {
      const exit = header.match(/(?:Process exited with code|exit code[: ]+)\s*(-?\d+)/i);
      const elapsed = header.match(/^Wall time:? ([\d.]+) seconds/m);
      exitCode ??= exit ? Number(exit[1]) : undefined;
      elapsedSeconds ??= elapsed ? Number(elapsed[1]) : undefined;
      failed ||= /^Script failed\b/.test(header);
      output = output.slice(headerEnd).replace(/^\r?\n(?:Output|Final output):\r?\n?/, '');
    }
  }
  failed ||= exitCode !== undefined && exitCode !== 0;
  const status = item.status === 'completed' && (failed || item.toolResult?.success === false) ? 'error' : item.status;
  // Native failure cards consume `error` instead of their ordinary result view.
  // Keep the source's diagnostic and partial output together in that contract.
  const error = status === 'error'
    ? [...new Set([item.toolResult?.error, output].filter(Boolean))].join('\n\n') || undefined
    : item.toolResult?.error;
  const path = text(input.file_path) || text(input.path) || text(input.absolute_path);
  let nativeInput: unknown = card && Object.keys(input).length > 0 ? input : rawInput;
  let nativeResult: unknown = rawResult;
  switch (card) {
    case 'RunCode':
      nativeInput = { ...input, code: text(input.code) || text(rawInput), language: text(input.language) || 'javascript' };
      nativeResult = { ...result, output };
      break;
    case 'ExecCommand':
    case 'WriteStdin':
      nativeInput = card === 'ExecCommand' ? {
        ...input,
        cmd: text(input.cmd) || text(input.command) || (Array.isArray(input.command) ? input.command.map(String).join(' ') : ''),
      } : input;
      nativeResult = { ...result, output, exit_code: exitCode, wall_time_seconds: elapsedSeconds };
      break;
    case 'Read': case 'Write': case 'Edit':
      nativeInput = { ...input, file_path: path };
      break;
    case 'view_image':
      nativeInput = { ...input, path };
      break;
    case 'Grep':
      nativeResult = { ...result, result: typeof result.result === 'string' ? result.result : output };
      break;
    case 'Glob': case 'LS':
      nativeResult = Array.isArray(rawResult) ? rawResult : { ...result, content: text(result.content) || output };
      break;
    case 'WebSearch':
      nativeInput = { ...input, query: text(input.query) || text(input.search_term)
        || (Array.isArray(input.search_query) ? input.search_query.map(query => text(record(query).q)).join(' · ') : '') };
      nativeResult = { ...result, content: text(result.content) || output };
      break;
    case 'WebFetch':
      nativeResult = { ...result, url: text(result.url) || text(input.url), content: text(result.content) || output };
      break;
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan)
        ? input.plan.map(step => ({ content: record(step).step, status: record(step).status })) : [];
      nativeInput = { ...input, todos };
      nativeResult = { ...result, todos: Array.isArray(result.todos) ? result.todos : todos };
      break;
    }
    default:
      // Generic cards retain the complete input shape; flatten only provider text blocks.
      if (Array.isArray(rawResult) && rawResult.some(value => ['text', 'input_text', 'output_text'].includes(String(record(value).type)))) nativeResult = output;
  }

  const projected: FlowToolItem = {
    ...item, toolName: card ?? item.toolName, status,
    toolCall: { ...item.toolCall, input: nativeInput },
    toolResult: item.toolResult ? {
      ...item.toolResult, result: nativeResult, error, success: failed ? false : item.toolResult.success,
    } : undefined,
    // An old source permission must never become an actionable native permission.
    requiresConfirmation: false, acpPermission: undefined,
  };
  projections.set(item, projected);
  projections.set(projected, projected);
  return projected;
}
