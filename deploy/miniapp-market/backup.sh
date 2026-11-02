#!/usr/bin/env bash
set -euo pipefail

readonly MARKET_ROOT="${MARKET_ROOT:-/srv/openbitfun-miniapp-market}"
readonly DATA_ROOT="${MARKET_ROOT}/data"
readonly ARTIFACT_ROOT="${MARKET_ROOT}/artifacts"
readonly BACKUP_ROOT="${MARKET_ROOT}/backups"
readonly DAILY_ROOT="${BACKUP_ROOT}/daily"
readonly WEEKLY_ROOT="${BACKUP_ROOT}/weekly"
readonly TODAY="$(date -u +%F)"
readonly WEEK="$(date -u +%G-W%V)"
readonly DAILY_TARGET="${DAILY_ROOT}/${TODAY}"

if [[ "${MARKET_ROOT}" != /* || "${MARKET_ROOT}" == "/" ]]; then
  echo "MARKET_ROOT must be an absolute path below /" >&2
  exit 1
fi

install -d -m 0750 "${DAILY_ROOT}" "${WEEKLY_ROOT}"
if [[ -e "${DAILY_TARGET}" ]]; then
  echo "Backup already exists for ${TODAY}" >&2
  exit 1
fi

install -d -m 0750 "${DAILY_TARGET}"
sqlite3 "${DATA_ROOT}/market.sqlite" ".timeout 10000" ".backup '${DAILY_TARGET}/market.sqlite'"

readonly INTEGRITY="$(sqlite3 "${DAILY_TARGET}/market.sqlite" "PRAGMA integrity_check;")"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "SQLite integrity check failed: ${INTEGRITY}" >&2
  exit 1
fi

tar -C "${ARTIFACT_ROOT}" -czf "${DAILY_TARGET}/artifacts.tar.gz" .
(
  cd "${DAILY_TARGET}"
  sha256sum market.sqlite artifacts.tar.gz > SHA256SUMS
)

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

echo "MiniApp market backup completed: ${DAILY_TARGET}"
