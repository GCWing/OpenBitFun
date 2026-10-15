#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: verify-macos-signing.sh <target-triple>}"
if [[ "${OPENBITFUN_APPLE_SIGNING_CONFIGURED:-false}" != "true" ]]; then
  echo "Apple signing is not configured; skipping macOS signature verification."
  exit 0
fi

bundle_dir="target/${target}/release/bundle"

shopt -s nullglob
apps=("${bundle_dir}/macos/"*.app)
dmgs=("${bundle_dir}/dmg/"*.dmg)

if [[ "${#apps[@]}" -eq 0 || "${#dmgs[@]}" -eq 0 ]]; then
  echo "Expected one or more macOS app and DMG bundles under ${bundle_dir}." >&2
  exit 1
fi

# CloudKit can drop a connection even after notarization was accepted. Retry
# only that transport failure; an invalid/missing ticket must still fail.
stapler_with_network_retry() {
  local attempt output exit_code
  for attempt in 1 2 3; do
    if output="$(xcrun stapler "$@" 2>&1)"; then
      printf '%s\n' "${output}"
      return 0
    else
      exit_code=$?
    fi
    printf '%s\n' "${output}" >&2
    if [[ "${exit_code}" -ne 68 || "${attempt}" -eq 3 ]] || \
       ! grep -Fq 'Error Domain=NSURLErrorDomain Code=-1005' <<<"${output}"; then
      return "${exit_code}"
    fi
    echo "Apple ticket service connection was lost; retrying stapler ${1} (${attempt}/3)." >&2
    sleep "$((attempt * 10))"
  done
}

for app in "${apps[@]}"; do
  codesign --verify --deep --strict --verbose=2 "${app}"
  bash "$(dirname "$0")/verify-macos-microphone.sh" "${app}"
  while IFS= read -r -d '' candidate; do
    if ! file -b "${candidate}" | grep -q 'Mach-O'; then
      continue
    fi
    signature_details="$(codesign -dv --verbose=4 "${candidate}" 2>&1)"
    grep -Fq 'Authority=Developer ID Application:' <<<"${signature_details}"
    grep -Eq 'flags=.*\(runtime\)' <<<"${signature_details}"
    grep -Fq 'Timestamp=' <<<"${signature_details}"
  done < <(find "${app}" -type f -print0)
  stapler_with_network_retry validate "${app}"
  spctl --assess --type execute --verbose=4 "${app}"
done

for dmg in "${dmgs[@]}"; do
  xcrun notarytool submit "${dmg}" \
    --issuer "${APPLE_API_ISSUER}" \
    --key-id "${APPLE_API_KEY}" \
    --key "${APPLE_API_KEY_PATH}" \
    --wait
  stapler_with_network_retry staple "${dmg}"
  stapler_with_network_retry validate "${dmg}"
  spctl --assess --type open --context context:primary-signature --verbose=4 "${dmg}"
done

echo "Verified Developer ID signatures, notarization tickets, and Gatekeeper acceptance."
