#!/usr/bin/env bash
#
# sync-release.sh — Mirror OpenBitFun release assets from GitHub to a download mirror.
#
# Flow:
#   1. Fetch the selected channel's latest-v1.json from GitHub
#   2. Mirror the signed Relay image descriptor and Linux binary manifest FIRST
#      (small trust metadata must not queue behind ~700 MB of Desktop packages)
#   3. If that version is already published, prune to KEEP_VERSIONS and stop
#   4. Otherwise download the new version, rewrite manifests, then prune
#
# Desktop / CLI auto-update reads latest-v1.json and linux-binaries-v1.json.
# Those files always name the current version, so the updater never needs a
# retained older directory. downloads.json is website-only and substitutes
# each manual_installers entry (Windows installer, macOS .dmg) for the
# corresponding updater package.
#
# Cron (every 10 minutes). Run the in-repo script from the OpenBitFun checkout so a
# new host only needs this repository, not a detached AutoUpdate copy:
#   */10 * * * * /root/repos/OpenBitFun/scripts/openbitfun-release-sync.sh \
#       >> /var/log/openbitfun-release-sync.log 2>&1
# Host-specific paths and mirror configuration belong to your deployment.
#
# Optional immediate trigger. The release workflow POSTs to
# ${OPENBITFUN_SYNC_WEBHOOK_URL} once assets are published (see the "Request
# openbitfun mirror sync" step in .github/workflows/desktop-package.yml) so a
# new release reaches the mirror in a couple of minutes rather than up to ten.
# Point that secret at any receiver that runs this script, for example:
#
#   while true; do
#     nc -l -p 8787 -q 1 >/dev/null \
#       && OPENBITFUN_RELEASE_CHANNEL=stable \
#            /root/repos/OpenBitFun/scripts/openbitfun-release-sync.sh \
#            >> /var/log/openbitfun-release-sync.log 2>&1
#   done
#
# The current production origin is cron-only. Do not invent a detached webhook
# listener unless OPENBITFUN_SYNC_WEBHOOK_URL is actually configured.
#
# Cron stays the source of truth: this script is idempotent and holds a flock,
# so a webhook run and a cron run cannot collide and a missed webhook only costs
# latency. Leaving the secret unset keeps the cron-only behaviour.
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
RELEASE_CHANNEL="${OPENBITFUN_RELEASE_CHANNEL:-stable}"
case "$RELEASE_CHANNEL" in
  stable)
    CHANNEL_PATH=""
    GITHUB_RELEASE_ROOT="https://github.com/GCWing/OpenBitFun/releases/latest/download"
    ;;
  beta)
    CHANNEL_PATH="/beta"
    GITHUB_RELEASE_ROOT="https://github.com/GCWing/OpenBitFun/releases/download/channel-v1-beta"
    ;;
  *)
    echo "Unsupported OPENBITFUN_RELEASE_CHANNEL: $RELEASE_CHANNEL" >&2
    exit 1
    ;;
esac
GITHUB_LATEST_JSON_URL="${GITHUB_RELEASE_ROOT}/latest-v1.json"
GITHUB_LINUX_BINARIES_URL="${GITHUB_RELEASE_ROOT}/linux-binaries-v1.json"
GITHUB_RELAY_IMAGE_URL="${GITHUB_RELEASE_ROOT}/relay-image.json"
OPENBITFUN_BASE_URL="https://openbitfun.com/release${CHANNEL_PATH}"
# The mirror deliberately lives outside the website checkout. It used to be
# OpenBitFun-Website/dist/release, but `npm run build` empties dist/, so every
# website deploy silently deleted the mirrored installers and manifests —
# breaking downloads and the updater fallback until someone noticed. nginx
# serves this directory through a `location ^~ /release/` alias instead.
WEBSITE_RELEASE_ROOT="${WEBSITE_RELEASE_DIR:-/srv/openbitfun-release}"
WEBSITE_RELEASE_DIR="${WEBSITE_RELEASE_ROOT}${CHANNEL_PATH}"
# Keep the lock off the Nginx /release/ alias. Override with
# OPENBITFUN_RELEASE_SYNC_LOCK if a host must share a lock across checkouts.
LOCK_FILE="${OPENBITFUN_RELEASE_SYNC_LOCK:-/var/lock/openbitfun-release-sync.lock}"
WINDOWS_INSTALLER_FILENAME="openbitfun-installer.exe"
WINDOWS_INSTALLER_URL=""
WINDOWS_INSTALLER_SIGNATURE_URL=""
WEBSITE_DOWNLOADS_MANIFEST="downloads.json"
KEEP_VERSIONS=2
CONNECT_TIMEOUT=30
MAX_TIME=1800          # per-request ceiling (30 min; installer packages can be large)
MAX_RETRIES=3
RETRY_DELAY=5
PYTHON="${PYTHON:-python3}"

