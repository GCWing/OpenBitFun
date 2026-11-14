import { describe, it, expect } from '@ohos/hypium';
import openbitfunCrypto from 'libopenbitfun_crypto.so';
import { Encoding } from '../../../main/ets/services/Encoding';

// The account password login that wrapped this binding is retired, so the load
// goes straight to the native Argon2id work the library still ships.
const LOAD_MEMORY_KIB: number = 16 * 1024;
const LOAD_PASSES: number = 2;
const LOAD_LANES: number = 1;

function nativeArgon2id(input: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return openbitfunCrypto.argon2idRaw(input, salt, LOAD_MEMORY_KIB, LOAD_PASSES, LOAD_LANES);
}

export default function nativeCryptoLoadTest() {
  describe('NativeCryptoLoad', () => {
    it('keeps the ArkTS event loop responsive during concurrent Argon2id work', 0, async () => {
      const salt = new Uint8Array([0x42, 0x69, 0x74, 0x46, 0x75, 0x6e, 0x2d, 0x31,
        0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      const input = Encoding.utf8ToBytes('openbitfun-device-load');
      let heartbeatTicks = 0;
      const heartbeatId = setInterval(() => {
        heartbeatTicks += 1;
      }, 5);
      const startedAt = Date.now();

      const results = await Promise.all([
        nativeArgon2id(input, salt),
        nativeArgon2id(input, salt),
        nativeArgon2id(input, salt)
      ]);
      clearInterval(heartbeatId);

      expect(results.length).assertEqual(3);
      expect(results[0].length).assertEqual(32);
      expect(bytesEqual(results[0], results[1])).assertTrue();
      expect(bytesEqual(results[1], results[2])).assertTrue();
      expect(heartbeatTicks > 0).assertTrue();
      expect(Date.now() - startedAt < 30000).assertTrue();
    });
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
