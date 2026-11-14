import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('Relay deploy falls back to the same old image tag or digest and honors explicit overrides', {
  skip: process.platform === 'win32',
}, () => {
  const official = 'ghcr.io/openbitfun/openbitfun-relay-server';
  const legacy = 'ghcr.io/gcwing/openbitfun-relay-server';
  const override = 'ghcr.io/custom/openbitfun-relay-server';
  const digest = `sha256:${'a'.repeat(64)}`;
  for (const { tag, pin = '', image = '', available, pulls, resolves = false } of [
    { tag: 'latest', available: `${official}:latest`, pulls: [`${official}:latest`] },
    { tag: 'latest', available: `${legacy}:v1.0.10`, pulls: [`${official}:latest`, `${legacy}:v1.0.10`], resolves: true },
    { tag: 'v1.0.9', available: `${legacy}:v1.0.9`, pulls: [`${official}:v1.0.9`, `${legacy}:v1.0.9`] },
    { tag: 'latest', pin: digest, available: `${legacy}@${digest}`, pulls: [`${official}@${digest}`, `${legacy}@${digest}`] },
    { tag: 'v1.0.9', image: override, available: '', pulls: [`${override}:v1.0.9`] },
    { tag: 'latest', available: '', pulls: [`${official}:latest`, `${legacy}:v1.0.10`], resolves: true },
  ]) {
    const result = spawnSync('bash', ['-c', `
      set -euo pipefail
      source src/apps/relay-server/release-download.sh
      openbitfun_relay_native_platform() { echo linux/amd64; }
      curl() {
        echo 'resolve latest' >&2
        case "\${!#}" in
          https://github.com/openBitFun/OpenBitFun/releases/latest)
            printf 'https://github.com/openBitFun/OpenBitFun/releases/tag/v1.0.10' ;;
          *) return 1 ;;
        esac
      }
      openbitfun_image_docker_with_timeout() {
        printf 'pull %s\n' "\${!#}" >&2
        [[ "\${!#}" == "$AVAILABLE_IMAGE" ]]
      }
      openbitfun_image_docker() { echo amd64; }
      openbitfun_run_relay_image() { printf '%s %s\n' "$OPENBITFUN_RELAY_IMAGE" "$1"; }
      openbitfun_try_release_deploy
    `], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AVAILABLE_IMAGE: available, OPENBITFUN_RELAY_IMAGE: image,
        OPENBITFUN_RELAY_IMAGE_TAG: tag, OPENBITFUN_RELAY_IMAGE_DIGEST: pin,
        OPENBITFUN_REQUIRE_IMAGE_DIGEST: '', OPENBITFUN_GITHUB_RELEASE_BASE: '', OPENBITFUN_MIRROR_REQUESTED_MODE: 'global' },
    });
    assert.equal(result.status, available ? 0 : 1, result.stderr);
    assert.deepEqual(result.stderr.split('\n').filter((line) => line.startsWith('pull ')), pulls.map((ref) => `pull ${ref}`));
    assert.equal(result.stderr.includes('resolve latest'), resolves);
    if (available) assert.equal(result.stdout.trim(), `${available.split(/[:@]/)[0]} ${available}`);
  }
});

test('relay archive contains the runtime and admin binaries plus static assets', () => {
  const packageScript = read('scripts/relay/package-unix.sh');
  assert.match(packageScript, /openbitfun-relay-server/);
  assert.match(packageScript, /relay-admin/);
  assert.match(packageScript, /src\/apps\/relay-server\/static/);
  assert.match(packageScript, /\/health/);
  assert.match(packageScript, /\.sha256/);
});

test('source image is self-contained without the manual Compose static mount', () => {
  const sourceImage = read('src/apps/relay-server/Dockerfile');
  const context = read('.dockerignore');
  assert.match(sourceImage, /COPY src\/apps\/relay-server\/static\/ \/app\/static\//);
  assert.match(context, /^!src\/apps\/relay-server\/static\/$/m);
  assert.match(context, /^!src\/apps\/relay-server\/static\/\*\*$/m);
  assert.ok(read('src/apps/relay-server/static/index.html').length > 0);
});

test('formal and nightly releases gate publication on Linux binaries', () => {
  const desktop = read('.github/workflows/desktop-package.yml');
  const nightly = read('.github/workflows/nightly.yml');
  const nightlyArtifacts = read('.github/workflows/nightly-artifacts.yml');
  const reusable = read('.github/workflows/linux-binaries.yml');

  for (const workflow of [desktop, nightlyArtifacts]) {
    assert.match(workflow, /uses:\s+\.\/\.github\/workflows\/linux-binaries\.yml/);
  }
  assert.match(nightly, /uses:\s+\.\/\.github\/workflows\/nightly-artifacts\.yml/);
  assert.match(desktop, /needs:\s*\[[^\]]*linux-binaries[^\]]*\]/);
  assert.match(nightly, /needs:\s*\[[^\]]*build-artifacts[^\]]*\]/);

  for (const workflow of [desktop, nightly]) {
    assert.match(workflow, /openbitfun-relay-server-\*\.tar\.gz/);
    assert.match(workflow, /openbitfun-cli-\*\.tar\.gz/);
    assert.match(workflow, /linux-release-assets\/\*\.tar\.gz\.sig/);
    assert.match(workflow, /linux-release-assets\/\*\.tar\.gz\.sha256\.sig/);
    assert.match(workflow, /\$\{(?:cli|archive)_url\}\.sha256\.sig/);
    assert.match(workflow, /linux-binaries-v1\.json/);
  }

  assert.match(reusable, /ubuntu-24\.04-arm/);
  assert.match(reusable, /aarch64-unknown-linux-gnu/);
  assert.match(reusable, /x86_64-unknown-linux-gnu/);
  assert.match(reusable, /scripts\/relay\/package-unix\.sh/);
  assert.match(reusable, /scripts\/cli\/package-unix\.sh/);
});