# ── Helpers ────────────────────────────────────────────────────
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

download_asset() {
  local url="$1"
  local dest="$2"
  local filename tmp ok attempt
  filename="$(basename "$dest")"
  if [ -f "$dest" ]; then
    log "  Already exists: $filename"
    return 0
  fi

  tmp="${dest}.part"
  ok=0
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    if curl -fsSL \
        --connect-timeout "$CONNECT_TIMEOUT" \
        --max-time "$MAX_TIME" \
        -o "$tmp" "$url"; then
      mv "$tmp" "$dest"
      ok=1
      break
    fi
    log "  Retry $attempt/$MAX_RETRIES for $filename"
    sleep "$RETRY_DELAY"
  done
  if [ "$ok" -ne 1 ]; then
    rm -f "$tmp"
    log "ERROR: Failed to download $filename after $MAX_RETRIES attempts"
    return 1
  fi
}

# Publish a root manifest without exposing a partially copied JSON file to
# Nginx. The flock around the full sync guarantees one writer, and rename is
# atomic because the temporary file lives beside its destination.
publish_file_atomically() {
  local source="$1"
  local dest="$2"
  local tmp="${dest}.part"
  cp "$source" "$tmp"
  mv "$tmp" "$dest"
}

# Mirror the custom Windows installer used for interactive website installs.
# RELEASE_ASSET_BASE_URL is derived from latest-v1.json rather than from
# /releases/latest/download so the installer and setup package cannot come from
# different releases while GitHub is advancing the latest-release pointer.
mirror_windows_installer() {
  local installer_url signature_url metadata
  installer_url="${WINDOWS_INSTALLER_URL:-${RELEASE_ASSET_BASE_URL}/${WINDOWS_INSTALLER_FILENAME}}"
  signature_url="${WINDOWS_INSTALLER_SIGNATURE_URL:-${installer_url}.sig}"

  if [ -n "${LATEST_JSON:-}" ]; then
    metadata=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import json, sys
data = json.load(sys.stdin)
entry = data.get('manual_installers', {}).get('windows-x86_64')
if entry:
    print(entry['url'])
    print(entry.get('signature_url', entry['url'] + '.sig'))
")
    if [ -n "$metadata" ]; then
      installer_url=$(printf '%s\n' "$metadata" | sed -n '1p')
      signature_url=$(printf '%s\n' "$metadata" | sed -n '2p')
      if [ "${installer_url%/*}" != "$RELEASE_ASSET_BASE_URL" ]; then
        log "ERROR: Manual installer URL does not belong to the updater release: $installer_url"
        return 1
      fi
      if [ "$signature_url" != "${installer_url}.sig" ]; then
        log "ERROR: Manual installer signature URL does not match the installer URL"
        return 1
      fi
      WINDOWS_INSTALLER_FILENAME="${installer_url##*/}"
    fi
  fi

  log "  Mirroring website Windows installer: ${WINDOWS_INSTALLER_FILENAME}"
  download_asset \
    "$installer_url" \
    "${VERSION_DIR}/${WINDOWS_INSTALLER_FILENAME}" || exit 1
  download_asset \
    "$signature_url" \
    "${VERSION_DIR}/${WINDOWS_INSTALLER_FILENAME}.sig" || exit 1
}

