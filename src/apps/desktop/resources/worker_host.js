#!/usr/bin/env node
/**
 * MiniApp JS Worker host — runs in Bun or Node.js.
 * stdin: JSON-RPC requests (one per line)
 * stderr: JSON-RPC responses (one per line)
 * stdout: user console.log (forwarded to host)
 *
 * Usage: node worker_host.js '<policy_json>'
 * Cwd: MiniApp app directory (contains source/worker.js, package.json, storage.json)
 */

const fs = require('fs');
const path = require('path');
const { exec: execCallback } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(execCallback);

const policy = JSON.parse(process.argv[2] || '{}');
const appDir = process.cwd();
const storageRequests = new Map();
let storageRequestId = 0;

function rpcSend(obj) {
  process.stderr.write(JSON.stringify(obj) + '\n');
}

/**
 * Emit a push event to the MiniApp iframe (no request id, no reply expected).
 * The host process will forward this to the iframe via "miniapp://worker-event:{appId}".
 *
 * @param {string} event - Event name (e.g. 'progress', 'status')
 * @param {any} data - Event payload
 */
function rpcEmit(event, data) {
  process.stderr.write(JSON.stringify({ event, data }) + '\n');
}

// Make rpcEmit available globally so source/worker.js can use it.
global.rpcEmit = rpcEmit;

function isPathAllowed(targetPath, mode) {
  if (!policy.fs) return false;
  const resolved = path.resolve(targetPath);
  const scopes = mode === 'write' ? (policy.fs.write || []) : (policy.fs.read || []);
  return scopes.some((scope) => resolved.startsWith(path.resolve(scope)));
}

function storageCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'storage-' + (++storageRequestId);
    storageRequests.set(id, { resolve, reject });
    rpcSend({ hostRequest: 'storage', id, method, params });
  });
}

let userHandlers = {};
let userHandlerLoadError = null;
try {
  const workerPath = path.join(appDir, 'source', 'worker.js');
  if (fs.existsSync(workerPath)) {
    userHandlers = require(workerPath) || {};
  }
} catch (e) {
  userHandlerLoadError = e;
  console.error('Failed to load source/worker.js:', e.message);
}

async function dispatch(method, params) {
  if (userHandlerLoadError) {
    throw new Error('Failed to load source/worker.js: ' + (userHandlerLoadError.message || String(userHandlerLoadError)));
  }
  if (userHandlers[method] && typeof userHandlers[method] === 'function') {
    return await userHandlers[method](params || {});
  }

  const [ns, name] = method.split('.');
  if (ns === 'fs') {
    const p = params.path || params.p;
    if (p !== undefined && !isPathAllowed(p, 'read') && name !== 'access') {
      if (name === 'writeFile' || name === 'mkdir' || name === 'rm' || name === 'appendFile' || name === 'rename' || name === 'copyFile') {
        if (!isPathAllowed(p, 'write')) throw new Error('Path not allowed');
      } else if (!isPathAllowed(p, 'read')) throw new Error('Path not allowed');
    }
    switch (name) {
      case 'readFile': {
        const enc = params.encoding || 'utf8';
        const data = fs.readFileSync(p, enc === 'base64' ? undefined : enc);
        return enc === 'base64' ? data.toString('base64') : data;
      }
      case 'writeFile':
        fs.writeFileSync(p, params.data, params.encoding || 'utf8');
        return null;
      case 'readdir': {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }));
      }
      case 'stat': {
        const s = fs.statSync(p);
        return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile() };
      }
      case 'mkdir':
        fs.mkdirSync(p, { recursive: !!params.recursive });
        return null;
      case 'rm':
        fs.rmSync(p, { recursive: !!params.recursive, force: !!params.force });
        return null;
      case 'copyFile':
        fs.copyFileSync(params.src, params.dst);
        return null;
      case 'rename':
        fs.renameSync(params.oldPath, params.newPath);
        return null;
      case 'appendFile':
        fs.appendFileSync(p, params.data);
        return null;
      case 'access':
        fs.accessSync(p);
        return null;
      default:
        throw new Error('Unknown fs method: ' + method);
    }
  }

  if (ns === 'shell') {
    if (name === 'exec') {
      const allow = (policy.shell && policy.shell.allow) || [];
      const cmd = (params.command || '').trim().split(/\s+/)[0];
      const base = path.basename(cmd, path.extname(cmd));
      if (allow.length === 0 || !allow.some((a) => a.toLowerCase() === base.toLowerCase())) {
        throw new Error('Command not in allowlist');
      }
      const opts = {
        cwd: params.cwd || appDir,
        timeout: params.timeout || 30000,
        windowsHide: process.platform === 'win32'
      };
      const { stdout, stderr } = await execAsync(params.command || '', opts);
      return { stdout, stderr, exit_code: 0 };
    }
  }

  if (ns === 'net' && name === 'fetch') {
    const allow = (policy.net && policy.net.allow) || [];
    let url;
    try {
      url = new URL(params.url);
    } catch {
      throw new Error('Invalid URL');
    }
    const host = url.hostname;
    if (allow.length === 0 || (!allow.includes('*') && !allow.some((d) => host === d || host.endsWith('.' + d)))) {
      throw new Error('Domain not in allowlist');
    }
    const fetch = globalThis.fetch;
    const res = await fetch(params.url, { method: params.method || 'GET', headers: params.headers, body: params.body });
    const body = await res.text();
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    return { status: res.status, headers, body };
  }

  if (ns === 'os' && name === 'info') {
    const os = require('os');
    return { platform: process.platform, homedir: os.homedir(), tmpdir: os.tmpdir(), cpus: os.cpus().length, totalmem: os.totalmem(), freemem: os.freemem() };
  }

  if (ns === 'storage') {
    if (name === 'get' || name === 'set') return storageCall(method, params);
  }

  throw new Error('Unknown method: ' + method);
}

rpcSend({ id: '__ready', result: { pid: process.pid, version: process.version } });

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => process.exit(0));
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg.hostResponse === 'string') {
    const pending = storageRequests.get(msg.hostResponse);
    if (!pending) return;
    storageRequests.delete(msg.hostResponse);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
    return;
  }
  const { id, method, params } = msg;
  if (!id || !method) return;
  try {
    const result = await dispatch(method, params || {});
    rpcSend({ id, result });
  } catch (err) {
    rpcSend({ id, error: { code: -32603, message: err.message || String(err) } });
  }
});
