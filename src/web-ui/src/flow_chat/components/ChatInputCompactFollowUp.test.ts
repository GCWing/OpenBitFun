import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Composer wiring for `/compact <message>`.
 *
 * A mounted composer cannot be driven through a real compaction in a unit
 * test, so these assertions lock the two properties that make the feature
 * work: the command admits a follow-up, and the follow-up is only submitted
 * after the compaction finished. Runtime behaviour still needs a manual pass
 * against a desktop build.
 */
function readChatInput(): string {
  return readFileSync(
    fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function readSubmitCompactBody(source: string): string {
  const start = source.indexOf('const submitCompactFromInput = useCallback(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  ]);', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('/compact follow-up submission', () => {
  it('routes every /compact submission through the parser that keeps a follow-up', () => {
    const source = readChatInput();

    expect(source).toContain("caps.ops.has('compact') && parseCompactCommand(message)");
    // The old all-or-nothing gates rejected or warned on any extra argument.
    expect(source).not.toContain('isSlashCommand(message, \'/compact\')');
  });

  it('submits the follow-up only after the compaction has settled', () => {
    const body = readSubmitCompactBody(readChatInput());
    const compactionAt = body.indexOf('compactSession(sessionId)');
    const followUpAt = body.indexOf('sendMessage(followUp');

    expect(compactionAt).toBeGreaterThan(-1);
    expect(followUpAt).toBeGreaterThan(compactionAt);
    // Queueing instead of steering keeps the message out of the compaction turn
    // while its terminal bookkeeping is still settling.
    expect(body).toContain('sendImmediately: false');
  });

  it('returns the dropped follow-up as a draft without overwriting newer input', () => {
    const body = readSubmitCompactBody(readChatInput());

    expect(body).toContain('if (!inputValueRef.current.trim()) {');
    expect(body).toContain("dispatchInput({ type: 'SET_VALUE', payload: followUp })");
    expect(body).toContain("title: t('chatInput.compactFollowUpFailed')");
  });
});
