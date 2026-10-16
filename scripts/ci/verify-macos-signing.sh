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

source "$(dirname "$0")/macos-ticket-network.sh"

# Separate upload from polling so a lost connection never re-submits a DMG.
# Keep the receipt with the bundle for a verification-only recovery run.
notarize_dmg() {
  local dmg="$1" receipt="${1}.notary-submission.json" submission_id output exit_code attempt
  local auth=(--issuer "${APPLE_API_ISSUER}" --key-id "${APPLE_API_KEY}" --key "${APPLE_API_KEY_PATH}")
  if [[ -f "${receipt}" ]]; then
    submission_id="$(node -e '
      const fs = require("node:fs"), crypto = require("node:crypto");
      const [dmg, receipt] = process.argv.slice(1);
      const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved.id) ||
          saved.sha256 !== crypto.createHash("sha256").update(fs.readFileSync(dmg)).digest("hex")) {
        throw new Error("Notary receipt does not match this DMG; refusing to reuse its submission");
      }
      console.log(saved.id);
    ' "${dmg}" "${receipt}")"
  else
    if output="$(xcrun notarytool submit "${dmg}" "${auth[@]}" --no-wait --output-format json 2>&1)"; then
      printf '%s\n' "${output}"
    else
      exit_code=$?
      printf '%s\n' "${output}" >&2
      return "${exit_code}"
    fi
    submission_id="$(printf '%s' "${output}" | node -e '
      const fs = require("node:fs"), crypto = require("node:crypto");
      const [dmg, receipt] = process.argv.slice(1);
      const { id } = JSON.parse(fs.readFileSync(0, "utf8"));
      if (typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error("Apple did not return a valid submission ID; refusing to resubmit");
      }
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(dmg)).digest("hex");
      fs.writeFileSync(receipt + ".part", JSON.stringify({ id, sha256 }) + "\n", { mode: 0o600 });
      fs.renameSync(receipt + ".part", receipt);
      console.log(id);
    ' "${dmg}" "${receipt}")"
  fi
  for attempt in 1 2 3; do
    if output="$(xcrun notarytool wait "${submission_id}" "${auth[@]}" --output-format json 2>&1)"; then
      printf '%s\n' "${output}"
      printf '%s' "${output}" | node -e '
        const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        if (result.id !== process.argv[1] || result.status !== "Accepted") {
          throw new Error("Apple notarization was not accepted: " + result.status);
        }
      ' "${submission_id}"
      return
    else
      exit_code=$?
    fi
    printf '%s\n' "${output}" >&2
    if [[ "${attempt}" -eq 3 ]] ||
       ! grep -Eq 'Error Domain=NSURLErrorDomain Code=-(1005|1009)([^0-9]|$)' <<<"${output}"; then
      return "${exit_code}"
    fi
    echo "Apple notary connection was lost; waiting again on submission ${submission_id} (${attempt}/3)." >&2
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
  notarize_dmg "${dmg}"
  stapler_with_network_retry staple "${dmg}"
  # Stapling legitimately changes the accepted DMG. Bind a retained receipt to
  # those exact bytes before validation, so recovery can safely reuse its ID.
  node -e '
    const fs = require("node:fs"), crypto = require("node:crypto");
    const dmg = process.argv[1], receipt = dmg + ".notary-submission.json";
    const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
    saved.sha256 = crypto.createHash("sha256").update(fs.readFileSync(dmg)).digest("hex");
    fs.writeFileSync(receipt + ".part", JSON.stringify(saved) + "\n", { mode: 0o600 });
    fs.renameSync(receipt + ".part", receipt);
  ' "${dmg}"
  stapler_with_network_retry validate "${dmg}"
  spctl --assess --type open --context context:primary-signature --verbose=4 "${dmg}"
done

echo "Verified Developer ID signatures, notarization tickets, and Gatekeeper acceptance."
