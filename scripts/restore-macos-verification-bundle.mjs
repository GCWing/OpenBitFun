import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function planMacVerificationRecovery(repository, tag, platform, { run, jobs, artifacts }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag) ||
      !['macos-arm64', 'macos-x64'].includes(platform) || !/^\d+$/.test(String(run.id)) ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.path !== '.github/workflows/desktop-package.yml' ||
      !['workflow_dispatch', 'release'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      !jobs.some((job) => job.name === 'Prepare' && job.conclusion === 'success')) {
    throw new Error('Untrusted macOS verification recovery source');
  }
  const producer = jobs.find((job) => job.name === `Package (${platform})` && job.conclusion === 'failure');
  const passed = (name) => producer?.steps?.some((step) => step.name === name && step.conclusion === 'success');
  if (producer?.conclusion !== 'failure' ||
      !(passed('Build desktop app') || (passed('Restore prior macOS bundles') && passed('Repair missing application ticket'))) ||
      !producer.steps.some((step) => step.name === 'Verify Apple signature and notarization' && step.conclusion === 'failure') ||
      producer.steps.some((step) => step.conclusion === 'failure' && step.name !== 'Verify Apple signature and notarization') ||
      !passed('Upload macOS verification recovery bundles')) {
    throw new Error('Recovery requires a built package that failed only Apple verification');
  }
  const name = `openbitfun-${tag}-${platform}-verification-recovery`;
  const matches = artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1 || matches[0].expired !== false) throw new Error('Missing, duplicate, or expired recovery artifact');
  return { runId: String(run.id), name, head: run.head_sha };
}

function command(program, args, inherit = false) {
  return execFileSync(program, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
  const repository = option('--repo'), tag = option('--tag'), platform = option('--platform'), runId = option('--run-id');
  if (!/^\d+$/.test(runId || '') || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') ||
      !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag || '') || !['macos-arm64', 'macos-x64'].includes(platform)) {
    throw new Error('Expected repository, release tag, Mac platform, and numeric recovery run ID');
  }
  const api = (suffix) => JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${runId}${suffix}`]));
  const plan = planMacVerificationRecovery(repository, tag, platform, {
    run: api(''), jobs: api('/jobs?per_page=100').jobs, artifacts: api('/artifacts?per_page=100').artifacts,
  });
  command('git', ['fetch', 'origin', 'main', '--tags']);
  command('git', ['merge-base', '--is-ancestor', plan.head, 'origin/main']);
  command('git', ['merge-base', '--is-ancestor', `${tag}^{commit}`, plan.head]);
  const target = platform === 'macos-x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
  const output = path.resolve('target', target, 'release');
  if (fs.existsSync(path.join(output, 'bundle'))) throw new Error('Refusing to overwrite existing bundles');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openbitfun-macos-recovery-'));
  try {
    command('gh', ['run', 'download', plan.runId, '--repo', repository, '--name', plan.name, '--dir', temporary], true);
    const archive = path.join(temporary, 'macos-verification-recovery.tar.gz');
    const entries = command('tar', ['-tzf', archive]).trim().split('\n');
    if (!entries.length || entries.some((entry) =>
      (entry !== 'bundle' && !entry.startsWith('bundle/')) || entry.split('/').includes('..'))) {
      throw new Error('Recovery archive must contain only bundle-relative paths');
    }
    fs.mkdirSync(output, { recursive: true });
    // The system tar retains modes and links and refuses extraction through unsafe links.
    command('tar', ['-xzf', archive, '-C', output], true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
