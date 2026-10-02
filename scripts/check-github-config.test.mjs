import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts/check-github-config.mjs');
const requireFromWebUi = createRequire(
  path.join(repoRoot, 'src/web-ui/package.json'),
);
const yaml = requireFromWebUi('yaml');

function createRepo({ workflow, nodeVersionFile }) {
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-github-config-'));
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ engines: { node: '>=22.12.0' } }, null, 2)}\n`,
  );
  writeFileSync(path.join(root, '.github/workflows/ci.yml'), workflow);

  if (nodeVersionFile) {
    writeFileSync(path.join(root, nodeVersionFile.path), `${nodeVersionFile.value}\n`);
  }

  return root;
}

function enableProductControlContract(root) {
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.scripts = { 'capabilities:check': 'node scripts/check.mjs' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENBITFUN_GITHUB_CONFIG_TEST_ROOT: root,
    },
    encoding: 'utf8',
  });
}

test('rejects setup-node node-version-file below the project baseline', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.node-version', value: '20' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: .node-version
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version-file \.node-version resolves to 20/);
  assert.match(result.stderr, /Node\.js 22\.12\.0 or newer/);
});

test('rejects removal or weakening of the ProductControl and Playbook gates', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Validate interactive capability contract
        continue-on-error: true
        run: pnpm run capabilities:check
`,
  });
  enableProductControlContract(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interactive capability gate must run exactly/u);
  assert.match(result.stderr, /interactive capability gate must remain blocking/u);
  assert.match(result.stderr, /ProductControl owner\/delivery-profile gate is missing/u);
  assert.match(result.stderr, /CLI ProductControl self-control coverage requires/u);
});

test('rejects explicit setup-node node-version below the project baseline when node-version-file is valid', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.node-version', value: '22' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 20
          node-version-file: .node-version
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version resolves to 20/);
});

test('accepts package.json node-version-file from engines.node', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: package.json
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts tool-versions node-version-file syntax', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.tool-versions', value: 'nodejs 22.12.0' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: .tool-versions
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('rejects floating setup-node minor below the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: "22.11.x"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version resolves to 22.11.x/);
});

test('accepts floating setup-node minor at the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: "22.12.x"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts explicit setup-node semver range at the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: ">=22.12.0"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub YAML config check passed/);
});

