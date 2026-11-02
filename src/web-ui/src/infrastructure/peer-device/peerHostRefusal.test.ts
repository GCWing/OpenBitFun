import { describe, expect, it } from 'vitest';

import { classifyPeerHostRefusal, peerHostRefusalMessage } from './peerHostRefusal';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${options.message} [${options.detail}]` : key;

describe('peerHostRefusal', () => {
  it('keeps the reason a host gave as detail', () => {
    expect(classifyPeerHostRefusal(new Error(
      "command 'export_diagnostics_bundle' is not supported on CLI peer host: the CLI peer host does not export diagnostics bundles",
    ))).toEqual({ kind: 'unavailable', detail: 'the CLI peer host does not export diagnostics bundles' });
  });

  it('asks for an update when the host version has no handler yet', () => {
    expect(classifyPeerHostRefusal(
      "command 'btw_ask_stream' is not supported on CLI peer host: the CLI peer host has no handler for this command",
    )?.kind).toBe('updateRequired');
    expect(classifyPeerHostRefusal(
      "command 'x' is unknown to this OpenBitFun CLI peer host version; upgrade the peer host",
    )?.kind).toBe('updateRequired');
  });

  it('keeps the whole message when an older host gave no reason', () => {
    expect(classifyPeerHostRefusal("command 'x' is not supported on CLI peer host")).toEqual({
      kind: 'unavailable', detail: "command 'x' is not supported on CLI peer host",
    });
  });

  it('leads with localized copy and leaves the host text as detail', () => {
    expect(peerHostRefusalMessage("command 'x' is not supported on CLI peer host: no ACP host", t))
      .toBe('common:peerHost.unavailable [no ACP host]');
  });

  it('leaves ordinary failures to the caller', () => {
    expect(classifyPeerHostRefusal(new Error('disk full'))).toBeNull();
    expect(peerHostRefusalMessage(undefined, t)).toBeNull();
  });
});
