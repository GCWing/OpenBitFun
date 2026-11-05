declare const openbitfunCrypto: {
  encodeRelayMessage(plain: Uint8Array): Uint8Array;
  decodeRelayMessage(bytes: Uint8Array): Uint8Array;
  argon2idRaw(
    password: Uint8Array,
    salt: Uint8Array,
    memory: number,
    time: number,
    lanes: number
  ): Promise<Uint8Array>;
};

export default openbitfunCrypto;
