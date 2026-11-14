#!/usr/bin/env bash
# OpenBitFun Relay Server — pull and start the published multi-platform image.
#
# Shared by:
#   - src/apps/relay-server/deploy.sh
#   - remote_ssh/relay_deploy.rs (embedded with include_str!)
#
# The Desktop path supplies OPENBITFUN_RELAY_IMAGE_DIGEST from a minisign-verified
# release descriptor. Docker then verifies every manifest/layer against that
# immutable digest while pulling through either the official registry or a
# China acceleration prefix. The old download-archive + local image-construction
# path is intentionally gone.
#
# Configuration:
#   OPENBITFUN_RELAY_IMAGE          explicit image repository override
#   OPENBITFUN_RELAY_IMAGE_DIGEST   sha256:<64 lowercase hex> (required by Desktop)
#   OPENBITFUN_RELAY_IMAGE_TAG      manual-script fallback tag (default release tag)
#   OPENBITFUN_IMAGE_PULL_TIMEOUT   per-route pull timeout in seconds (default 900)
#   OPENBITFUN_GITHUB_PROBE_WINDOW  GitHub throughput probe window (default 10s)
#   OPENBITFUN_GITHUB_HEALTHY_BPS   keep GitHub first at/above this rate (default 512 KiB/s)
#   OPENBITFUN_MIRROR_MODE          cn | global
#   RELAY_PORT                  published/container port (default 9700)
#   RELAY_HOST_BIND_IP          host bind address (default 0.0.0.0)

OPENBITFUN_DEFAULT_RELAY_IMAGE="ghcr.io/openbitfun/openbitfun-relay-server"
OPENBITFUN_LEGACY_RELAY_IMAGE="ghcr.io/gcwing/openbitfun-relay-server"
OPENBITFUN_RELAY_IMAGE_OVERRIDE="${OPENBITFUN_RELAY_IMAGE:-}"
OPENBITFUN_RELAY_IMAGE="${OPENBITFUN_RELAY_IMAGE_OVERRIDE:-$OPENBITFUN_DEFAULT_RELAY_IMAGE}"
OPENBITFUN_RELAY_IMAGE_TAG="${OPENBITFUN_RELAY_IMAGE_TAG:-${OPENBITFUN_RELEASE_TAG:-latest}}"
OPENBITFUN_IMAGE_PULL_TIMEOUT="${OPENBITFUN_IMAGE_PULL_TIMEOUT:-900}"
OPENBITFUN_GITHUB_PROBE_WINDOW="${OPENBITFUN_GITHUB_PROBE_WINDOW:-10}"
OPENBITFUN_GITHUB_HEALTHY_BPS="${OPENBITFUN_GITHUB_HEALTHY_BPS:-524288}"
OPENBITFUN_GITHUB_RELEASE_BASE="${OPENBITFUN_GITHUB_RELEASE_BASE:-https://github.com/openBitFun/OpenBitFun/releases}"

# The embedded Desktop helpers call Docker through openbitfun_docker; the manual
# script exposes docker_cmd. Keep this file independent of either caller.
openbitfun_image_docker() {
  if declare -F openbitfun_docker >/dev/null 2>&1; then
    openbitfun_docker "$@"
  elif declare -F docker_cmd >/dev/null 2>&1; then
    docker_cmd "$@"
  else
    docker "$@"
  fi
}

# POSIX-quote arguments passed through `sg docker -c`.
openbitfun_image_shell_join() {
  local out="" arg
  for arg in "$@"; do
    out="$out'$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")' "
  done
  printf '%s' "$out"
}

# Bound each registry route. A dead accelerator must not prevent falling back
# to the next route forever. Hosts without GNU timeout still retain Docker's
# own network timeouts and progress reporting.
openbitfun_image_docker_with_timeout() {
  local seconds="$1"
  shift
  if ! command -v timeout >/dev/null 2>&1; then
    openbitfun_image_docker "$@"
    return
  fi
  case "${OPENBITFUN_DOCKER_MODE:-direct}" in
    sg)
      sg docker -c "$(openbitfun_image_shell_join timeout "$seconds" docker "$@")"
      ;;
    sudo)
      if sudo -n true >/dev/null 2>&1; then
        sudo -n timeout "$seconds" docker "$@"
      else
        sudo timeout "$seconds" docker "$@"
      fi
      ;;
    *) timeout "$seconds" docker "$@" ;;
  esac
}

openbitfun_relay_native_platform() {
  case "$(uname -m 2>/dev/null)" in
    x86_64 | amd64) echo linux/amd64 ;;
    aarch64 | arm64) echo linux/arm64 ;;
    *) return 1 ;;
  esac
}

