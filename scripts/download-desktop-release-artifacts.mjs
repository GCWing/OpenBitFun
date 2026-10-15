import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Recovery runs must satisfy the same complete producer set as a normal run.
export function planReleaseArtifactDownloads(repository, tag, runs) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag)) {
    throw new Error('Invalid release repository or tag');
  }
  const expected = [
    ...['windows-x64', 'linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64'].map((platform) => ({
      name: `openbitfun-${tag}-${platform}-bundle`,
      job: `Package (${platform})`, directory: `release-assets/${platform}`,
    })),
    ...['linux-x64', 'linux-arm64'].map((platform) => ({
      name: `openbitfun-linux-${tag}-${platform}`,
      job: `Linux CLI and Relay Server / Linux Binaries (${platform})`, directory: 'linux-release-assets',
    })),
    { name: `openbitfun-relay-image-${tag}`, job: 'Publish Relay Server Image', directory: 'relay-image-assets' },
  ];
  const found = new Map();
  for (const { run, jobs, artifacts } of runs) {
    if (!/^\d+$/.test(String(run.id)) || run.repository?.full_name !== repository ||
        run.head_repository?.full_name !== repository ||
        run.path !== '.github/workflows/desktop-package.yml' ||
        !['workflow_dispatch', 'release'].includes(run.event) ||
        !/^[a-f0-9]{40}$/.test(run.head_sha) ||
        !jobs.some((job) => job.name === 'Prepare' && job.conclusion === 'success')) {
      throw new Error(`Untrusted or unprepared Desktop Package run: ${run.id}`);
    }
    for (const item of expected) {
      const artifact = artifacts.find((entry) => entry.name === item.name);
      if (!artifact) continue;
      if (artifact.expired !== false || !jobs.some((job) => job.name === item.job && job.conclusion === 'success')) {
        throw new Error(`Artifact lacks a successful producer: ${item.name}`);
      }
      if (found.has(item.name)) throw new Error(`Duplicate release artifact: ${item.name}`);
      found.set(item.name, { ...item, runId: String(run.id) });
    }
  }
  const missing = expected.filter((item) => !found.has(item.name));
  if (missing.length) throw new Error(`Missing verified release artifacts: ${missing.map((item) => item.name).join(', ')}`);
  return expected.map((item) => found.get(item.name));
}

function command(program, args, inherit = false) {
  return execFileSync(program, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const repository = option('--repo');
  const tag = option('--tag');
  const runIds = option('--run-ids');
  if (!/^\d+(,\d+)*$/.test(runIds || '') || !repository || !tag) {
    throw new Error('Usage: --repo OWNER/REPO --tag TAG --run-ids RUN[,RUN]');
  }
  const api = (endpoint) => JSON.parse(command('gh', ['api', `repos/${repository}/${endpoint}`]));
  const runs = runIds.split(',').map((id) => ({
    run: api(`actions/runs/${id}`),
    jobs: api(`actions/runs/${id}/jobs?per_page=100`).jobs,
    artifacts: api(`actions/runs/${id}/artifacts?per_page=100`).artifacts,
  }));
  const plan = planReleaseArtifactDownloads(repository, tag, runs);
  command('git', ['fetch', 'origin', 'main', '--tags']);
  command('git', ['merge-base', '--is-ancestor', `${tag}^{commit}`, 'origin/main']);
  for (const { run } of runs) {
    command('git', ['merge-base', '--is-ancestor', run.head_sha, 'origin/main']);
    command('git', ['merge-base', '--is-ancestor', `${tag}^{commit}`, run.head_sha]);
  }
  for (const item of plan) {
    fs.mkdirSync(item.directory, { recursive: true });
    command('gh', ['run', 'download', item.runId, '--repo', repository, '--name', item.name, '--dir', item.directory], true);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
