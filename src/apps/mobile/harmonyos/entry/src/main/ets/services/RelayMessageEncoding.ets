import relayCodec from 'libopenbitfun_crypto.so';

/** Native codec work runs off the ArkTS thread. Bound the wait for a stuck worker. */
export class RelayMessageEncoding {
  static encode(plain: Uint8Array): Promise<Uint8Array> {
    return RelayMessageEncoding.wait(relayCodec.encodeRelayMessage(plain));
  }

  static decode(bytes: Uint8Array): Promise<Uint8Array> {
    return RelayMessageEncoding.wait(relayCodec.decodeRelayMessage(bytes));
  }

  private static wait(work: Promise<Uint8Array>): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Relay codec timed out')); }, 15000);
      work.then((result: Uint8Array) => {
        clearTimeout(timer);
        resolve(result);
      }, (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}
