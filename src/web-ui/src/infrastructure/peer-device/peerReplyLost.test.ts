import { describe, expect, it } from 'vitest';
import { isPeerReplyLost, peerReplyLostMessage } from './peerReplyLost';

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
});