test('keeps Rust CI independent, restore-only on PRs, and target-focused', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  const rustJob = workflow.jobs['rust-build-check'];
  const frontendJob = workflow.jobs['frontend-build'];
  const trustedBase =
    "${{ github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/1.0.0-explore') }}";

  assert.equal(
    rustJob.needs,
    'build-impact',
    'Rust validation must not wait for the frontend build',
  );
  assert.deepEqual(
    rustJob.strategy.matrix.os,
    ['ubuntu-latest', 'macos-15', 'windows-latest'],
    'Rust validation must retain the reviewed Linux, macOS, and Windows matrix',
  );
  assert.equal(
    rustJob.steps.some((step) => step.uses?.startsWith('actions/download-artifact@')),
    false,
    'Rust validation must not download frontend artifacts',
  );
  assert.match(
    rustJob.steps.find((step) => step.name === 'Create Tauri resource directories')
      ?.run ?? '',
    /mkdir -p dist src\/mobile-web\/dist/,
  );
  assert.equal(
    frontendJob.steps.some(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') &&
        step.with?.name === 'frontend-dist',
    ),
    false,
    'The frontend build must not upload an artifact with no consumer',
  );

  for (const jobName of ['cli-test', 'rust-build-check']) {
    const job = workflow.jobs[jobName];
    const cache = job.steps.find((step) =>
      step.uses?.startsWith('swatinem/rust-cache@'),
    );
    assert.equal(
      job.steps.some((step) => step.run?.includes('cargo generate-lockfile')),
      false,
      `${jobName} must consume the committed Cargo.lock`,
    );
    assert.equal(cache?.with?.['save-if'], trustedBase);
    assert.equal(cache?.with?.['cache-on-failure'], trustedBase);
    assert.match(
      cache?.with?.['shared-key'] ?? '',
      /github\.base_ref \|\| github\.ref_name/,
      `${jobName} must not mix main and explore build outputs`,
    );
  }

  const cliJob = workflow.jobs['cli-test'];
  assert.equal(cliJob['timeout-minutes'], 30);
  assert.ok(
    cliJob.strategy.matrix.include.some((entry) => entry.os === 'windows-latest'),
    'Windows ConPTY contracts must run before Nightly',
  );
  assert.equal(
    cliJob.steps.find((step) => step.name === 'Run Windows CLI terminal contracts')?.run,
    'cargo test --locked -p openbitfun-cli --test terminal_process_contracts -- --test-threads=1',
  );

  const rustCache = rustJob.steps.find((step) =>
    step.uses?.startsWith('swatinem/rust-cache@'),
  );
  assert.equal(
    rustCache?.with?.['cache-directories'],
    undefined,
    'Rust cache cleanup must not own native libraries stored under target',
  );

  const restoreSherpaCache = rustJob.steps.find(
    (step) => step.name === 'Restore Sherpa native libraries',
  );
  const repairSherpaState = rustJob.steps.find(
    (step) => step.name === 'Repair missing Sherpa native state',
  );
  const checkCompilation = rustJob.steps.find(
    (step) => step.name === 'Check compilation',
  );
  const createTauriResources = rustJob.steps.find(
    (step) => step.name === 'Create Tauri resource directories',
  );
  const saveSherpaCache = rustJob.steps.find(
    (step) => step.name === 'Save Sherpa native libraries',
  );
  const sherpaCacheKey =
    'sherpa-onnx-v2-${{ github.base_ref || github.ref_name }}-${{ runner.os }}-${{ runner.arch }}-1.13.4-static';

  assert.equal(restoreSherpaCache?.uses, 'actions/cache/restore@v5');
  assert.equal(restoreSherpaCache?.with?.path, 'target/sherpa-onnx-prebuilt');
  assert.equal(restoreSherpaCache?.with?.key, sherpaCacheKey);
  assert.match(
    repairSherpaState?.run ?? '',
    /rm -rf target\/sherpa-onnx-prebuilt/,
  );
  assert.match(repairSherpaState?.run ?? '', /cargo clean -p sherpa-onnx-sys/);
  assert.equal(saveSherpaCache?.uses, 'actions/cache/save@v5');
  assert.equal(saveSherpaCache?.with?.path, 'target/sherpa-onnx-prebuilt');
  assert.equal(saveSherpaCache?.with?.key, sherpaCacheKey);
  assert.match(
    createTauriResources?.run ?? '',
    /src\/apps\/extension-host\/dist\/extension-host\.js/,
    'clean Rust checks must provide the generated extension Host resource path without building the Host',
  );
  assert.ok(
    rustJob.steps.indexOf(createTauriResources) <
      rustJob.steps.indexOf(checkCompilation),
    'Tauri resource placeholders must exist before cargo check',
  );
  assert.equal(
    saveSherpaCache?.if,
    "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/1.0.0-explore') && steps.sherpa-native-cache.outputs.cache-hit != 'true'",
  );
  assert.ok(
    rustJob.steps.indexOf(restoreSherpaCache) <
      rustJob.steps.indexOf(checkCompilation),
    'Sherpa native libraries must be restored before cargo check',
  );
  assert.ok(
    rustJob.steps.indexOf(checkCompilation) <
      rustJob.steps.indexOf(saveSherpaCache),
    'Sherpa native libraries must be saved before rust-cache post cleanup',
  );

  const commandByStep = new Map(
    rustJob.steps.map((step) => [step.name, step.run]),
  );
  const verifyMetadata = rustJob.steps.find(
    (step) => step.name === 'Verify committed Cargo metadata',
  );
  assert.equal(verifyMetadata?.run, 'cargo metadata --locked --no-deps');
  assert.ok(
    rustJob.steps.indexOf(verifyMetadata) < rustJob.steps.indexOf(checkCompilation),
    'CI must validate the committed Cargo.lock before the workspace check',
  );
  assert.equal(
    commandByStep.get('Run subscription authentication tests'),
    'cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib subscription_auth',
  );
  const installerCheck = rustJob.steps.find(
    (step) => step.name === 'Check installer compilation',
  );
  assert.equal(installerCheck?.if, "runner.os == 'Windows'");
  assert.equal(
    installerCheck?.run,
    'cargo check --manifest-path OpenBitFun-Installer/src-tauri/Cargo.toml',
  );
  const coreLibraryTests = rustJob.steps.find(
    (step) => step.name === 'Run core library tests',
  );
  const linuxFullCoreLibraryTests = rustJob.steps.find(
    (step) => step.name === 'Run full core library tests on Linux',
  );
  const coreLibraryTestSteps = rustJob.steps.filter(
    (step) => /^cargo test --locked -p openbitfun-core\b.*\s--lib$/.test(step.run ?? ''),
  );
  const desktopLibraryTests = rustJob.steps.find(
    (step) => step.name === 'Run desktop library tests',
  );
  const windowsDesktopProbe = rustJob.steps.find(
    (step) => step.name === 'Probe Windows desktop library tests',
  );
  const productControlContracts = rustJob.steps.find(
    (step) => step.name === 'Run product-control domain and delivery-profile contracts',
  );
  assert.equal(
    coreLibraryTests?.if,
    "runner.os != 'Linux'",
  );
  assert.equal(
    coreLibraryTests?.run,
    'cargo test --locked -p openbitfun-core --lib',
  );
  assert.equal(
    linuxFullCoreLibraryTests?.if,
    "runner.os == 'Linux'",
  );
  assert.equal(
    linuxFullCoreLibraryTests?.run,
    'cargo test --locked -p openbitfun-core --features product-full --lib',
  );
  assert.deepEqual(
    coreLibraryTestSteps.map((step) => ({ if: step.if, run: step.run })),
    [
      {
        if: "runner.os != 'Linux'",
        run: 'cargo test --locked -p openbitfun-core --lib',
      },
      {
        if: "runner.os == 'Linux'",
        run: 'cargo test --locked -p openbitfun-core --features product-full --lib',
      },
    ],
    'Core library validation must contain exactly the reviewed complementary steps',
  );
  assert.equal(desktopLibraryTests?.if, "runner.os != 'Windows'");
  assert.equal(
    desktopLibraryTests?.run,
    'cargo test --locked -p openbitfun-desktop --lib',
  );
  assert.equal(windowsDesktopProbe?.if, "runner.os == 'Windows'");
  assert.equal(windowsDesktopProbe?.shell, 'pwsh');
  assert.match(
    windowsDesktopProbe?.run ?? '',
    /cargo test --locked -p openbitfun-desktop --lib 2>&1/,
  );
  assert.match(windowsDesktopProbe?.run ?? '', /0xc0000139/);
  assert.match(windowsDesktopProbe?.run ?? '', /STATUS_ENTRYPOINT_NOT_FOUND/);
  assert.match(windowsDesktopProbe?.run ?? '', /test result: FAILED/);
  assert.match(windowsDesktopProbe?.run ?? '', /exit \$testExitCode/);
  assert.equal(
    productControlContracts?.if,
    undefined,
    'product-control contracts must run on every supported CI OS',
  );
  assert.match(
    productControlContracts?.run ?? '',
    /openbitfun-product-domains --no-default-features product_control/,
  );
  assert.match(
    productControlContracts?.run ?? '',
    /openbitfun-product-capabilities every_agent_runtime_delivery_profile_includes_product_control_discovery/,
  );
  const fileWatchContracts = rustJob.steps.find(
    (step) => step.name === 'Run file watch contract tests',
  );
  assert.equal(
    fileWatchContracts?.run,
    'cargo test --locked -p openbitfun-services-integrations --no-default-features --features file-watch --test file_watch_contracts',
  );
  assert.equal(
    fileWatchContracts?.if,
    undefined,
    'file-watch contracts must exercise FSEvents on macOS',
  );
  assert.equal(
    commandByStep.get('Run search tool tests'),
    'cargo test --locked -p tool-runtime --lib search::',
  );
});

