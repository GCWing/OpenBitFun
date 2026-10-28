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

  it('never restores a submitted /compact back into the composer', () => {
    // The desktop /compact entry point only settles after the compaction
    // reaches a terminal state, so a restore on failure repopulates the
    // composer minutes later - sometimes after the compaction was applied and
    // only its terminal bookkeeping failed. The submitted command text is not a
    // draft: clear it once and report the failure instead of refilling it.
    const body = readCallbackBody(component, 'submitCompactFromInput');

    expect(body).toContain("dispatchInput({ type: 'CLEAR_VALUE' })");
    expect(body).not.toContain('SET_VALUE');
    expect(body).toContain('compactSession');
    expect(body.indexOf('compactSession')).toBeGreaterThan(
      body.indexOf("dispatchInput({ type: 'CLEAR_VALUE' })"),
    );
  });

  it('clears the machine queue so the submission cannot be restored later', () => {
    // The queuedInput sync effect restores queued text into an empty composer;
    // a queue entry left behind by the command submission would resurface it.
    const body = readCallbackBody(component, 'submitCompactFromInput');
    expect(body).toContain('setQueuedInput(null)');
  });
});