# Build a website-only manifest from the already rewritten updater manifest.
# Every declared manual_installers entry replaces that platform's updater
# package; the rest keep the updater URL. The updater manifest is untouched.
write_website_download_manifest() {
  local output="${VERSION_DIR}/${WEBSITE_DOWNLOADS_MANIFEST}"
  local output_tmp="${output}.part"

  "$PYTHON" - \
    "${VERSION_DIR}/latest-v1.json" \
    "$output_tmp" \
    "$OPENBITFUN_BASE_URL" \
    "$WINDOWS_INSTALLER_FILENAME" <<'PY'
import json, sys

source, dest, base, windows_installer = sys.argv[1:]
with open(source, encoding="utf-8") as f:
    updater = json.load(f)

version = updater["version"]
version_base = f"{base}/{version}"
platforms = {}
for target, entry in updater.get("platforms", {}).items():
    url = entry.get("url")
    if url:
        platforms[target] = {"url": url}

windows = platforms.get("windows-x86_64")
if windows is None:
    raise SystemExit("latest-v1.json is missing windows-x86_64")

for target, manual in updater.get("manual_installers", {}).items():
    if target not in platforms:
        continue
    platforms[target]["url"] = manual["url"]
    platforms[target]["signatureUrl"] = manual.get("signature_url", manual["url"] + ".sig")

if "signatureUrl" not in windows:
    windows["url"] = f"{version_base}/{windows_installer}"
    windows["signatureUrl"] = f"{version_base}/{windows_installer}.sig"

website = {
    "schemaVersion": 1,
    "version": version,
    "platforms": platforms,
}
for optional_key in ("notes", "pub_date"):
    if optional_key in updater:
        website[optional_key] = updater[optional_key]

with open(dest, "w", encoding="utf-8") as f:
    json.dump(website, f, indent=2)
    f.write("\n")
PY
  mv "$output_tmp" "$output"
  log "Saved ${output}"
}

# Check the mirrored Linux archives against the `.sha256` sidecars mirrored with
# them. Reads the filename list on stdin, one per line.
#
# Scoped to the manifest's own assets rather than globbing `*.sha256`: the same
# directory also holds the Desktop packages, whose sidecars this script does not
# own and must not assume the format of. Deleting a good archive because a
# foreign sidecar was laid out differently would be worse than not checking.
#
# A mismatch means this run pulled a bad copy from GitHub, so the archive is
# removed: `download_asset` skips files that already exist, and leaving a corrupt
# one in place would make every later run treat it as done. Removing it lets the
# next run re-fetch and self-heal.
verify_mirrored_checksums() {
  local filename sidecar archive expected actual failed=0
  while IFS= read -r filename; do
    [ -n "$filename" ] || continue
    case "$filename" in
      *.sha256) ;;
      *) continue ;;
    esac
    sidecar="${VERSION_DIR}/${filename}"
    archive="${sidecar%.sha256}"
    if [ ! -f "$sidecar" ] || [ ! -f "$archive" ]; then
      continue
    fi
    expected="$(awk '{print $1; exit}' "$sidecar")"
    actual="$(sha256sum "$archive" | awk '{print $1}')"
    if [ "$expected" != "$actual" ]; then
      log "ERROR: checksum mismatch for $(basename "$archive"): expected $expected, got $actual"
      rm -f "$archive"
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    log "ERROR: refusing to publish a manifest for unverified assets"
    return 1
  fi
  return 0
}

# Fetch linux-binaries-v1.json into $LINUX_MANIFEST_TMP, retrying transient
# failures. Sets LINUX_MANIFEST_STATE to one of:
#   ok        — downloaded
#   missing   — GitHub answered 404: the release genuinely has no manifest
#   unhealthy — network/5xx: unknown, so callers must keep the published mirror
fetch_linux_manifest() {
  local attempt status
  LINUX_MANIFEST_STATE="unhealthy"
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    status="$(curl -sSL \
      --connect-timeout "$CONNECT_TIMEOUT" \
      --max-time "$MAX_TIME" \
      -o "$LINUX_MANIFEST_TMP" \
      -w '%{http_code}' \
      "$GITHUB_LINUX_BINARIES_URL" || echo "000")"
    if [ "$status" = "200" ]; then
      LINUX_MANIFEST_STATE="ok"
      return 0
    fi
    rm -f "$LINUX_MANIFEST_TMP"
    if [ "$status" = "404" ]; then
      LINUX_MANIFEST_STATE="missing"
      return 0
    fi
    log "  Retry $attempt/$MAX_RETRIES for linux-binaries-v1.json (HTTP $status)"
    sleep "$RETRY_DELAY"
  done
  return 0
}