openbitfun_relay_image_ref() {
  local repository="$1"
  if [ -n "${OPENBITFUN_RELAY_IMAGE_DIGEST:-}" ]; then
    printf '%s@%s' "$repository" "$OPENBITFUN_RELAY_IMAGE_DIGEST"
  else
    printf '%s:%s' "$repository" "$OPENBITFUN_RELAY_IMAGE_TAG"
  fi
}

# Legacy `latest` stops advancing after the transfer. Resolve GitHub's current
# release tag before trying the old registry so an outage cannot install an
# older build. Explicit tag and digest requests already identify the image.
openbitfun_legacy_relay_tag() {
  if [ "$OPENBITFUN_RELAY_IMAGE_TAG" != latest ] || [ -n "${OPENBITFUN_RELAY_IMAGE_DIGEST:-}" ]; then
    printf '%s\n' "$OPENBITFUN_RELAY_IMAGE_TAG"
    return
  fi

  local release_url tag
  release_url="$(curl -fsSLI --max-time 15 -o /dev/null -w '%{url_effective}' \
    "${OPENBITFUN_GITHUB_RELEASE_BASE}/latest")" || return 1
  tag="${release_url##*/releases/tag/}"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-beta)?$ ]] || return 1
  printf '%s\n' "$tag"
}

openbitfun_relay_archive_target() {
  case "$1" in
    linux/amd64) echo x86_64-unknown-linux-gnu ;;
    linux/arm64) echo aarch64-unknown-linux-gnu ;;
    *) return 1 ;;
  esac
}

# Measure the GitHub release CDN that carries the exact Relay binary bytes.
# Relay itself stays a digest-pinned OCI deployment; this byte probe decides
# whether official GHCR or its accelerators are attempted first.
openbitfun_probe_github_throughput() {
  local platform="$1" target tag url metrics speed
  target="$(openbitfun_relay_archive_target "$platform")" || {
    echo 0
    return 0
  }
  tag="${OPENBITFUN_RELEASE_TAG:-latest}"
  if [ "$tag" = latest ]; then
    url="${OPENBITFUN_GITHUB_RELEASE_BASE}/latest/download/openbitfun-relay-server-${target}.tar.gz"
  else
    url="${OPENBITFUN_GITHUB_RELEASE_BASE}/download/${tag}/openbitfun-relay-server-${target}.tar.gz"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo ">>> GitHub throughput probe skipped: curl is unavailable" >&2
    echo 0
    return 0
  fi
  case "$OPENBITFUN_GITHUB_PROBE_WINDOW" in
    '' | *[!0-9]*) OPENBITFUN_GITHUB_PROBE_WINDOW=10 ;;
  esac
  case "$OPENBITFUN_GITHUB_HEALTHY_BPS" in
    '' | *[!0-9]*) OPENBITFUN_GITHUB_HEALTHY_BPS=524288 ;;
  esac
  metrics="$(curl -LsS \
    --range 0-4194303 \
    --connect-timeout 5 \
    --max-time "$OPENBITFUN_GITHUB_PROBE_WINDOW" \
    -o /dev/null \
    -w '%{http_code} %{size_download} %{time_total}' \
    "$url" 2>/dev/null || true)"
  speed="$(printf '%s\n' "$metrics" | awk '
    ($1 == 200 || $1 == 206) && $3 > 0 { printf "%.0f\n", $2 / $3; ok=1 }
    END { if (!ok) print 0 }
  ')"
  case "$speed" in
    '' | *[!0-9]*) speed=0 ;;
  esac
  echo ">>> GitHub Relay probe: $((speed / 1024)) KiB/s (healthy floor: $((OPENBITFUN_GITHUB_HEALTHY_BPS / 1024)) KiB/s)" >&2
  echo "$speed"
}

