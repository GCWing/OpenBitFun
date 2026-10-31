import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readChatInputComponent(): string {
  return readFileSync(fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readCallbackBody(component: string, entry: string): string {
  const start = component.indexOf(`const ${entry} = useCallback(`);
  expect(start).toBeGreaterThan(-1);
  return component.slice(start, component.indexOf('  }, [', start));
}

describe('composer ownership of local slash commands', () => {
  const component = readChatInputComponent();

  it('hands /compact back only when the host never admitted it', () => {
    // The desktop /compact entry point settles only after the compaction
    // reaches a terminal state. An admitted compaction already reported its
    // outcome in the transcript (and may have applied before failing), so
    // refilling the composer there puts "/compact" back minutes later. Only an
    // early rejection - no maintenance turn - is a retryable draft.
    const body = readCallbackBody(component, 'submitCompactFromInput');

    expect(body).toContain("dispatchInput({ type: 'CLEAR_VALUE' })");
    expect(body.indexOf('const knownTurnIds')).toBeGreaterThan(-1);
    expect(body.indexOf('const knownTurnIds')).toBeLessThan(body.indexOf('compactSession'));
    expect(body).toMatch(
      /if \(!manualCompactionTurnStarted\(knownTurnIds,[\s\S]*?dispatchInput\(\{ type: 'SET_VALUE', payload: message \}\);\s*\n\s*\}/,
    );
  });

  it('clears the machine queue so the submission cannot be restored later', () => {
    // The queuedInput sync effect restores queued text into an empty composer;
    // a queue entry left behind by the command submission would resurface it.
    const body = readCallbackBody(component, 'submitCompactFromInput');
    expect(body).toContain('setQueuedInput(null)');
  });
});