# Mirror the CLI + Relay manifest and every asset it references.
#
# Runs BEFORE the Desktop packages on purpose. Desktop assets are ~700 MB per
# release; mirroring those first meant the window in which openbitfun advertised
# a release whose CLI/Relay bytes it could not yet serve was however long that
# took, not the 10-minute cron interval. These four archives are small, so
# publishing them first collapses that window to a couple of minutes.
mirror_linux_binaries() {
  LINUX_MANIFEST_TMP="${VERSION_DIR}/linux-binaries.github.json.part"
  LINUX_MANIFEST_STATE="missing"
  fetch_linux_manifest
  if [ "$LINUX_MANIFEST_STATE" = "ok" ]; then
    LINUX_VERSION=$("$PYTHON" -c \
      "import json,sys;print(json.load(open(sys.argv[1], encoding='utf-8'))['version'])" \
      "$LINUX_MANIFEST_TMP")
    if [ "$LINUX_VERSION" != "$VERSION" ]; then
      log "ERROR: Linux manifest version $LINUX_VERSION does not match Desktop version $VERSION"
      rm -f "$LINUX_MANIFEST_TMP"
      exit 1
    fi

    LINUX_ASSET_LIST=$("$PYTHON" - "$LINUX_MANIFEST_TMP" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
seen = set()
for platform in data.get("platforms", {}).values():
    for product in ("cli", "relay"):
        entry = platform.get(product, {})
        # Signatures too: without them the mirrored copy cannot be verified as
        # anything stronger than "not corrupted in transit".
        for key in ("url", "sha256Url", "sha256SigUrl", "sigUrl"):
            url = entry.get(key)
            if not url:
                continue
            filename = url.rsplit("/", 1)[-1]
            if filename not in seen:
                seen.add(filename)
                print(f"{url}\t{filename}")
PY
)
    while IFS=$'\t' read -r url filename; do
      [ -z "$url" ] && continue
      log "  Mirroring Linux binary asset: $filename"
      download_asset "$url" "${VERSION_DIR}/${filename}" || exit 1
    done <<< "$LINUX_ASSET_LIST"

    # Verify before publishing the manifest that points at these bytes.
    #
    # Clients check an archive against the checksum served next to it. When both
    # come from here, mirroring a corrupted archive alongside its original
    # checksum is the one failure that verification cannot catch — every
    # downstream install would then fail, or worse, succeed on bad bytes if the
    # corruption also reached the sidecar. Checking here is the only place the
    # two copies can still be compared.
    cut -f2 <<< "$LINUX_ASSET_LIST" | verify_mirrored_checksums || exit 1

    "$PYTHON" - "$LINUX_MANIFEST_TMP" "${VERSION_DIR}/linux-binaries-v1.json" \
      "$OPENBITFUN_BASE_URL" <<'PY'
import json, sys
source, dest, base = sys.argv[1:]
with open(source, encoding="utf-8") as f:
    data = json.load(f)
version_base = f"{base}/{data['version']}"
for platform in data.get("platforms", {}).values():
    for product in ("cli", "relay"):
        entry = platform.get(product, {})
        for key in ("url", "sha256Url", "sha256SigUrl", "sigUrl"):
            if entry.get(key):
                entry[key] = f"{version_base}/{entry[key].rsplit('/', 1)[-1]}"
with open(dest, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    rm -f "$LINUX_MANIFEST_TMP"
    publish_file_atomically \
      "${VERSION_DIR}/linux-binaries-v1.json" \
      "${WEBSITE_RELEASE_DIR}/linux-binaries-v1.json"
    log "Updated ${WEBSITE_RELEASE_DIR}/linux-binaries-v1.json"
  elif [ "$LINUX_MANIFEST_STATE" = "missing" ]; then
    rm -f "${WEBSITE_RELEASE_DIR}/linux-binaries-v1.json"
    log "Linux binaries manifest is not present in the latest release yet; Desktop mirror only."
  else
    # Transient failure. Keep whatever is already published: CLI self-update and
    # one-click Relay deploy both fall back to this file, so a single flaky run
    # must not take it offline for the next 10 minutes.
    log "WARN: Linux binaries manifest unreachable this run; keeping the published mirror."
  fi
}

# macOS SSH Dispatch uses the standalone CLI archives published by the CLI
# workflow after the Desktop release exists. They are not represented by
# linux-binaries-v1.json, so mirror the deterministic names separately. Missing
# files are normal while that second workflow is still publishing; a later cron
# run completes the set atomically enough for clients (every install verifies
# the signed checksum before using an archive).
mirror_dispatch_macos_cli_archives() {
  local target filename base_url suffix ready failed checksum_list
  checksum_list=""
  for target in x86_64-apple-darwin aarch64-apple-darwin; do
    filename="openbitfun-cli-${VERSION}-${target}.tar.gz"
    base_url="${RELEASE_ASSET_BASE_URL}/${filename}"
    ready=1
    for suffix in "" .sha256 .sha256.sig .sig; do
      if ! curl -fsSIL \
        --connect-timeout "$CONNECT_TIMEOUT" \
        --max-time "$MAX_TIME" \
        "${base_url}${suffix}" >/dev/null; then
        ready=0
        break
      fi
    done
    if [ "$ready" -ne 1 ]; then
      log "  macOS Dispatch CLI set is not complete yet: $filename"
      continue
    fi

    failed=0
    for suffix in "" .sha256 .sha256.sig .sig; do
      log "  Mirroring macOS Dispatch CLI asset: ${filename}${suffix}"
      if ! download_asset \
        "${base_url}${suffix}" \
        "${VERSION_DIR}/${filename}${suffix}"; then
        failed=1
        break
      fi
    done
    if [ "$failed" -ne 0 ]; then
      rm -f \
        "${VERSION_DIR}/${filename}" \
        "${VERSION_DIR}/${filename}.sha256" \
        "${VERSION_DIR}/${filename}.sha256.sig" \
        "${VERSION_DIR}/${filename}.sig"
      log "WARN: incomplete macOS Dispatch CLI set removed; retrying next sync."
      continue
    fi
    checksum_list="${checksum_list}${filename}.sha256"$'\n'
  done

  if [ -n "$checksum_list" ]; then
    printf '%s' "$checksum_list" | verify_mirrored_checksums || exit 1
  fi
}

# Mirror the signed, digest-pinned container descriptor before large Desktop
# assets. The mirror is not trusted: Desktop verifies relay-image.json.sig with
# its compiled-in minisign key before sending the digest to a customer server.
mirror_relay_image_descriptor() {
  local descriptor_tmp signature_tmp status descriptor_version
  descriptor_tmp="${VERSION_DIR}/relay-image.json.part"
  signature_tmp="${VERSION_DIR}/relay-image.json.sig.part"
  rm -f "$descriptor_tmp" "$signature_tmp"

  status="$(curl -sSL \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -o "$descriptor_tmp" -w '%{http_code}' "$GITHUB_RELAY_IMAGE_URL" || echo 000)"
  if [ "$status" = "404" ]; then
    log "Relay image descriptor is not present in the latest release yet."
    rm -f "$descriptor_tmp"
    return 0
  fi
  if [ "$status" != "200" ]; then
    log "WARN: relay-image.json unreachable (HTTP $status); keeping any existing versioned copy."
    rm -f "$descriptor_tmp"
    return 0
  fi
  if ! curl -fsSL --retry "$MAX_RETRIES" --retry-delay "$RETRY_DELAY" \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -o "$signature_tmp" "${GITHUB_RELAY_IMAGE_URL}.sig"; then
    log "WARN: relay-image.json.sig unreachable; refusing to publish an unsigned descriptor."
    rm -f "$descriptor_tmp" "$signature_tmp"
    return 0
  fi

  descriptor_version="$("$PYTHON" - "$descriptor_tmp" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
assert data.get("schema_version") == 1
assert data.get("image") == "ghcr.io/gcwing/openbitfun-relay-server"
assert re.fullmatch(r"sha256:[0-9a-f]{64}", data.get("digest", ""))
print(data["version"])
PY
)" || {
    log "ERROR: relay-image.json failed its schema/repository/digest checks"
    rm -f "$descriptor_tmp" "$signature_tmp"
    return 1
  }
  if [ "$descriptor_version" != "$VERSION" ]; then
    log "ERROR: Relay image descriptor version $descriptor_version does not match Desktop version $VERSION"
    rm -f "$descriptor_tmp" "$signature_tmp"
    return 1
  fi

  mv "$descriptor_tmp" "${VERSION_DIR}/relay-image.json"
  mv "$signature_tmp" "${VERSION_DIR}/relay-image.json.sig"
  publish_file_atomically \
    "${VERSION_DIR}/relay-image.json" \
    "${WEBSITE_RELEASE_DIR}/relay-image.json"
  publish_file_atomically \
    "${VERSION_DIR}/relay-image.json.sig" \
    "${WEBSITE_RELEASE_DIR}/relay-image.json.sig"
  log "Published signed Relay image descriptor for $VERSION"
}