# GitHub is the default route. In auto mode, a measured GitHub rate below
# 512 KiB/s moves the registry accelerators first. Explicit cn/global choices
# remain authoritative. The digest is identical across routes, so transport
# selection never changes the image Desktop authenticated.
openbitfun_pull_relay_image() {
  local platform="$1" repository="$2" route image_ref selected=""
  local routes=()
  local requested_mode github_speed mirror_first=0
  local pull_timeout="${OPENBITFUN_IMAGE_PULL_TIMEOUT:-900}"
  case "$pull_timeout" in
    '' | *[!0-9]*) pull_timeout=900 ;;
  esac

  requested_mode="${OPENBITFUN_MIRROR_REQUESTED_MODE:-${OPENBITFUN_MIRROR_MODE:-auto}}"
  case "$OPENBITFUN_GITHUB_HEALTHY_BPS" in
    '' | *[!0-9]*) OPENBITFUN_GITHUB_HEALTHY_BPS=524288 ;;
  esac
  case "$requested_mode" in
    cn) mirror_first=1 ;;
    global) mirror_first=0 ;;
    *)
      github_speed="$(openbitfun_probe_github_throughput "$platform")"
      if [ "$github_speed" -lt "$OPENBITFUN_GITHUB_HEALTHY_BPS" ]; then
        mirror_first=1
      fi
      ;;
  esac

  if [ "$requested_mode" = global ]; then
    routes=("$repository")
  elif [ "$mirror_first" = "1" ]; then
    routes=("ghcr.nju.edu.cn/${repository#ghcr.io/}" "m.daocloud.io/${repository}" "$repository")
  else
    routes=("$repository" "ghcr.nju.edu.cn/${repository#ghcr.io/}" "m.daocloud.io/${repository}")
  fi

  for route in "${routes[@]}"; do
    image_ref="$(openbitfun_relay_image_ref "$route")"
    echo ">>> Pulling Relay image: ${image_ref}" >&2
    if openbitfun_image_docker_with_timeout "$pull_timeout" pull --platform "$platform" "$image_ref" >&2; then
      selected="$image_ref"
      break
    fi
    echo ">>> ${route} failed or timed out." >&2
  done

  if [ -z "$selected" ]; then
    echo ">>> ERROR: Relay image pull failed on every ${OPENBITFUN_MIRROR_MODE:-global} route." >&2
    return 1
  fi

  local expected_arch="${platform#linux/}" actual_arch
  actual_arch="$(openbitfun_image_docker image inspect -f '{{.Architecture}}' "$selected" 2>/dev/null || true)"
  if [ "$actual_arch" != "$expected_arch" ]; then
    echo ">>> ERROR: pulled image architecture '$actual_arch' does not match '$expected_arch'." >&2
    return 1
  fi
  printf '%s' "$selected"
}

openbitfun_restore_previous_relay() {
  openbitfun_image_docker rm -f openbitfun-relay >/dev/null 2>&1 || true
  if [ -n "${OPENBITFUN_RELAY_BACKUP_CONTAINER:-}" ]; then
    openbitfun_image_docker rename "$OPENBITFUN_RELAY_BACKUP_CONTAINER" openbitfun-relay >/dev/null 2>&1 || true
    openbitfun_image_docker start openbitfun-relay >/dev/null 2>&1 || true
  fi
}