test('gates fast checks and PR packaging behind one fail-closed build decision', (t) => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  for (const eventName of ['pull_request', 'push']) {
    assert.deepEqual(
      workflow.on[eventName]?.['paths-ignore'],
      ['png/**'],
      'nested Markdown may be a Rust compile-time input and must trigger classification',
    );
  }
  const impactJob = workflow.jobs['build-impact'];
  const cliJob = workflow.jobs['cli-test'];
  const rustJob = workflow.jobs['rust-build-check'];
  const buildJob = workflow.jobs['package-impact-contract'];
  const resultJob = workflow.jobs['rust-validation-result'];
  const frontendJob = workflow.jobs['frontend-build'];

  assert.equal(
    frontendJob.steps.find((step) => step.name === 'Test core boundary contracts')?.run,
    'pnpm run check:core-boundaries:test',
  );
  assert.equal(
    frontendJob.steps.find((step) => step.name === 'Check core boundaries')?.run,
    'pnpm run check:core-boundaries',
  );
  assert.equal(frontendJob.needs, 'build-impact');
  const frontendNode = frontendJob.steps.find((step) =>
    step.uses?.startsWith('actions/setup-node@'));
  assert.equal(frontendNode?.with?.cache, undefined);
  assert.equal(frontendNode?.with?.['package-manager-cache'], false);
  const frontendGate = "needs.build-impact.outputs.frontend_required != 'false'";
  for (const stepName of [
    'Verify committed release metadata',
    'Build plugin Host resources',
    'Generate web API bindings',
    'Build web UI',
    'Build mobile web',
    'Project a Nightly version',
    'Verify projected release metadata',
  ]) {
    assert.equal(
      frontendJob.steps.find((step) => step.name === stepName)?.if,
      frontendGate,
      `${stepName} must run for code changes and skip documentation-only changes`,
    );
  }
  for (const stepName of [
    'Verify Installer i18n projection',
    'Verify Installer Tauri package alignment',
  ]) {
    assert.equal(
      frontendJob.steps.find((step) => step.name === stepName),
      undefined,
      `${stepName} belongs to Nightly, not pull-request CI`,
    );
  }
  const releaseMetadata = 'cargo metadata --locked --no-deps';
  assert.equal(
    frontendJob.steps.find((step) => step.name === 'Verify committed release metadata')?.run,
    releaseMetadata,
  );
  assert.equal(
    frontendJob.steps.find((step) => step.name === 'Verify projected release metadata')?.run,
    releaseMetadata,
  );

  assert.equal(impactJob.name, 'Build Impact');
  assert.equal(impactJob['timeout-minutes'], 5);
  assert.equal(
    impactJob.outputs.rust_required,
    '${{ steps.classify.outputs.rust_required }}',
  );
  assert.equal(
    impactJob.outputs.desktop_platforms,
    '${{ steps.classify.outputs.desktop_platforms }}',
  );
  assert.equal(
    impactJob.outputs.desktop_packages_impacted,
    '${{ steps.classify.outputs.desktop_packages_impacted }}',
  );
  assert.equal(
    impactJob.outputs.pr_producer_required,
    '${{ steps.classify.outputs.pr_producer_required }}',
  );
  assert.equal(
    impactJob.outputs.relay_image_required,
    '${{ steps.classify.outputs.relay_image_required }}',
  );
  assert.equal(
    impactJob.outputs.dsh_profile_required,
    '${{ steps.classify.outputs.dsh_profile_required }}',
  );
  const checkout = impactJob.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.['fetch-depth'], 0);
  const classify = impactJob.steps.find((step) => step.id === 'classify');
  assert.match(classify?.run ?? '', /scripts\/ci\/classify-build-impact\.mjs/);
  assert.equal(
    classify?.env?.BASE_SHA,
    '${{ github.event.pull_request.base.sha || github.event.before }}',
  );
  assert.equal(
    classify?.env?.HEAD_SHA,
    '${{ github.event.pull_request.head.sha || github.sha }}',
  );
  assert.equal(
    classify?.env?.RANGE_MODE,
    "${{ github.event_name == 'pull_request' && 'merge-base' || 'direct' }}",
  );
  assert.match(classify?.run ?? '', /--range-mode "\$RANGE_MODE"/);

  for (const job of [cliJob, rustJob]) {
    assert.equal(job.needs, 'build-impact');
    assert.match(job.if, /!cancelled\(\)/);
    assert.doesNotMatch(job.if, /always\(\)/);
    assert.match(job.if, /rust_required != 'false'/);
  }

  assert.equal(buildJob.name, 'Impact-selected Linux / Relay Contract');
  assert.equal(buildJob.needs, 'build-impact');
  assert.equal(buildJob.uses, './.github/workflows/linux-binaries.yml');
  assert.match(buildJob.if, /github\.event_name == 'pull_request'/);
  assert.match(buildJob.if, /pr_producer_required == 'true'/);
  assert.deepEqual(buildJob.permissions, { contents: 'read' });
  assert.deepEqual(buildJob.with, {
    checkout_ref: '${{ github.sha }}',
    version: '1.0.0-nightly.ci.${{ github.run_id }}',
    artifact_prefix: 'ci-${{ github.run_id }}',
    artifact_retention_days: 1,
    validate_relay_image:
      "${{ needs.build-impact.outputs.relay_image_required == 'true' }}",
    upload_artifacts: false,
    cache_write: false,
  });

  assert.equal(resultJob.name, 'Rust / CLI Validation');
  assert.equal(resultJob.if, '${{ always() }}');
  assert.deepEqual(
    [...resultJob.needs].sort(),
    ['build-impact', 'cli-test', 'package-impact-contract', 'rust-build-check'],
  );
  const verify = resultJob.steps.find((step) => step.name === 'Verify Rust and CLI result');
  assert.equal(verify?.env?.RUST_REQUIRED, '${{ needs.build-impact.outputs.rust_required }}');
  assert.equal(
    verify?.env?.PR_PRODUCER_REQUIRED,
    '${{ needs.build-impact.outputs.pr_producer_required }}',
  );
  assert.equal(verify?.env?.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(verify?.env?.IMPACT_RESULT, '${{ needs.build-impact.result }}');
  assert.equal(verify?.env?.CLI_RESULT, '${{ needs.cli-test.result }}');
  assert.equal(verify?.env?.RUST_RESULT, '${{ needs.rust-build-check.result }}');
  assert.equal(
    verify?.env?.BUILD_RESULT,
    '${{ needs.package-impact-contract.result }}',
  );
  assert.equal(verify?.shell, 'pwsh');
  assert.match(verify?.run ?? '', /successful impact-selected producer jobs/i);
  assert.match(verify?.run ?? '', /successful Rust and CLI jobs/i);

  const dshJob = workflow.jobs['dsh-profile-windows'];
  assert.equal(dshJob.needs, 'build-impact');
  assert.match(dshJob.if, /dsh_profile_required == 'true'/);

  const statuses = ['success', 'skipped', 'failure', 'cancelled'];
  const cases = [];
  for (const impactResult of statuses.filter((status) => status !== 'success')) {
    cases.push({
      rustRequired: 'true',
      producerRequired: 'true',
      eventName: 'pull_request',
      impactResult,
      cliResult: 'success',
      rustResult: 'success',
      buildResult: 'success',
      expectedSuccess: false,
    });
  }
  for (const rustRequired of ['false', 'true']) {
    for (const producerRequired of ['false', 'true']) {
      for (const eventName of ['pull_request', 'push']) {
        for (const cliResult of statuses) {
          for (const rustResult of statuses) {
            for (const buildResult of statuses) {
              const packageExpected = eventName === 'pull_request'
                && producerRequired === 'true';
              cases.push({
                rustRequired,
                producerRequired,
                eventName,
                impactResult: 'success',
                cliResult,
                rustResult,
                buildResult,
                expectedSuccess: (packageExpected
                  ? buildResult === 'success'
                  : buildResult === 'skipped') && (rustRequired === 'false'
                  ? cliResult === 'skipped' && rustResult === 'skipped'
                  : cliResult === 'success' && rustResult === 'success'),
              });
            }
          }
        }
      }
    }
  }
  cases.push({
    rustRequired: '',
    producerRequired: 'false',
    eventName: 'push',
    impactResult: 'success',
    cliResult: 'skipped',
    rustResult: 'skipped',
    buildResult: 'success',
    expectedSuccess: false,
  });
  const truthTable = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$cases = ConvertFrom-Json ([Console]::In.ReadToEnd())
$verify = {
${verify.run}
}
foreach ($case in $cases) {
  $env:RUST_REQUIRED = [string]$case.rustRequired
  $env:PR_PRODUCER_REQUIRED = [string]$case.producerRequired
  $env:EVENT_NAME = [string]$case.eventName
  $env:IMPACT_RESULT = [string]$case.impactResult
  $env:CLI_RESULT = [string]$case.cliResult
  $env:RUST_RESULT = [string]$case.rustResult
  $env:BUILD_RESULT = [string]$case.buildResult
  $succeeded = $true
  try { & $verify } catch { $succeeded = $false }
  if ($succeeded -ne [bool]$case.expectedSuccess) {
    throw "Unexpected result: $($case | ConvertTo-Json -Compress) succeeded=$succeeded"
  }
}`,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      input: JSON.stringify(cases),
    },
  );
  if (truthTable.error?.code === 'ENOENT') {
    t.skip('pwsh is not installed; GitHub-hosted runners execute this truth table');
    return;
  }
  assert.equal(truthTable.status, 0, `${truthTable.stdout}${truthTable.stderr}`);
});

test('nightly validates generated inputs and projected lockfiles before packaging', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/nightly-artifacts.yml'),
      'utf8',
    ),
  );
  const callInputs = workflow.on.workflow_call.inputs;
  const packageJob = workflow.jobs.package;
  const linuxJob = workflow.jobs['linux-binaries'];
  const steps = packageJob.steps;
  const committedMetadataIndex = steps.findIndex(
    (step) => step.name === 'Verify committed Cargo metadata',
  );
  const generationIndex = steps.findIndex(
    (step) => step.name === 'Generate web API bindings',
  );
  const typeCheckIndex = steps.findIndex(
    (step) => step.name === 'Type-check web UI',
  );
  const patchIndex = steps.findIndex(
    (step) => step.name === 'Patch nightly version',
  );
  const tauriAlignmentIndex = steps.findIndex(
    (step) => step.name === 'Verify Installer Tauri package alignment',
  );
  const installerI18nIndex = steps.findIndex(
    (step) => step.name === 'Verify Installer i18n projection',
  );
  const metadataIndex = steps.findIndex(
    (step) => step.name === 'Verify projected Cargo metadata',
  );
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Build desktop app',
  );

  assert.equal(callInputs.checkout_ref.required, true);
  assert.equal(callInputs.version.required, true);
  assert.equal(callInputs.artifact_prefix.required, true);
  assert.equal(callInputs.artifact_retention_days.default, 1);
  assert.equal(callInputs.build_desktop_packages.default, true);
  assert.equal(callInputs.build_linux_binaries.default, true);
  assert.equal(callInputs.build_relay_image.default, true);
  assert.equal(callInputs.upload_artifacts.default, true);
  assert.equal(callInputs.cache_write.default, false);
  assert.equal(
    callInputs.desktop_platforms.default,
    '["linux-x64","linux-arm64","macos-arm64","macos-x64","windows-x64"]',
  );
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(
    linuxJob.if,
    '${{ inputs.build_linux_binaries || inputs.build_relay_image }}',
  );
  assert.equal(
    linuxJob.with.validate_relay_image,
    '${{ inputs.build_relay_image }}',
  );

  const node = steps.find((step) => step.name === 'Setup Node.js');
  assert.equal(node?.with?.cache, undefined);
  assert.equal(node?.with?.['package-manager-cache'], false);
  const rustCache = steps.find((step) =>
    step.uses?.startsWith('swatinem/rust-cache@'));
  const restoreOnlyOnPr =
    "${{ inputs.cache_write && github.event_name != 'pull_request' }}";
  assert.equal(rustCache?.with?.['save-if'], restoreOnlyOnPr);
  assert.equal(rustCache?.with?.['cache-on-failure'], restoreOnlyOnPr);
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const verifyOutputs = steps.find((step) => step.name === 'Verify package outputs');
  assert.match(verifyOutputs?.run ?? '', /openbitfun-installer\.exe/);
  assert.match(verifyOutputs?.run ?? '', /\*\.AppImage/);
  assert.ok(steps.indexOf(verifyOutputs) < steps.indexOf(upload));
  assert.equal(upload?.if, '${{ inputs.upload_artifacts }}');

  assert.notEqual(committedMetadataIndex, -1);
  assert.notEqual(installerI18nIndex, -1);
  assert.notEqual(tauriAlignmentIndex, -1);
  assert.notEqual(generationIndex, -1);
  assert.notEqual(typeCheckIndex, -1);
  assert.equal(
    steps[generationIndex].run,
    'pnpm --dir src/web-ui run gen:types',
  );
  assert.ok(
    generationIndex < typeCheckIndex,
    'nightly must generate web API bindings before type-checking the web UI',
  );
  assert.ok(
    committedMetadataIndex < patchIndex &&
      installerI18nIndex < patchIndex &&
      tauriAlignmentIndex < patchIndex &&
      typeCheckIndex < patchIndex &&
      patchIndex < metadataIndex &&
      metadataIndex < buildIndex,
    'nightly must verify the projected lockfile before nested locked build hooks run',
  );
  const expectedMetadata = 'cargo metadata --locked --no-deps';
  assert.equal(steps[committedMetadataIndex].run, expectedMetadata);
  assert.equal(steps[metadataIndex].run, expectedMetadata);
  assert.equal(steps[installerI18nIndex].if, "runner.os == 'Windows'");
  assert.equal(
    steps[installerI18nIndex].run,
    'pnpm --dir OpenBitFun-Installer run sync:i18n',
  );
  assert.equal(steps[tauriAlignmentIndex].if, "runner.os == 'Windows'");
  assert.match(
    steps[tauriAlignmentIndex].run,
    /Found version mismatched Tauri packages/,
  );
  assert.equal(
    steps.some((step) => step.run?.includes('cargo generate-lockfile')),
    false,
    'nightly must not hide stale committed lockfiles by regenerating them ad hoc',
  );
  assert.equal(
    steps.find((step) => step.name === 'Run Windows CLI terminal contracts')?.run,
    'cargo test --locked -p openbitfun-cli --test terminal_process_contracts -- --test-threads=1',
  );
});

test('nightly orchestrates the shared build before the separately privileged publish', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8'),
  );
  const build = workflow.jobs['build-artifacts'];
  const publish = workflow.jobs['publish-nightly'];

  assert.equal(workflow.on.workflow_call, undefined);
  assert.deepEqual(workflow.concurrency, {
    group: 'nightly-${{ github.repository }}',
    'cancel-in-progress': true,
  });
  assert.equal(build.uses, './.github/workflows/nightly-artifacts.yml');
  assert.deepEqual(build.permissions, { contents: 'read' });
  assert.deepEqual(build.with, {
    checkout_ref: '${{ github.sha }}',
    version: '${{ needs.check-changes.outputs.nightly_version }}',
    artifact_prefix: 'nightly',
    artifact_retention_days:
      "${{ fromJSON(inputs.artifact_retention_days || '7') }}",
    build_desktop_packages: true,
    desktop_platforms:
      '["linux-x64","linux-arm64","macos-arm64","macos-x64","windows-x64"]',
    build_linux_binaries: true,
    build_relay_image: true,
    upload_artifacts: true,
    cache_write: "${{ github.repository_owner == 'GCWing' }}",
  });
  assert.deepEqual(publish.needs, ['check-changes', 'build-artifacts']);
  assert.match(publish.if, /inputs\.build_only != true/);
  assert.deepEqual(publish.permissions, {
    contents: 'write',
    packages: 'write',
  });
});

test('Linux binary packaging uses the shared locked version projection contract', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/linux-binaries.yml'), 'utf8'),
  );
  const inputs = workflow.on.workflow_call.inputs;
  const steps = workflow.jobs.build.steps;
  const nodeSteps = steps.filter(
    (step) => step.name === 'Setup Node.js',
  );
  const nodeIndex = steps.findIndex(
    (step) => step.name === 'Setup Node.js',
  );
  const committedIndex = steps.findIndex(
    (step) => step.name === 'Verify committed Cargo metadata',
  );
  const patchIndex = steps.findIndex(
    (step) => step.name === 'Patch build version',
  );
  const projectedIndex = steps.findIndex(
    (step) => step.name === 'Verify projected Cargo metadata',
  );
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Build CLI and Relay Server',
  );

  assert.equal(inputs.artifact_retention_days.default, 7);
  assert.equal(inputs.upload_artifacts.default, true);
  assert.equal(inputs.cache_write.default, false);
  assert.equal(inputs.validate_relay_image.default, true);
  assert.equal(nodeSteps.length, 1);
  assert.equal(steps[nodeIndex].uses, 'actions/setup-node@v5');
  assert.equal(steps[nodeIndex].with['node-version-file'], 'package.json');
  assert.ok(
    nodeIndex < patchIndex &&
      committedIndex < patchIndex &&
      patchIndex < projectedIndex &&
      projectedIndex < buildIndex,
  );
  assert.match(steps[patchIndex].run, /node scripts\/set-build-version\.mjs/);
  assert.doesNotMatch(steps[patchIndex].run, /sed -i/);
  assert.equal(steps[committedIndex].run, 'cargo metadata --locked --no-deps');
  assert.equal(steps[projectedIndex].run, 'cargo metadata --locked --no-deps');
  assert.match(steps[buildIndex].run, /cargo build --locked --release/);
  const rustCache = steps.find((step) =>
    step.uses?.startsWith('swatinem/rust-cache@'));
  const restoreOnlyOnPr =
    "${{ inputs.cache_write && github.event_name != 'pull_request' }}";
  assert.equal(rustCache?.with?.['save-if'], restoreOnlyOnPr);
  assert.equal(rustCache?.with?.['cache-on-failure'], restoreOnlyOnPr);
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const verifyOutputs = steps.find((step) => step.name === 'Verify Linux binary outputs');
  const validateImage = steps.find((step) => step.name === 'Validate Relay runtime image');
  assert.match(verifyOutputs?.run ?? '', /sha256sum --check/);
  assert.ok(steps.indexOf(verifyOutputs) < steps.indexOf(upload));
  assert.equal(validateImage?.if, '${{ inputs.validate_relay_image }}');
  assert.equal(validateImage?.with?.push, false);
  assert.equal(validateImage?.with?.platforms, 'linux/${{ matrix.platform.docker_arch }}');
  assert.equal(upload?.if, '${{ inputs.upload_artifacts }}');
  assert.equal(
    upload?.with?.['retention-days'],
    '${{ inputs.artifact_retention_days }}',
  );
});

test('PR-capable release builds cannot save repository caches or upload CI packages', () => {
  const ci = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  const artifacts = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly-artifacts.yml'), 'utf8'),
  );
  const linux = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/linux-binaries.yml'), 'utf8'),
  );

  for (const workflow of [artifacts, linux]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const cache of (job.steps ?? []).filter((step) =>
        step.uses?.startsWith('swatinem/rust-cache@'))) {
        assert.match(cache.with['save-if'], /github\.event_name != 'pull_request'/);
        assert.match(cache.with['cache-on-failure'], /github\.event_name != 'pull_request'/);
        assert.match(cache.with['shared-key'], /github\.base_ref \|\| github\.ref_name/);
      }
    }
  }

  for (const workflow of [ci, artifacts, linux]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const bun of (job.steps ?? []).filter((step) =>
        step.uses?.startsWith('oven-sh/setup-bun@'))) {
        assert.equal(bun.with?.['no-cache'], true);
      }
    }
  }

  const packageCaller = ci.jobs['package-impact-contract'];
  assert.equal(packageCaller.with.cache_write, false);
  assert.equal(packageCaller.with.upload_artifacts, false);
  const node = artifacts.jobs.package.steps.find(
    (step) => step.name === 'Setup Node.js',
  );
  assert.equal(node.with.cache, undefined);
  assert.equal(node.with['package-manager-cache'], false);
});

test('nightly publishes and verifies the Relay image in the current repository owner scope', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8'),
  );
  const steps = workflow.jobs['publish-nightly'].steps;
  const metadata = steps.find(
    (step) => step.name === 'Resolve nightly image metadata',
  );
  const publish = steps.find(
    (step) => step.name === 'Build and push multi-platform Relay image',
  );
  const smoke = steps.find(
    (step) => step.name === 'Smoke-test published Relay image on both platforms',
  );
  const manifest = steps.find(
    (step) => step.name === 'Generate Linux binaries manifest',
  );
  const verifyDescriptor = steps.find(
    (step) => step.name === 'Verify published Relay image descriptor',
  );
  const verifyMacCli = steps.find(
    (step) => step.name === 'Verify published macOS CLI assets',
  );
  const image = '${{ steps.nightly-image-meta.outputs.image }}';

  assert.match(
    metadata?.run ?? '',
    /image=ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/openbitfun-relay-server/,
  );
  assert.equal(
    publish?.with?.tags,
    `${image}:${'${{ env.NIGHTLY_TAG }}'}\n${image}:${'${{ steps.nightly-image-meta.outputs.asset_version }}'}\n`,
  );
  assert.equal(
    smoke?.run,
    `bash scripts/relay/smoke-image.sh \\\n  "${image}@\${IMAGE_DIGEST}"\n`,
  );
  assert.match(manifest?.run ?? '', /--repo "\$\{\{ github\.repository \}\}"/);
  assert.match(
    verifyDescriptor?.run ?? '',
    /\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/releases\/download/,
  );
  assert.match(
    verifyMacCli?.run ?? '',
    /\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/releases\/download/,
  );
});

test('passes the verification key when signing the versioned Windows installer', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const signingStep = workflow.jobs['upload-release-assets'].steps.find(
    (step) => step.name === 'Sign versioned Windows installer',
  );

  assert.equal(
    signingStep?.env?.OPENBITFUN_SIGNING_PUBKEY,
    '${{ secrets.TAURI_UPDATER_PUBKEY }}',
    'release signatures must be self-verified with the configured public key',
  );
});

test('stages unique release asset names before publishing', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const steps = workflow.jobs['upload-release-assets'].steps;
  const stagingIndexes = [
    steps.findIndex((step) => step.name === 'Stage release assets'),
  ];
  const uploadIndex = steps.findIndex((step) => step.name === 'Upload to release');

  assert.equal(stagingIndexes.every((index) => index >= 0), true);
  assert.notEqual(uploadIndex, -1);
  for (const stagingIndex of stagingIndexes) {
    assert.ok(stagingIndex < uploadIndex);
    assert.match(
      steps[stagingIndex].run,
      /node scripts\/stage-github-release-assets\.mjs/,
    );
    assert.doesNotMatch(
      steps[stagingIndex].run,
      /release-assets\/\*\*\/\*\.sig(?:\s|\\)/,
      'raw updater signatures have colliding names across macOS architectures',
    );
  }
  assert.match(steps[uploadIndex].run, /--clobber release-upload-assets\/\*/);
});

test('Desktop packaging installs Bun before preparing the OpenCode extension Host', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8'),
  );
  const steps = workflow.jobs.package.steps;
  const bunIndex = steps.findIndex((step) => step.uses === 'oven-sh/setup-bun@v2');
  const buildIndex = steps.findIndex((step) => step.name === 'Build desktop app');
  assert.ok(bunIndex >= 0 && bunIndex < buildIndex);
  assert.equal(steps[bunIndex].if, undefined, 'every Desktop platform needs Bun');
  assert.equal(steps[bunIndex].with['bun-version'], '1.3.14');
});

test('Desktop packaging keeps beta identity explicit and stable-safe', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.release_channel.options, ['stable', 'beta']);
  assert.equal(inputs.release_channel.default, 'stable');

  const prepareStep = workflow.jobs.prepare.steps.find(
    (step) => step.name === 'Resolve version metadata',
  );
  assert.match(prepareStep.run, /GITHUB_REPOSITORY.*GCWing\/OpenBitFun/);
  assert.match(prepareStep.run, /merge-base --is-ancestor/);
  assert.match(prepareStep.run, /rev-parse --verify --quiet/);

  const packageJob = workflow.jobs.package;
  assert.equal(
    packageJob.env.OPENBITFUN_RELEASE_CHANNEL,
    '${{ needs.prepare.outputs.release_channel }}',
  );
  assert.match(packageJob.env.TAURI_UPDATER_ENDPOINT, /github\.repository/);
  assert.match(packageJob.env.TAURI_UPDATER_ENDPOINT, /channel-v1-beta/);
  assert.ok(packageJob.env.TAURI_UPDATER_ENDPOINT.includes("format('https://github.com/{0}/releases/latest/download/latest-v1.json', github.repository)"));
  assert.equal(packageJob.env.TAURI_UPDATER_ENDPOINT, packageJob.env.TAURI_UPDATER_FALLBACK_ENDPOINT);
  assert.match(packageJob.env.OPENBITFUN_RELEASE_PUBKEY, /OPENBITFUN_RELEASE_PUBKEY/);
  const appleSetupIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Configure Apple Developer ID signing and notarization',
  );
  const desktopBuildIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Build desktop app',
  );
  const appleVerifyIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Verify Apple signature and notarization',
  );
  assert.ok(
    appleSetupIndex >= 0 &&
      appleSetupIndex < desktopBuildIndex &&
      desktopBuildIndex < appleVerifyIndex,
    'Apple credentials must be configured before packaging and verified afterwards',
  );
  assert.equal(packageJob.steps[appleSetupIndex].if, "runner.os == 'macOS'");
  assert.equal(
    packageJob.steps[appleSetupIndex].env.OPENBITFUN_REQUIRE_APPLE_SIGNING,
    '${{ needs.prepare.outputs.upload_to_release }}',
  );
  assert.equal(packageJob.steps[appleVerifyIndex].if, "runner.os == 'macOS'");
  const patchIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Project beta build version',
  );
  const verifyIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Verify release version metadata',
  );
  assert.ok(patchIndex >= 0 && patchIndex < verifyIndex);
  assert.equal(
    packageJob.steps[patchIndex].if,
    "needs.prepare.outputs.release_channel == 'beta'",
  );

  const uploadSteps = workflow.jobs['upload-release-assets'].steps;
  const release = uploadSteps.find((step) => step.name === 'Upload to release');
  assert.equal(
    release.env.RELEASE_PRERELEASE,
    "${{ needs.prepare.outputs.release_channel == 'beta' }}",
  );
  const verifyIndexPublished = uploadSteps.findIndex(
    (step) => step.name === 'Verify published updater manifest',
  );
  const promoteIndex = uploadSteps.findIndex(
    (step) => step.name === 'Publish beta channel manifest',
  );
  assert.ok(verifyIndexPublished >= 0 && verifyIndexPublished < promoteIndex);
  const requiredManual = 'windows-x86_64,darwin-aarch64,darwin-x86_64';
  assert.match(
    uploadSteps.find((step) => step.name === 'Verify updater manifest').run,
    new RegExp(`--required-manual-platforms "${requiredManual}"`),
  );
  assert.match(
    uploadSteps[verifyIndexPublished].run,
    new RegExp(`--required-manual-platforms "${requiredManual}"`),
  );
  assert.doesNotMatch(workflow.jobs['linux-binaries'].if, /release_channel/);
  assert.equal(
    uploadSteps.find((step) => step.name === 'Stage release assets').if,
    undefined,
  );
  assert.match(
    uploadSteps.find((step) => step.name === 'Generate updater manifest').run,
    /github\.repository/,
  );
  const signingStep = uploadSteps.find(
    (step) => step.name === 'Sign installer packages',
  );
  assert.match(signingStep.run, /write-minisign-public-key\.mjs/);
  assert.doesNotMatch(signingStep.run, /OPENBITFUN_SIGNING_PUBKEY.*base64 -d/);
  const promotionStep = uploadSteps.find(
    (step) => step.name === 'Resolve beta channel promotion',
  );
  assert.doesNotMatch(promotionStep.run, /current\.beta\.json \|\| true/);
  assert.match(promotionStep.run, /case "\$\{channel_status\}" in/);
  assert.match(promotionStep.run, /404\)/);
  assert.match(promotionStep.run, /GitHub API returned/);
  const publishStep = uploadSteps.find(
    (step) => step.name === 'Publish beta channel manifest',
  );
  assert.equal(
    publishStep.env.CHANNEL_EXISTS,
    '${{ steps.beta-channel.outputs.channel_exists }}',
  );
});

test('beta publishing cannot advance the Relay latest image tag', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const imageTags = workflow.jobs['publish-relay-image'].steps.find(
    (step) => step.name === 'Resolve image tags',
  );
  assert.equal(
    imageTags.env.RELEASE_CHANNEL,
    '${{ needs.prepare.outputs.release_channel }}',
  );
  assert.match(imageTags.run, /RELEASE_CHANNEL.*stable/);
  assert.doesNotMatch(imageTags.run, /RELEASE_PRERELEASE/);
});

test('stable and beta publication require every producer, while artifact-only runs never publish', () => {
  const { jobs } = yaml.parse(readFileSync(
    path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8',
  ));
  // These workflow conditions use the shared Boolean/string subset of Actions
  // expressions and JavaScript. Exercise the actual conditions, not a copy.
  const condition = (job, needs) => {
    const expression = job.if.replace(/needs\.([\w-]+)/g, 'needs["$1"]');
    return Function('needs', 'always', `return (${expression});`)(needs, () => true);
  };
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  for (const channel of ['stable', 'beta']) {
    for (const upload of ['true', 'false']) {
      for (const desktop of results) for (const linux of results) for (const image of results) {
        const needs = {
          prepare: { outputs: { release_channel: channel, upload_to_release: upload, relay_image_only: 'false' } },
          package: { result: desktop },
          'linux-binaries': { result: linux },
          'publish-relay-image': { result: image },
        };
        assert.equal(condition(jobs['linux-binaries'], needs), true);
        assert.equal(condition(jobs['publish-relay-image'], needs), upload === 'true' && linux === 'success');
        assert.equal(condition(jobs['upload-release-assets'], needs),
          upload === 'true' && [desktop, linux, image].every((result) => result === 'success'),
          JSON.stringify(needs));
      }
    }
    const backfill = {
      prepare: { outputs: { release_channel: channel, upload_to_release: 'true', relay_image_only: 'true' } },
      package: { result: 'skipped' },
      'linux-binaries': { result: 'skipped' },
      'publish-relay-image': { result: 'success' },
    };
    assert.equal(condition(jobs['linux-binaries'], backfill), false);
    assert.equal(condition(jobs['publish-relay-image'], backfill), true);
    assert.equal(condition(jobs['upload-release-assets'], backfill), false);
  }
  const backfillRelease = jobs['publish-relay-image'].steps.find(
    (step) => step.name === 'Attach descriptor to an existing release (image-only backfill)',
  );
  assert.equal(backfillRelease.with.prerelease, "${{ needs.prepare.outputs.release_channel == 'beta' }}");
  assert.equal(backfillRelease.with.make_latest, 'false');
  const steps = jobs['upload-release-assets'].steps;
  for (const name of [
    'Download Linux binary artifacts', 'Download Relay image descriptor',
    'Generate Linux binaries manifest', 'Stage release assets',
    'Verify published Linux binaries manifest', 'Verify published Relay image descriptor',
  ]) {
    assert.equal(steps.find((step) => step.name === name)?.if, undefined, name);
    assert.ok(steps.some((step) => step.name === name), name);
  }
  const stage = steps.find((step) => step.name === 'Stage release assets');
  for (const pattern of [
    'linux-release-assets/openbitfun-cli-*.tar.gz',
    'linux-release-assets/openbitfun-relay-server-*.tar.gz',
    'linux-release-assets/*.tar.gz.sig', 'linux-release-assets/*.tar.gz.sha256.sig',
    'linux-release-assets/linux-binaries-v1.json', 'relay-image-assets/relay-image.json.sig',
  ]) assert.ok(stage.run.includes(pattern), pattern);
  assert.match(steps.find((step) => step.name === 'Generate Linux binaries manifest').run, /--repo "\$\{\{ github.repository \}\}"/);
  for (const name of ['Verify published Linux binaries manifest', 'Verify published Relay image descriptor']) {
    const verification = steps.find((step) => step.name === name);
    assert.match(verification.run, /github.repository/);
    assert.ok(steps.indexOf(verification) < steps.findIndex((step) => step.name === 'Publish beta channel manifest'));
  }
});

test('Relay image rebuild resolves the release tag instead of the newer workflow commit', (t) => {
  const { jobs } = yaml.parse(readFileSync(
    path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8',
  ));
  const step = jobs.prepare.steps.find((entry) => entry.name === 'Resolve version metadata');
  const verification = jobs['upload-release-assets'].steps.find((entry) => entry.name === 'Verify published Relay image descriptor');
  assert.match(verification.run, /cmp relay-image-assets\/relay-image.json relay-image.published.json/);
  assert.match(verification.run, /cmp relay-image-assets\/relay-image.json.sig relay-image.published.json.sig/);
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-relay-rebuild-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tagSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  for (const checkoutRef of ['', 'newer-branch']) {
    const output = path.join(root, `output-${checkoutRef || 'tag'}`);
    const result = spawnSync('bash', ['-c', `
      git() {
        case "$1" in
          fetch|merge-base) return 0 ;;
          rev-parse)
            case "\${!#}" in
              'v1.0.0^{commit}') echo "$TAG_SHA" ;;
              *) echo "$GITHUB_SHA" ;;
            esac ;;
        esac
      }
      ${step.run.replaceAll('${{ github.event.release.prerelease }}', 'false')}
    `], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: headSha,
        GITHUB_REPOSITORY: 'GCWing/OpenBitFun', GITHUB_OUTPUT: output,
        INPUT_TAG_NAME: 'v1.0.0', INPUT_CHECKOUT_REF: checkoutRef,
        INPUT_RELEASE_CHANNEL: 'stable', INPUT_UPLOAD_TO_RELEASE: 'true',
        INPUT_RELAY_IMAGE_ONLY: 'true', TAG_SHA: tagSha,
      },
    });
    if (checkoutRef) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not requested commit/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(output, 'utf8'), new RegExp(`checkout_ref=${tagSha}`));
    }
  }
});

test('Relay image tag selection keeps Beta and old stable backfills away from latest', {
  skip: process.platform === 'win32',
}, (t) => {
  const { jobs } = yaml.parse(readFileSync(
    path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8',
  ));
  const step = jobs['publish-relay-image'].steps.find((entry) => entry.name === 'Resolve image tags');
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-image-tags-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scenario of [
    { channel: 'beta', version: '1.0.0-beta.3', imageOnly: 'false', latest: false },
    { channel: 'beta', version: '1.0.0-beta.3', imageOnly: 'true', latest: false },
    { channel: 'stable', version: '1.0.0-beta', imageOnly: 'false', latest: true },
    { channel: 'stable', version: '1.0.0', imageOnly: 'false', latest: true },
    { channel: 'stable', version: '1.0.0', imageOnly: 'true', latest: true },
    { channel: 'stable', version: '0.2.19', imageOnly: 'true', latest: false },
  ]) {
    const output = path.join(root, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', `gh() { printf 'v1.0.0\\n'; }\n${step.run}`], {
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'test-owner/OpenBitFun',
        IMAGE: 'ghcr.io/test-owner/openbitfun-relay-server', RELEASE_TAG: `v${scenario.version}`,
        RELEASE_VERSION: scenario.version, RELEASE_CHANNEL: scenario.channel, IMAGE_ONLY: scenario.imageOnly },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const tags = readFileSync(output, 'utf8').trim().split('\n');
    assert.deepEqual(tags, [
      'value<<EOF', `ghcr.io/test-owner/openbitfun-relay-server:v${scenario.version}`,
      `ghcr.io/test-owner/openbitfun-relay-server:${scenario.version}`,
      ...(scenario.latest ? ['ghcr.io/test-owner/openbitfun-relay-server:latest'] : []), 'EOF',
    ]);
  }
});

test('beta channel readback retries stale content and fails if it never converges', {
  skip: process.platform === 'win32' || spawnSync('jq', ['--version'], { windowsHide: true }).status !== 0,
}, (t) => {
  const workflow = yaml.parse(readFileSync(
    path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8',
  ));
  const step = workflow.jobs['upload-release-assets'].steps.find(
    (entry) => entry.name === 'Publish beta channel manifest',
  );
  assert.equal(step.env.CANDIDATE_VERSION, '${{ steps.beta-channel.outputs.candidate_version }}');
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-beta-readback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const command of ['gh', 'sleep']) {
    writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const count = fs.existsSync('requests') ? Number(fs.readFileSync('requests', 'utf8')) + 1 : 1;
fs.writeFileSync('requests', String(count));
if (process.env.READBACK_CASE === 'transport' && count === 1) process.exit(22);
const output = process.argv[process.argv.indexOf('-o') + 1];
const content = process.env.READBACK_CASE === 'malformed' && count === 1
  ? 'not json'
  : JSON.stringify({ version: process.env.READBACK_CASE === 'stale' || count === 1 ? '0.2.19-beta.1' : '1.0.0-beta.1' });
fs.writeFileSync(output, content);
`, { mode: 0o755 });
  for (const scenario of ['converges', 'transport', 'malformed', 'stale']) {
    const cwd = path.join(root, scenario);
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, 'latest.published.json'), '{"version":"1.0.0-beta.1"}');
    const result = spawnSync('bash', ['-c', step.run], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        READBACK_CASE: scenario,
        CHANNEL_EXISTS: 'true',
        GITHUB_REPOSITORY: 'test/repo',
        CANDIDATE_VERSION: '1.0.0-beta.1',
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.status, scenario === 'stale' ? 1 : 0, `${scenario}: ${result.stderr}`);
    const requests = Number(readFileSync(path.join(cwd, 'requests'), 'utf8'));
    assert.ok(requests > 1 && requests <= 60, `${scenario}: bounded content retries`);
    if (scenario === 'stale') assert.match(result.stderr, /did not converge/);
  }
});