# ── Main ───────────────────────────────────────────────────────
main() {
  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
    log "Another release sync is still running; skipping this interval."
    exit 0
  fi

  log "=== OpenBitFun ${RELEASE_CHANNEL} release sync started ==="

  mkdir -p "$WEBSITE_RELEASE_DIR"

  # 1. Fetch latest-v1.json from GitHub
  log "Fetching latest-v1.json from GitHub..."
  LATEST_JSON=$(curl -fsSL \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    "$GITHUB_LATEST_JSON_URL") || {
    log "ERROR: Failed to fetch latest-v1.json from GitHub"
    exit 1
  }

  # 2. Extract version
  VERSION=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c \
    "import sys,json;print(json.load(sys.stdin)['version'])") || {
    log "ERROR: Failed to parse version from latest-v1.json"
    exit 1
  }
  log "Latest version: $VERSION"

  PUBLISHED_VERSION=""
  if [ -f "${WEBSITE_RELEASE_DIR}/latest-v1.json" ]; then
    PUBLISHED_VERSION=$("$PYTHON" -c \
      "import json,sys;print(json.load(open(sys.argv[1], encoding='utf-8'))['version'])" \
      "${WEBSITE_RELEASE_DIR}/latest-v1.json") || PUBLISHED_VERSION=""
  fi
  if [ -n "$PUBLISHED_VERSION" ] && [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
    log "Already mirroring $VERSION; nothing to fetch"
    prune_old_versions
    log "=== ${RELEASE_CHANNEL} sync complete: version $VERSION (unchanged) ==="
    exit 0
  fi

  # Resolve one immutable release directory for every artifact. Independent
  # latest/download requests can cross versions while a release is published.
  RELEASE_ASSET_BASE_URL=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import json, sys
data = json.load(sys.stdin)
bases = {entry['url'].rsplit('/', 1)[0] for entry in data.get('platforms', {}).values() if entry.get('url')}
if len(bases) != 1:
    raise SystemExit(f'expected one release asset base, got {sorted(bases)}')
print(bases.pop())
") || {
    log "ERROR: Failed to resolve the release asset base from latest-v1.json"
    exit 1
  }

  GITHUB_RELAY_IMAGE_URL="${RELEASE_ASSET_BASE_URL}/relay-image.json"
  GITHUB_LINUX_BINARIES_URL="${RELEASE_ASSET_BASE_URL}/linux-binaries-v1.json"

  INSTALLER_METADATA=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import json, sys
