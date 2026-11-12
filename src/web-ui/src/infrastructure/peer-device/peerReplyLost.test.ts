import { describe, expect, it } from 'vitest';
import { isPeerHostNotResponding, isPeerHostStarting, isPeerReplyLost, peerReplyLostMessage } from './peerReplyLost';

describe('peerReplyLost', () => {
  it('recognises current and legacy lost-reply errors only', () => {
    expect(isPeerReplyLost(new Error('Relay connection closed before the reply arrived; delivery outcome is unknown'))).toBe(true);
    expect(isPeerReplyLost('failed to receive ack')).toBe(true);
    expect(isPeerReplyLost(new Error('Relay is disconnected; request was not submitted'))).toBe(true);
    expect(isPeerReplyLost(new Error('RPC target unavailable'))).toBe(false);
    expect(isPeerReplyLost(undefined)).toBe(false);
  });

  it('localizes a lost reply and leaves other errors to the caller', () => {
    const t = (key: string) => key;
    expect(peerReplyLostMessage(new Error('failed to receive ack'), t)).toBe('common:peerHost.connectionInterrupted');
    expect(peerReplyLostMessage(new Error('boom'), t)).toBeNull();
  });

  it('localizes a host that did not answer a bounded read', () => {
    const t = (key: string) => key;
    const error = new Error("peer_host_not_responding: Peer host did not answer 'get_config' within 25000ms");
    expect(isPeerHostNotResponding(error)).toBe(true);
    expect(peerReplyLostMessage(error, t)).toBe('common:peerHost.notResponding');
    expect(isPeerHostNotResponding(new Error('timed out'))).toBe(false);
  });

  it('localizes a host that refused because it is still starting', () => {
    const t = (key: string) => key;
    const error = new Error('peer_host_ui_not_ready: OpenBitFun on this device is still starting; the request was not executed');
    expect(isPeerHostStarting(error)).toBe(true);
    expect(peerReplyLostMessage(error, t)).toBe('common:peerHost.starting');
  });
});
