# Release Channels

OpenBitFun packages use an immutable build-time release channel. End users do not
switch channels at runtime.

## Stable

Stable releases continue to be driven by a version bump on `main`. The
`Release On Version Bump` workflow creates `vMAJOR.MINOR.PATCH` and dispatches
`Desktop Package` with the default `stable` channel.

The first final 1.x release is **`1.0.0`**, tag **`v1.0.0`**. It uses
`release_channel=stable`, `upload_to_release=true`,
`prerelease=false`, and explicit `make_latest=true`. The version spelling and
GitHub release status are separate contracts. Merging this version bump to
`main` triggers packaging and publication; preparing it locally does not.

Before a manual publishing run, push the immutable version tag to the repository
being built. Artifact-only builds may omit it. The workflow rejects missing or
mismatched publishing tags before compiling. The version-bump workflow creates
its tag automatically. Release creation and editing use GitHub CLI without
`--target`: sending `target_commitish` for workflow-changing commits can require
`workflows:write`, even for an existing tag. Asset upload precedes publication.

## Mobile Android releases

Mobile Android packages are released independently from Desktop packages. Use a
`mobile-vMAJOR.MINOR.PATCH` tag (or a prerelease suffix such as
`mobile-v1.1.0-beta.1`) to trigger [`Mobile Package`](../../.github/workflows/mobile-package.yml).
The workflow builds a signed APK in GitHub Actions and publishes it to its own
GitHub Release. It does not add Android assets to the Desktop `v*` Release.

The Android workflow requires the repository secrets
`OPENBITFUN_ANDROID_KEYSTORE_B64`, `OPENBITFUN_ANDROID_KEYSTORE_PASSWORD`,
`OPENBITFUN_ANDROID_KEY_ALIAS`, and `OPENBITFUN_ANDROID_KEY_PASSWORD`. The
keystore is decoded only into the ephemeral Actions runner. Mobile Android
versions are checked as a group across the Android, iOS, and HarmonyOS version
files, but they do not need to equal the Desktop version.

GitHub exposes one repository-wide `Latest` release. Link the Desktop and Mobile
release pages separately from the project download page and the Desktop release
notes.

## Legacy update isolation

Desktop 1.x reads `latest-v1.json`; CLI 1.x reads `linux-binaries-v1.json`,
from GitHub Latest or `/release/` on the mirror. Every stable release also carries
the pinned legacy feeds `latest.json` and `linux-binaries.json` from
`scripts/fixtures/legacy-update-feeds/`. The desktop feed carries version 0.2.20
with a release note that points 0.2.x users to the manual 1.x download and the
Data Migrator; its `platforms` block still resolves to the final 0.2.19
artifacts, so the notice never installs 1.x into a 0.2.x client. The CLI feed
stays byte-for-byte on 0.2.19 because the legacy CLI manifest has no note field.
Preservation validates the copied manifests with an inline Node check (the
desktop feed must be version 0.2.20 with non-empty notes; the CLI feed must be
0.2.19) and the publication step byte-compares the uploaded feeds against the
pinned fixtures, so a drifting fixture or a stale upload fails the run. Do not
rename the 1.x manifests back to the legacy
filenames, and keep the pinned fixtures' `platforms` signatures unchanged.

The mirror writes only the versioned 1.x feeds and keeps the two newest
version directories. It does not retain 0.2.x artifact trees; 0.2.x clients
keep reading the unchanged `latest.json` / `linux-binaries.json` assets on
GitHub Latest. Deploy the updated mirror script before the release and verify
the new feed versions afterwards.
The old `channel-beta/latest.json` pointer is not modified; new prerelease builds
use `channel-v1-beta/latest-v1.json`. The final `1.0.0` version sorts above
both `1.0.0-beta` and numbered `1.0.0-beta.N` versions. Stable publication
promotes the beta pointer only if it would not downgrade a newer beta; verify
that pointer after publication. The historical `1.0.0-beta` launch sorted below
numbered betas and required manual installation for those users.

This isolation controls in-app update checks, not GitHub's own notifications
for users who subscribe to repository releases.

## Beta

Run `Desktop Package` manually with:

- `tag_name`: the immutable release tag, for example `v1.0.1-beta.1`;
- `checkout_ref`: the commit or branch to build; publication requires the tag
  to exist and resolve to this exact commit;
- `release_channel`: `beta`;
- `upload_to_release`: disabled for internal Actions artifacts, enabled for a
  public GitHub pre-release.

Beta versions target the next stable version. If stable is `1.0.0`, the first
candidate is `1.0.1-beta.1`, not `1.0.0-beta.1`. Do not use SemVer build
metadata in a published package version; the release already records the Git
commit separately.

Public beta assets are stored on the immutable version tag. After every asset
and signature is verified, the workflow updates only the `latest-v1.json` asset on
the `channel-v1-beta` pre-release. Beta Desktop builds read that pointer and fall
back to `https://openbitfun.com/release/beta/latest-v1.json`.
Beta releases include Desktop and Installer assets, Linux CLI and Relay Server
archives for x86_64 and aarch64, and a multi-platform Relay image for linux/amd64
and linux/arm64. Release publication requires every producer to succeed. Archives
include checksums and signatures; `linux-binaries-v1.json` and the signed
`relay-image.json` descriptor live on the immutable version release.

