#!/usr/bin/env bash
set -euo pipefail

readonly MARKET_ROOT="${MARKET_ROOT:-/srv/openbitfun-skin-market}"
readonly DATA_ROOT="${MARKET_ROOT}/data"
readonly ARTIFACT_ROOT="${MARKET_ROOT}/artifacts"
readonly BACKUP_ROOT="${MARKET_ROOT}/backups"
readonly DAILY_ROOT="${BACKUP_ROOT}/daily"
readonly WEEKLY_ROOT="${BACKUP_ROOT}/weekly"
readonly TODAY="$(date -u +%F)"
readonly WEEK="$(date -u +%G-W%V)"
readonly DAILY_TARGET="${DAILY_ROOT}/${TODAY}"
readonly DATABASE="${DATA_ROOT}/market.sqlite"
readonly SKIN_MARKET_UID="${SKIN_MARKET_UID:-10002}"

if [[ "${MARKET_ROOT}" != /* || "${MARKET_ROOT}" == "/" ]]; then
  echo "MARKET_ROOT must be an absolute path below /" >&2
  exit 1
fi

install -d -m 0750 "${DAILY_ROOT}" "${WEEKLY_ROOT}"
if [[ ! -f "${DATABASE}" ]]; then
  echo "Skin market database does not exist; refusing to create an empty backup source" >&2
  exit 1
fi
if [[ "$(stat -c %u "${DATABASE}")" != "${SKIN_MARKET_UID}" ]]; then
  echo "Skin market database must be owned by runtime UID ${SKIN_MARKET_UID}" >&2
  exit 1
fi
if [[ "$(sqlite3 "${DATABASE}" "PRAGMA quick_check;")" != "ok" ]]; then
  echo "Skin market source database failed quick_check" >&2
  exit 1
fi
if [[ -e "${DAILY_TARGET}" ]]; then
  if [[ ! -d "${DAILY_TARGET}" ]]; then
    echo "Daily backup target exists but is not a directory" >&2
    exit 1
  fi
  (
    cd "${DAILY_TARGET}"
    sha256sum -c SHA256SUMS
  )
  if [[ "$(sqlite3 "${DAILY_TARGET}/market.sqlite" "PRAGMA integrity_check;")" != "ok" ]]; then
    echo "Existing daily backup failed integrity_check" >&2
    exit 1
  fi
  echo "Verified existing Skin market backup: ${DAILY_TARGET}"
  exit 0
fi

readonly STAGING_TARGET="$(mktemp -d "${DAILY_ROOT}/.${TODAY}.staging.XXXXXX")"
cleanup_staging() {
  if [[ -d "${STAGING_TARGET}" && "${STAGING_TARGET}" == "${DAILY_ROOT}/.${TODAY}.staging."* ]]; then
    rm -rf -- "${STAGING_TARGET}"
  fi
}
trap cleanup_staging EXIT

sqlite3 "${DATABASE}" ".timeout 10000" ".backup '${STAGING_TARGET}/market.sqlite'"

readonly INTEGRITY="$(sqlite3 "${STAGING_TARGET}/market.sqlite" "PRAGMA integrity_check;")"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "SQLite integrity check failed: ${INTEGRITY}" >&2
  exit 1
fi

tar -C "${ARTIFACT_ROOT}" -czf "${STAGING_TARGET}/artifacts.tar.gz" .
(
  cd "${STAGING_TARGET}"
  sha256sum market.sqlite artifacts.tar.gz > SHA256SUMS
)
mv "${STAGING_TARGET}" "${DAILY_TARGET}"
trap - EXIT

if [[ "$(date -u +%u)" == "7" ]]; then
  readonly WEEKLY_TARGET="${WEEKLY_ROOT}/${WEEK}"
  if [[ ! -e "${WEEKLY_TARGET}" ]]; then
    install -d -m 0750 "${WEEKLY_TARGET}"
    cp --reflink=auto "${DAILY_TARGET}/market.sqlite" "${WEEKLY_TARGET}/market.sqlite"
    cp --reflink=auto "${DAILY_TARGET}/artifacts.tar.gz" "${WEEKLY_TARGET}/artifacts.tar.gz"
    cp "${DAILY_TARGET}/SHA256SUMS" "${WEEKLY_TARGET}/SHA256SUMS"
  fi
fi

prune_backups() {
  local root="$1"
  local keep="$2"
  local candidate

  while IFS= read -r candidate; do
    [[ "${candidate}" == "${root}/"* ]] || {
      echo "Refusing to prune unexpected path: ${candidate}" >&2
      exit 1
    }
    rm -rf -- "${candidate}"
  done < <(find "${root}" -mindepth 1 -maxdepth 1 -type d -print | sort -r | tail -n "+$((keep + 1))")
}

prune_backups "${DAILY_ROOT}" 14
prune_backups "${WEEKLY_ROOT}" 8

echo "Skin market backup completed: ${DAILY_TARGET}"