test('nightly and beta use the shared build-version projection', () => {
  const artifacts = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/nightly-artifacts.yml'),
      'utf8',
    ),
  );
  const nightly = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8'),
  );
  const patch = artifacts.jobs.package.steps.find(
    (step) => step.name === 'Patch nightly version',
  );
  assert.match(patch.run, /node scripts\/set-build-version\.mjs/);
  assert.equal(artifacts.jobs.package.env.OPENBITFUN_RELEASE_CHANNEL, 'nightly');
  assert.equal(
    artifacts.jobs.package.env.TAURI_UPDATER_ENDPOINT,
    'https://github.com/GCWing/OpenBitFun/releases/latest/download/latest-v1.json',
  );
  assert.equal(
    artifacts.jobs.package.env.TAURI_UPDATER_FALLBACK_ENDPOINT,
    'https://openbitfun.com/release/latest-v1.json',
  );
  assert.equal(artifacts.jobs.package.env.OPENBITFUN_ENABLE_UPDATER_ARTIFACTS, undefined);
  const signingStep = nightly.jobs['publish-nightly'].steps.find(
    (step) => step.name === 'Sign installer packages',
  );
  assert.match(signingStep.run, /write-minisign-public-key\.mjs/);
});


test('Linux Rust workflows do not install an unused native OpenSSL toolchain', () => {
  for (const workflowPath of [
    '.github/workflows/ci.yml',
    '.github/workflows/cli-package-manual.yml',
    '.github/workflows/linux-binaries.yml',
  ]) {
    const workflow = readFileSync(path.join(repoRoot, workflowPath), 'utf8');
    assert.doesNotMatch(
      workflow,
      /\blibssl-dev\b/,
      `${workflowPath} must rely on the reviewed Cargo-owned Git2 build profile`,
    );
  }
});


