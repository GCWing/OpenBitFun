#!/usr/bin/env bash
set -euo pipefail

readonly MARKET_ROOT="${MARKET_ROOT:-/srv/openbitfun-miniapp-market}"
readonly BACKUP_ROOT="${MARKET_ROOT}/backups"
readonly SOURCE="${1:-}"

if [[ "${MARKET_ROOT}" != /* || "${MARKET_ROOT}" == "/" ]]; then
  echo "MARKET_ROOT must be an absolute path below /" >&2
  exit 2
fi

if [[ -z "${SOURCE}" || "${SOURCE}" != "${BACKUP_ROOT}/"* || ! -d "${SOURCE}" ]]; then
  echo "Usage: $0 ${BACKUP_ROOT}/{daily|weekly}/<backup>" >&2
  exit 2
fi

readonly DRILL_DIR="$(mktemp -d "${BACKUP_ROOT}/restore-drill.XXXXXX")"
cleanup() {
  [[ "${DRILL_DIR}" == "${BACKUP_ROOT}/restore-drill."* ]] && rm -rf -- "${DRILL_DIR}"
}
trap cleanup EXIT

(
  cd "${SOURCE}"
  sha256sum -c SHA256SUMS
)
cp "${SOURCE}/market.sqlite" "${DRILL_DIR}/market.sqlite"
mkdir "${DRILL_DIR}/artifacts"
tar -C "${DRILL_DIR}/artifacts" -xzf "${SOURCE}/artifacts.tar.gz"

readonly INTEGRITY="$(sqlite3 "${DRILL_DIR}/market.sqlite" "PRAGMA integrity_check;")"
readonly TABLE_COUNT="$(sqlite3 "${DRILL_DIR}/market.sqlite" \
  "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view');")"
readonly ARTIFACT_COUNT="$(find "${DRILL_DIR}/artifacts" -type f | wc -l | tr -d ' ')"

if [[ "${INTEGRITY}" != "ok" || "${TABLE_COUNT}" -lt 1 ]]; then
  echo "Restore drill failed" >&2
  exit 1
fi

echo "Restore drill passed: tables=${TABLE_COUNT}, artifacts=${ARTIFACT_COUNT}"
echo "This drill validates same-host backups only; it is not off-site disaster recovery."
