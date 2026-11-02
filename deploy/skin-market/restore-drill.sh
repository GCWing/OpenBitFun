#!/usr/bin/env bash
set -euo pipefail

readonly MARKET_ROOT="${MARKET_ROOT:-/srv/openbitfun-skin-market}"
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

sqlite3 -separator '|' "${DRILL_DIR}/market.sqlite" \
  "SELECT package_sha256, package_size FROM releases
   UNION
   SELECT package_sha256, package_size FROM submissions
   WHERE package_sha256 IS NOT NULL;" > "${DRILL_DIR}/package-references"
sqlite3 "${DRILL_DIR}/market.sqlite" \
  "SELECT preview_sha256 FROM releases
   UNION
   SELECT preview_sha256 FROM submissions
   WHERE preview_sha256 IS NOT NULL;" > "${DRILL_DIR}/preview-references"

REFERENCE_COUNT=0
while IFS='|' read -r sha256 expected_size; do
  [[ "${sha256}" =~ ^[0-9a-f]{64}$ && "${expected_size}" =~ ^[0-9]+$ ]] || {
    echo "Restore drill found an invalid package reference" >&2
    exit 1
  }
  package="${DRILL_DIR}/artifacts/packages/${sha256:0:2}/${sha256}.openbitfun-appearance"
  [[ -f "${package}" && "$(stat -c %s "${package}")" == "${expected_size}" ]] || {
    echo "Restore drill found a missing or incorrectly sized package artifact" >&2
    exit 1
  }
  [[ "$(sha256sum "${package}" | awk '{print $1}')" == "${sha256}" ]] || {
    echo "Restore drill found a package artifact hash mismatch" >&2
    exit 1
  }
  REFERENCE_COUNT=$((REFERENCE_COUNT + 1))
done < "${DRILL_DIR}/package-references"

while IFS= read -r sha256; do
  [[ "${sha256}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Restore drill found an invalid preview reference" >&2
    exit 1
  }
  preview="${DRILL_DIR}/artifacts/previews/${sha256:0:2}/${sha256}.webp"
  [[ -f "${preview}" ]] || {
    echo "Restore drill found a missing preview artifact" >&2
    exit 1
  }
  [[ "$(sha256sum "${preview}" | awk '{print $1}')" == "${sha256}" ]] || {
    echo "Restore drill found a preview artifact hash mismatch" >&2
    exit 1
  }
  REFERENCE_COUNT=$((REFERENCE_COUNT + 1))
done < "${DRILL_DIR}/preview-references"

echo "Restore drill passed: tables=${TABLE_COUNT}, artifacts=${ARTIFACT_COUNT}"
echo "Verified database artifact references: ${REFERENCE_COUNT}"
echo "This drill validates same-host backups only; it is not off-site disaster recovery."
