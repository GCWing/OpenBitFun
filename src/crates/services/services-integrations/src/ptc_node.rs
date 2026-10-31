//! Node-specific PTC worker.

pub(super) const BOOTSTRAP: &str = r#"
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const stringify = JSON.stringify.bind(JSON);
const parse = JSON.parse.bind(JSON);
const writeRaw = process.stdout.write.bind(process.stdout);
const token = randomUUID();
const pending = new Map();
let maxOutputBytes = 8 * 1024 * 1024;
let logs = [];

function write(value) { writeRaw(`${stringify(value)}\n`); }
function log(...values) {
  logs.push(values.map((value) => typeof value === 'string' ? value : stringify(value)).join(' '));
}
function failure(message, code = 'exception') {
  const error = new Error(message);
  error.ptcCode = code;
  throw error;
}
function jsonValue(value) {
  if (value === undefined) return null;
  const encoded = stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxOutputBytes) failure('PTC result exceeds output limit', 'output_limit');
  return parse(encoded);
}
function callTool(name, argumentsValue, allowed, enforceBinding = true) {
  if (enforceBinding && !allowed.has(name)) return Promise.reject(new Error(`tool '${name}' is not available in this PTC snapshot`));
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return Promise.reject(new Error(`arguments for '${name}' must be an object`));
  }
  const operationId = randomUUID();
  write({ kind: 'tool_call', token, operationId, toolName: name, arguments: argumentsValue, enforceBinding });
  return new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
}

function getToolSpec(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return Promise.reject(new Error('getToolSpec requires a non-empty tool name'));
  }
  const operationId = randomUUID();
  write({ kind: 'get_tool_spec', token, operationId, toolName: name });
  return new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
}

async function execute(message) {
  maxOutputBytes = Number.isInteger(message.maxOutputBytes) && message.maxOutputBytes > 0
    ? message.maxOutputBytes : 8 * 1024 * 1024;
  logs = [];
  const names = new Set(Array.isArray(message.bindings) ? message.bindings.map((binding) => binding.name) : []);
  const tools = Object.create(null);
  for (const name of names) tools[name] = (args) => callTool(name, args, names);
  tools.getToolSpec = getToolSpec;
  tools.callTool = (name, args) => callTool(name, args, names, false);
  const consoleFacade = Object.freeze({
    log, info: log, warn: log, error: log, debug: log,
  });
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, URL, URLSearchParams,
    clearImmediate, clearInterval, clearTimeout, console: consoleFacade,
    queueMicrotask, setImmediate, setInterval, setTimeout, structuredClone,
  });
  const wrappedSource = `(async (tools) => {\n${message.source}\n})`;
  const source = stripTypeScriptTypes(wrappedSource, { mode: 'strip' });
  const program = new vm.Script(source, {
    filename: 'openbitfun-ptc.ts',
  }).runInContext(context);
  const value = await program(Object.freeze(tools));
  const result = jsonValue(value);
  const logBytes = Buffer.byteLength(stringify(logs), 'utf8');
  if (logBytes > maxOutputBytes) failure('PTC logs exceed output limit', 'output_limit');
  return { value: result, logs };
}

write({ kind: 'ready', token });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try { message = parse(line); } catch { process.exit(1); return; }
  if (message.type === 'tool_result') {
    const call = pending.get(message.operationId);
    if (!call) return;
    pending.delete(message.operationId);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(message.error || 'nested tool call failed'));
    return;
  }
  if (message.type !== 'execute') return;
  void execute(message).then(
    (result) => write({ kind: 'complete', token, id: message.id, ok: true, result }),
    (error) => write({
      kind: 'complete', token, id: message.id, ok: false,
      errorKind: error?.ptcCode || 'exception',
      error: error instanceof Error ? error.message.slice(0, 4096) : 'PTC execution failed',
    }),
  );
});
"#;
