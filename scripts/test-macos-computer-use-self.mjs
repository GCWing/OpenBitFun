// The target is a disposable native window owned by the ComputerUse host itself.
// An external watchdog also catches deadlocks that stop the main run loop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Self WebView fixture requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} failed: code=${code} signal=${signal}`)));
});
const args = ['test', '--locked', '-p', 'openbitfun-desktop', '--features', 'devtools', '--test', 'computer_use_native_roundtrip'];
let executable = process.env.OPENBITFUN_TEST_BINARY;
if (!executable) {
  const output = await run('cargo', [...args, '--no-run', '--message-format=json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  executable = output.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(record => record.target?.name === 'computer_use_native_roundtrip' && record.executable)?.executable;
  assert.ok(executable, 'Cargo must report the native harness executable');
}
await run(executable, [], {
  env: { ...process.env, OPENBITFUN_CUA_SELF_TEST: '1' },
  timeout: 60_000,
  killSignal: 'SIGKILL',
});