data = json.load(sys.stdin)
entry = data.get('manual_installers', {}).get('windows-x86_64')
if entry:
    print(entry['url'])
    print(entry.get('signature_url', entry['url'] + '.sig'))
") || {
    log "ERROR: Failed to resolve the manual Windows installer from latest-v1.json"
    exit 1
  }
  if [ -n "$INSTALLER_METADATA" ]; then
    WINDOWS_INSTALLER_URL=$(printf '%s\n' "$INSTALLER_METADATA" | sed -n '1p')
    WINDOWS_INSTALLER_SIGNATURE_URL=$(printf '%s\n' "$INSTALLER_METADATA" | sed -n '2p')
    if [ "${WINDOWS_INSTALLER_URL%/*}" != "$RELEASE_ASSET_BASE_URL" ]; then
      log "ERROR: Manual installer URL does not belong to release $VERSION"
      exit 1
    fi
    if [ "$WINDOWS_INSTALLER_SIGNATURE_URL" != "${WINDOWS_INSTALLER_URL}.sig" ]; then
      log "ERROR: Manual installer signature URL does not match the installer URL"
      exit 1
    fi
    WINDOWS_INSTALLER_FILENAME="${WINDOWS_INSTALLER_URL##*/}"
  else
    WINDOWS_INSTALLER_URL="${RELEASE_ASSET_BASE_URL}/${WINDOWS_INSTALLER_FILENAME}"
    WINDOWS_INSTALLER_SIGNATURE_URL="${WINDOWS_INSTALLER_URL}.sig"
  fi

  # 3. Create version directory
  VERSION_DIR="${WEBSITE_RELEASE_DIR}/${VERSION}"
  mkdir -p "$VERSION_DIR"

  # 4. Stable owns the CLI/Relay floating manifests. The first beta slice only
  # mirrors Desktop updater and installer assets under /release/beta.
  if [ "$RELEASE_CHANNEL" = "stable" ]; then
    mirror_relay_image_descriptor
    mirror_linux_binaries
    mirror_dispatch_macos_cli_archives
  else
    log "Skipping stable-only CLI and Relay metadata for the beta channel"
  fi

  # 5. Download all platform installer packages
  #    Extract "<url>\t<filename>" pairs, then curl each one.
  ASSET_LIST=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import sys, json