openbitfun_run_relay_image() {
  local image_ref="$1" platform="$2" attempt stale
  openbitfun_image_docker volume create relay-server_relay-db >/dev/null || return 1
  openbitfun_image_docker volume create relay-server_room-web >/dev/null || return 1

  OPENBITFUN_RELAY_BACKUP_CONTAINER=""
  if openbitfun_image_docker container inspect openbitfun-relay >/dev/null 2>&1; then
    OPENBITFUN_RELAY_BACKUP_CONTAINER="openbitfun-relay-before-image-$$"
    openbitfun_image_docker stop openbitfun-relay >/dev/null 2>&1 || true
    if ! openbitfun_image_docker rename openbitfun-relay "$OPENBITFUN_RELAY_BACKUP_CONTAINER"; then
      echo ">>> ERROR: could not stage the existing Relay container." >&2
      openbitfun_image_docker start openbitfun-relay >/dev/null 2>&1 || true
      return 1
    fi
  fi

  # A cancelled wizard must put the previously healthy Relay back.
  trap 'openbitfun_restore_previous_relay; trap - INT TERM; exit 1' INT TERM

  echo ">>> Starting Relay image on port ${RELAY_PORT:-9700}..."
  if ! openbitfun_image_docker run -d \
    --name openbitfun-relay \
    --platform "$platform" \
    --restart unless-stopped \
    --label com.docker.compose.project=relay-server \
    --label com.docker.compose.service=relay-server \
    --label "com.openbitfun.relay.image=${OPENBITFUN_RELAY_IMAGE}" \
    --label "com.openbitfun.relay.digest=${OPENBITFUN_RELAY_IMAGE_DIGEST:-unlocked}" \
    -p "${RELAY_HOST_BIND_IP:-0.0.0.0}:${RELAY_PORT:-9700}:${RELAY_PORT:-9700}" \
    -e "RELAY_PORT=${RELAY_PORT:-9700}" \
    -e RELAY_STATIC_DIR=/app/static \
    -e RELAY_ROOM_WEB_DIR=/app/room-web \
    -e RELAY_ROOM_TTL=300 \
    -e RELAY_ASSET_STORE_MAX_BYTES=1073741824 \
    -e RELAY_DB_PATH=/app/data/openbitfun_relay.db \
    -e "RELAY_PAGE_PUBLIC_BASE_URL=${RELAY_PAGE_PUBLIC_BASE_URL:-}" \
    -e "RELAY_PAGE_AUTH_BASE_URL=${RELAY_PAGE_AUTH_BASE_URL:-}" \
    -v relay-server_room-web:/app/room-web \
    -v relay-server_relay-db:/app/data \
    "$image_ref" >/dev/null; then
    echo ">>> ERROR: the Relay image could not start; restoring the previous container." >&2
    openbitfun_restore_previous_relay
    trap - INT TERM
    return 1
  fi

  # Probe inside the image. This avoids requiring curl on an otherwise ready
  # Docker host and verifies the exact container that will be kept.
  for attempt in $(seq 1 30); do
    if openbitfun_image_docker exec openbitfun-relay \
      curl -fsS --max-time 3 "http://127.0.0.1:${RELAY_PORT:-9700}/health" >/dev/null 2>&1; then
      trap - INT TERM
      if [ -n "$OPENBITFUN_RELAY_BACKUP_CONTAINER" ]; then
        openbitfun_image_docker rm "$OPENBITFUN_RELAY_BACKUP_CONTAINER" >/dev/null 2>&1 || true
      fi
      for stale in $(openbitfun_image_docker ps -aq \
        --filter 'name=^openbitfun-relay-before-image-' \
        --filter 'name=^openbitfun-relay-before-release-' 2>/dev/null); do
        openbitfun_image_docker rm -f "$stale" >/dev/null 2>&1 || true
      done
      echo ">>> Relay image is healthy."
      return 0
    fi
    if ! openbitfun_image_docker inspect -f '{{.State.Running}}' openbitfun-relay 2>/dev/null | grep -qx true; then
      break
    fi
    sleep 2
  done

  echo ">>> ERROR: Relay image failed its health check; restoring the previous container." >&2
  echo ">>> Container state: $(openbitfun_image_docker inspect \
    -f 'running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} err={{.State.Error}}' \
    openbitfun-relay 2>&1 || true)"
  echo ">>> Last 40 log lines from openbitfun-relay:"
  openbitfun_image_docker logs --tail 40 openbitfun-relay 2>&1 | sed 's/^/    /' || true
  openbitfun_restore_previous_relay
  trap - INT TERM
  return 1
}

openbitfun_try_release_deploy() {
  local platform image_ref legacy_tag
  platform="$(openbitfun_relay_native_platform)" || {
    echo ">>> ERROR: no published Relay image for architecture $(uname -m)." >&2
    return 1
  }

  if [ -n "${OPENBITFUN_RELAY_IMAGE_DIGEST:-}" ] && \
     [[ ! "$OPENBITFUN_RELAY_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo ">>> ERROR: invalid Relay image digest; refusing to pull executable code." >&2
    return 1
  fi
  if [ -n "${OPENBITFUN_REQUIRE_IMAGE_DIGEST:-}" ] && [ -z "${OPENBITFUN_RELAY_IMAGE_DIGEST:-}" ]; then
    echo ">>> ERROR: a signed Relay image descriptor is required for one-click deployment." >&2
    return 1
  fi

  # Ignore a user-level foreign-platform default. Relay one-click deployment is
  # deliberately native on its two supported server architectures.
  export DOCKER_DEFAULT_PLATFORM="$platform"
  if ! image_ref="$(openbitfun_pull_relay_image "$platform" "$OPENBITFUN_RELAY_IMAGE")"; then
    [ -z "$OPENBITFUN_RELAY_IMAGE_OVERRIDE" ] || return 1
    legacy_tag="$(openbitfun_legacy_relay_tag)" || {
      echo ">>> ERROR: cannot resolve the current release tag for the legacy Relay registry." >&2
      return 1
    }
    echo ">>> Retrying the same Relay release in the legacy registry." >&2
    image_ref="$(OPENBITFUN_RELAY_IMAGE_TAG="$legacy_tag" \
      openbitfun_pull_relay_image "$platform" "$OPENBITFUN_LEGACY_RELAY_IMAGE")" || return 1
    # The deployment labels should identify the namespace that supplied the bytes.
    OPENBITFUN_RELAY_IMAGE="$OPENBITFUN_LEGACY_RELAY_IMAGE" \
      openbitfun_run_relay_image "$image_ref" "$platform"
    return
  fi
  openbitfun_run_relay_image "$image_ref" "$platform"
}