Relay images use `ghcr.io/<repository-owner>/openbitfun-relay-server` with the
version tags `v1.0.0-beta.N` and `1.0.0-beta.N`. Beta never updates the `latest`
image tag. Fork builds publish to the fork owner's image namespace and their
own GitHub Release URLs. GHCR credentials must permit package publication, and
the package must be publicly readable for the anonymous-pull verification to
pass.

With `upload_to_release` disabled, the workflow keeps CLI/Relay archives in
Actions artifacts and validates the runtime image build without pushing it.
The explicit `relay_image_only` backfill mode remains a publishing operation.
It resolves the same immutable tag as the existing archives, rather than the
current workflow commit. Releases predating the current OpenBitFun artifact
layout are not image-rebuild inputs.

Install Beta CLI archives manually and deploy the Relay with an explicit Beta
image tag or its signed descriptor's digest. The default CLI install/update and
Relay one-click deployment paths stay on stable; Beta CLI builds do not run
stable-feed automatic update checks. This does not add a runtime channel switch
or a Beta option to one-click deployment. The stable CLI/Relay mirror manifests
and the Desktop-only `channel-v1-beta/latest-v1.json` pointer remain unchanged.
When no usable current stable Relay image exists, one-click deployment builds
current source on the target host automatically. It does not deploy a differently
named product image or silently promote a Beta image to stable.

The selected ref must resolve to a commit in the protected `main` history. The
workflow pins that SHA before dispatching platform jobs and rejects an existing
release tag if it points somewhere else. Configure the signing secrets and the
public beta approval policy so untrusted pull-request code cannot access them.
This protected-history requirement applies to the canonical `GCWing/OpenBitFun`
repository; forks may run packaging from their own test branches. A fork beta
uses that fork's `channel-v1-beta` release as both updater origins, so it cannot
silently consume or mutate the canonical beta channel.

A stable release promotes the beta pointer only when its version is not older
than the current beta. This lets beta users move from `1.0.1-beta.N` to
`1.0.1` without allowing a late workflow to roll the channel backward.

Beta and stable currently share the same bundle identity and data directories.
Installing beta replaces stable; side-by-side installation is not supported.

## Mirror

The mirror script defaults to stable. Run a separate beta sync with:

```bash
OPENBITFUN_RELEASE_CHANNEL=beta scripts/openbitfun-release-sync.sh
```

The beta invocation writes below `/release/beta` and intentionally skips the
stable-only CLI and Relay floating manifests.

Production cron must run this in-repo script from the OpenBitFun checkout. Do not
create a detached copy. Host paths, Nginx, and the rest of the origin restore
steps live in [`deploy/openbitfun-host/README.md`](../../deploy/openbitfun-host/README.md).
The sync resolves the exact release directory from the updater manifest once;
Relay and Linux metadata use that same directory to avoid mixed-version reads
when GitHub's latest-release pointer changes. Publication also compares the
downloaded Relay descriptor and signature to the image job's signed bytes.

## Focused packaging checks

### 1.0.0 release verification

Before merging the version bump to `main`:

- Run `pnpm run release:version:check`, `pnpm run test:release-packaging`,
  `pnpm run check:github-config`, and the focused Relay packaging checks below.
- Review the release commit and CI results; confirm `v1.0.0` is not already
  assigned to another commit. Merging the bump starts publication automatically.
- Verify the publishing repository has the updater signing key, Windows
  Authenticode credentials, Apple signing/notarization credentials, and GHCR
  publishing access required by `desktop-package.yml`.
- Exercise an upgrade from `1.0.0-beta` with existing settings and sessions,
  and from a numbered beta through the beta feed. Exercise remote workspace,
  remote control, Peer Device Mode, and Detached Dispatch with supported older
  peers. Record actual results separately; packaging fixtures do not establish
  runtime compatibility.

Delivery is complete only after the workflow and published assets are verified:

- `v1.0.0` is published with `prerelease=false` and is GitHub Latest.
- Desktop packages exist for Windows x64, macOS arm64/x64, and Linux arm64/x64;
  the custom Windows installer, updater artifacts, and signatures are present.
- Linux CLI/Relay archives, checksums, signatures, `linux-binaries-v1.json`,
  and the signed `relay-image.json` are downloadable. The multi-platform Relay
  image is anonymously pullable.
- `latest-v1.json` reports `1.0.0` and references downloadable signed artifacts.
  Legacy `latest.json` and `linux-binaries.json` still report `0.2.19`.
- Verify the mirror and eligible beta pointer after synchronization, then
  smoke-test installation and update using the published downloads.

For release workflow and channel-isolation changes, run
`pnpm run check:github-config` and
`node --test scripts/relay/package-contract.test.mjs scripts/tauri-release-manifest.test.mjs`.
These checks exercise release conditions, image tag selection, Beta manifest
generation, and asset collection with fixtures; they do not build or publish packages.

The inaugural public `1.0.0-beta` release supports marketplace packages declaring
minimum OpenBitFun `1.0.0`. This is an explicit product compatibility exception;
numbered beta and RC builds retain their normal SemVer ordering, and updater
version comparisons are unchanged. Requirements above `1.0.0` still reject this
release. The shared policy lives in `product-domains::product_release`.
