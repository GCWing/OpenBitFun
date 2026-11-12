import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Cross-platform source contracts belong to the repository, not a shared
// runtime module that would then need to reach into a platform's implementation.
const root = path.resolve(import.meta.dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const services = 'src/apps/mobile/harmonyos/entry/src/main/ets/services';

function protocolVersion(file, declaration) {
  const match = source(file).match(declaration);
  assert.ok(match, `Missing protocol version declaration in ${file}`);
  return Number(match[1]);
}

test('mobile and web protocol versions match the Rust account contract', () => {
  const expected = protocolVersion(
    'src/crates/contracts/product-domains/src/account.rs',
    /^pub const CLIENT_PROTOCOL_VERSION: u32 = (\d+);$/m,
  );
  for (const [file, declaration] of [
    ['src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/ClientBuild.kt',
      /^public const val CLIENT_PROTOCOL_VERSION: Int = (\d+)$/m],
    [`${services}/ClientBuild.ets`, /^export const CLIENT_PROTOCOL_VERSION: number = (\d+);$/m],
    ['src/shared/relay-transport/ClientBuild.ts', /^export const CLIENT_PROTOCOL_VERSION = (\d+);$/m],
  ]) {
    assert.equal(protocolVersion(file, declaration), expected, `${file} must match the Rust contract`);
  }
});

test('HarmonyOS reports its bundle build and protocol on login and every handshake', () => {
  // Preserve the transport assertions formerly owned by the shared JVM suite.
  // The version string is resolved from this platform's bundle at runtime.
  const realtime = source(`${services}/AccountRealtime.ets`);
  assert.ok(realtime.includes('clientVersion: clientVersion()'));
  assert.ok(realtime.includes('clientProtocol: CLIENT_PROTOCOL_VERSION'));
  const client = source(`${services}/CloudAccountClient.ets`);
  assert.ok(client.includes('clientVersion: clientVersion(), clientProtocol: CLIENT_PROTOCOL_VERSION'));
});