test('public beta launch uses Latest while legacy updater feeds stay on the pinned notice manifest', () => {
  const workflow = yaml.parse(readFileSync(path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8'));
  const steps = workflow.jobs['upload-release-assets'].steps;
  const upload = steps.find((step) => step.name === 'Upload to release');
  assert.equal(upload.env.RELEASE_LATEST, "${{ needs.prepare.outputs.release_channel == 'stable' }}");
  assert.equal(upload.env.RELEASE_PRERELEASE, "${{ needs.prepare.outputs.release_channel == 'beta' }}");
  const preserve = steps.find((step) => step.name === 'Preserve legacy update feeds');
  assert.equal(preserve.if, "needs.prepare.outputs.release_channel == 'stable'");
  assert.ok(steps.indexOf(preserve) < steps.indexOf(upload));
  assert.match(steps.find((step) => step.name === 'Generate updater manifest').run, /--out release-updater-assets\/latest-v1\.json/);
  // The pinned legacy manifests must come from the repository, so the notice
  // manifest survives every future release without manual re-upload.
  assert.match(preserve.run, /scripts\/fixtures\/legacy-update-feeds/);
  assert.doesNotMatch(preserve.run, /curl/);
  assert.match(preserve.run, /0\.2\.20/);
  assert.match(preserve.run, /0\.2\.19/);
  assert.match(preserve.run, /notes/);
  // The pinned step downloads nothing, so the released version can never leak
  // into a legacy feed; the sandbox only proves the copy + guard behavior.
  const cwd = mkdtempSync(path.join(tmpdir(), 'openbitfun-legacy-feed-'));
  try {
    // The step reads its pinned manifests via a repo-root-relative path and
    // writes into release-upload-assets/, so mirror the CI working tree
    // inside the sandbox instead of running against the real checkout.
    mkdirSync(path.join(cwd, 'scripts/fixtures/legacy-update-feeds'), { recursive: true });
    mkdirSync(path.join(cwd, 'release-upload-assets'));
    for (const name of ['latest.json', 'linux-binaries.json']) {
      copyFileSync(
        path.join(repoRoot, 'scripts/fixtures/legacy-update-feeds', name),
        path.join(cwd, 'scripts/fixtures/legacy-update-feeds', name),
      );
    }
    const candidate = '{"version":"1.0.0-beta"}';
    writeFileSync(path.join(cwd, 'release-upload-assets/latest-v1.json'), candidate);
    const result = spawnSync('bash', ['-c', preserve.run], {
      cwd, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['latest.json', 'linux-binaries.json']) {
      assert.equal(
        readFileSync(path.join(cwd, 'release-upload-assets', name), 'utf8'),
        readFileSync(path.join(repoRoot, 'scripts/fixtures/legacy-update-feeds', name), 'utf8'),
      );
    }
    assert.equal(readFileSync(path.join(cwd, 'release-upload-assets/latest-v1.json'), 'utf8'), candidate);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


test('release publication omits target overrides and uploads before publishing', (t) => {
  const workflow = yaml.parse(readFileSync(path.join(repoRoot, '.github/workflows/desktop-package.yml'), 'utf8'));
  const step = workflow.jobs['upload-release-assets'].steps.find((entry) => entry.name === 'Upload to release');
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-publish-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const status of ['200', '404', '403']) {
    const cwd = path.join(root, status);
    mkdirSync(cwd);
    mkdirSync(path.join(cwd, 'release-upload-assets'));
    writeFileSync(path.join(cwd, 'release-upload-assets/latest-v1.json'), '{}');
    const result = spawnSync('bash', ['-c', `
      curl() { printf '%s' "$HTTP_STATUS"; }
      gh() { printf '%s\\n' "$*" >> calls; }
      ${step.run}
    `], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env,
      HTTP_STATUS: status, GH_TOKEN: 'fixture', GITHUB_REPOSITORY: 'test/repo',
      RELEASE_TAG: 'v1.0.0-beta', RELEASE_VERSION: '1.0.0-beta',
      RELEASE_PRERELEASE: 'false', RELEASE_LATEST: 'true' } });
    if (status === '403') {
      assert.notEqual(result.status, 0);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(path.join(cwd, 'calls'), 'utf8');
    assert.doesNotMatch(calls, /--target|target_commitish/);
    assert.equal(calls.includes('release create'), status === '404');
    if (status === '404') assert.match(calls, /--verify-tag --draft/);
    assert.ok(calls.indexOf('release upload') < calls.indexOf('release edit'));
    assert.match(calls, /--draft=false --prerelease=false --latest=true/);
  }
  const prepare = workflow.jobs.prepare.steps.find((entry) => entry.id === 'meta').run;
  assert.match(prepare, /UPLOAD.*true.*-z.*TAG_SHA/);
});
