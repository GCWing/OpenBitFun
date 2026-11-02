import { describe, expect, it } from 'vitest';
import { peerHostRefusalReason } from './peerHostRefusal';

describe('peerHostRefusalReason', () => {
  it('extracts the reason a host gave', () => {
    expect(peerHostRefusalReason(new Error(
      "command 'export_diagnostics_bundle' is not supported on CLI peer host: the CLI peer host does not export diagnostics bundles",
    ))).toBe('The CLI peer host does not export diagnostics bundles');
  });

  it('keeps the whole message when an older host gave no reason', () => {
    expect(peerHostRefusalReason("command 'x' is not supported on CLI peer host"))
      .toBe("Command 'x' is not supported on CLI peer host");
  });

  it('recognizes a command the host version does not know', () => {
    const message = "command 'x' is unknown to this OpenBitFun CLI peer host version; upgrade the peer host";
    expect(peerHostRefusalReason(new Error(message))).toBe(message);
  });

  it('leaves ordinary failures to the caller', () => {
    expect(peerHostRefusalReason(new Error('disk full'))).toBeNull();
    expect(peerHostRefusalReason(undefined)).toBeNull();
  });
});
