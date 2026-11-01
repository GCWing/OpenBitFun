// Test the production shared provider, including its actual optional native shim.
// GTK/portal fixtures remain ignored unless explicitly selected by the caller.
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('Native provider tests require Linux.');
const root = fileURLToPath(new URL('../', import.meta.url));
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn('cargo', ['test', '--locked', '-p', 'openbitfun-computer-use', '--lib', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', reject);
  child.on('close', code => resolve(code ?? 1));
});