test('formal and nightly releases publish signed anonymous multi-platform Relay images', () => {
  const formal = read('.github/workflows/desktop-package.yml');
  const nightly = read('.github/workflows/nightly.yml');
  const dockerfile = read('src/apps/relay-server/Dockerfile.release');
  const smoke = read('scripts/relay/smoke-image.sh');

  for (const workflow of [formal, nightly]) {
    assert.match(workflow, /packages:\s*write/);
    assert.match(workflow, /docker\/build-push-action@v7/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(
      workflow,
      /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/openbitfun-relay-server/,
    );
    assert.match(workflow, /relay-image\.json/);
    assert.match(workflow, /scripts\/sign-release-assets\.sh relay-image\.json/);
    assert.match(workflow, /scripts\/relay\/smoke-image\.sh/);
    assert.match(workflow, /Verify anonymous .*image access|Verify anonymous pull access/);
    assert.match(workflow, /DOCKER_CONFIG="\$clean_config" docker buildx imagetools inspect/);
  }
  assert.match(formal, /latest_release=.*releases\/latest/);
  assert.doesNotMatch(nightly, /openbitfun-relay-server:latest/);

  assert.match(smoke, /for arch in amd64 arm64/);
  assert.match(smoke, /\.State\.Health/);
  assert.match(smoke, /docker image rm "\$IMAGE_REF"/);
  assert.match(smoke, /docker logs --tail/);

  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/openBitFun\/OpenBitFun"/);
  assert.match(dockerfile, /TARGETARCH/);
  assert.match(dockerfile, /openbitfun-relay-server/);
  assert.match(dockerfile, /relay-admin/);
  assert.match(dockerfile, /debian:trixie-slim/);
});

test('exactly one workflow publishes the Linux CLI archives', () => {
  // Both cli-package.yml and desktop-package.yml run on `release: published`.
  // If both built Linux they would upload identical asset names concurrently,
  // and softprops/action-gh-release deletes a same-named asset before writing,
  // so the two runs can destroy each other's upload.
  const cli = read('.github/workflows/cli-package.yml');

  assert.doesNotMatch(cli, /target:\s*x86_64-unknown-linux-gnu/);
  assert.doesNotMatch(cli, /target:\s*aarch64-unknown-linux-gnu/);
  assert.doesNotMatch(cli, /uses:\s+\.\/\.github\/workflows\/linux-binaries\.yml/);

  // macOS and Windows stay owned by cli-package.yml.
  assert.match(cli, /target:\s*aarch64-apple-darwin/);
  assert.match(cli, /target:\s*x86_64-apple-darwin/);
  assert.match(cli, /target:\s*x86_64-pc-windows-msvc/);
});

test('release asset names carry no SemVer build metadata', () => {
  // GitHub rewrites `+` in stored asset filenames, which would make every URL
  // in linux-binaries-v1.json a 404 on the nightly channel.
  const reusable = read('.github/workflows/linux-binaries.yml');
  const nightly = read('.github/workflows/nightly.yml');

  assert.match(reusable, /ASSET_VERSION="\$\{RELEASE_VERSION%%\+\*\}"/);
  assert.match(reusable, /package-unix\.sh "\$ASSET_VERSION"/);
  assert.doesNotMatch(reusable, /package-unix\.sh "\$VERSION"/);
  assert.match(nightly, /--version "\$\{NIGHTLY_VERSION%%\+\*\}"/);
});

test('nightly publishes signed macOS CLI archives for SSH dispatch', () => {
  const nightlyArtifacts = read('.github/workflows/nightly-artifacts.yml');
  const nightly = read('.github/workflows/nightly.yml');

  assert.match(nightlyArtifacts, /Package macOS CLI for SSH dispatch/);
  assert.match(nightlyArtifacts, /scripts\/cli\/package-unix\.sh "\$ASSET_VERSION" "\$TARGET"/);
  assert.match(nightlyArtifacts, /steps\.macos-cli\.outputs\.archive/);
  assert.match(nightlyArtifacts, /openbitfun-cli-\*-apple-darwin\.tar\.gz\.sha256\.sig/);
  assert.match(nightly, /for target in aarch64-apple-darwin x86_64-apple-darwin/);
  assert.match(nightly, /\$\{archive\}\.sha256\.sig/);
});