data = json.load(sys.stdin)
for p, info in data.get('platforms', {}).items():
    url = info['url']
    fname = url.split('/')[-1]
    print(f'{url}\t{fname}')
") || {
    log "ERROR: Failed to extract asset list from latest-v1.json"
    exit 1
  }

  while IFS=$'\t' read -r url filename; do
    [ -z "$url" ] && continue
    log "  Mirroring Desktop asset: $filename"
    download_asset "$url" "${VERSION_DIR}/${filename}" || exit 1
  done <<< "$ASSET_LIST"

  # Mirror declared installers separately; the updater URLs stay in platforms.
  mirror_windows_installer
  EXTRA_INSTALLERS=$(printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import json, sys
data = json.load(sys.stdin)
for target, entry in data.get('manual_installers', {}).items():
    if target == 'windows-x86_64':
        continue
    url = entry.get('url')
    if url:
        print(url)
        print(entry.get('signature_url', url + '.sig'))
")
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    log "  Mirroring installer: ${url##*/}"
    download_asset "$url" "${VERSION_DIR}/${url##*/}" || exit 1
  done <<< "$EXTRA_INSTALLERS"

  # 6. Rewrite URLs in latest-v1.json to point at openbitfun.com
  LATEST_MANIFEST_TMP="${VERSION_DIR}/latest-v1.json.part"
  printf '%s' "$LATEST_JSON" | "$PYTHON" -c "
import sys, json
data = json.load(sys.stdin)
version = data['version']
base = '${OPENBITFUN_BASE_URL}/' + version
for p, info in data.get('platforms', {}).items():
    fname = info['url'].split('/')[-1]
    info['url'] = base + '/' + fname
for p, info in data.get('manual_installers', {}).items():
    for key in ('url', 'signature_url'):
        if info.get(key):
            info[key] = base + '/' + info[key].split('/')[-1]
print(json.dumps(data, indent=2))
" > "$LATEST_MANIFEST_TMP"
  mv "$LATEST_MANIFEST_TMP" "${VERSION_DIR}/latest-v1.json"
  log "Saved ${VERSION_DIR}/latest-v1.json"

  # 7. Generate the website manifest, then atomically publish both root files.
  write_website_download_manifest
  publish_file_atomically \
    "${VERSION_DIR}/latest-v1.json" \
    "${WEBSITE_RELEASE_DIR}/latest-v1.json"
  log "Updated ${WEBSITE_RELEASE_DIR}/latest-v1.json"
  publish_file_atomically \
    "${VERSION_DIR}/${WEBSITE_DOWNLOADS_MANIFEST}" \
    "${WEBSITE_RELEASE_DIR}/${WEBSITE_DOWNLOADS_MANIFEST}"
  log "Updated ${WEBSITE_RELEASE_DIR}/${WEBSITE_DOWNLOADS_MANIFEST}"

  prune_old_versions
  log "=== ${RELEASE_CHANNEL} sync complete: version $VERSION ==="
}

prune_old_versions() {
  local dirs=() total remove_count i
  while IFS= read -r d; do
    dirs+=("$d")
  done < <("$PYTHON" - "$WEBSITE_RELEASE_DIR" <<'PY'
import os, re, sys
root = sys.argv[1]
names = [name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))]

def key(name):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-(.+))?", name)
    if not match:
        return (0, 0, 0, 0, name)
    pre = match.group(4)
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), 1 if pre is None else 0, pre or "")

for name in sorted(names, key=key):
    print(os.path.join(root, name))
PY
)
  total=${#dirs[@]}
  if [ "$total" -le "$KEEP_VERSIONS" ]; then
    return 0
  fi
  remove_count=$((total - KEEP_VERSIONS))
  for ((i = 0; i < remove_count; i++)); do
    log "Removing old version: $(basename "${dirs[$i]}")"
    rm -rf "${dirs[$i]}"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
