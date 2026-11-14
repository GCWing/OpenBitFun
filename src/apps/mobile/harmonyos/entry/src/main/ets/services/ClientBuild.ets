import { bundleManager } from '@kit.AbilityKit';

/**
 * Identity of THIS client build, reported to the Relay at login and on every
 * realtime (re)connect so the Relay can gate remote control between devices.
 *
 * Compatibility is decided by the Relay alone from the two stored protocol
 * numbers; clients read the Relay-computed `compatible` flag on the device
 * directory instead of re-deriving the rule. The rule the Relay applies is:
 * two devices are mutually controllable only when BOTH report a number AND the
 * numbers are equal.
 *
 * Semantics of CLIENT_PROTOCOL_VERSION:
 *
 *  - legacy clients: report nothing (unreported, so the Relay judges them
 *    incompatible, never "legacy-compatible");
 *  - this build: `2`;
 *  - increment only on a breaking change to the client control contract.
 *
 * Kept numerically identical to
 * `openbitfun_product_domains::account::CLIENT_PROTOCOL_VERSION` in
 * `src/crates/contracts/product-domains/src/account.rs` and to the Kotlin
 * `CLIENT_PROTOCOL_VERSION` the other mobile clients share;
 * `scripts/mobile-client-build.contract.test.mjs` pins them together so
 * one side can never drift.
 */
export const CLIENT_PROTOCOL_VERSION: number = 2;

/**
 * Product build string reported next to CLIENT_PROTOCOL_VERSION for
 * diagnostics only; the Relay gates control on the protocol number, never on
 * this string. Read from this bundle's own manifest (`AppScope/app.json5`
 * `versionName`, which release-please bumps with the workspace version) rather
 * than kept as a literal here, so it is never hand-maintained.
 *
 * Resolved lazily so importing this module never touches the bundle manager;
 * the unit runner has none. An unreadable manifest reports an empty string,
 * which the Relay stores as "no build string" — the protocol number still
 * gates as usual.
 */
export function clientVersion(): string {
  if (cachedClientVersion === null) cachedClientVersion = readBundleVersion();
  return cachedClientVersion;
}

let cachedClientVersion: string | null = null;

function readBundleVersion(): string {
  try {
    const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    return (info.versionName || '').trim();
  } catch (_) {
    return '';
  }
}
