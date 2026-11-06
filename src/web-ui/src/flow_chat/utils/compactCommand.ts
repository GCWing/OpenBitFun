import { matchesSlashCommand, stripSlashCommand } from './slashCommand';

/**
 * A manual `/compact` submission.
 *
 * The command owns the composer text it was submitted with, so anything the
 * user typed after `/compact` is the message to submit once the compaction
 * finishes. Auto-triggered compaction never goes through the composer and
 * therefore never carries a follow-up.
 */
export interface CompactCommandRequest {
  /** Message to submit after the compaction completes; empty when there is none. */
  followUp: string;
}

/**
 * Parse a composer submission as `/compact [followUp]`.
 *
 * Returns `null` for any other prompt, so the caller can fall through to the
 * ordinary message path.
 */
export function parseCompactCommand(input: string): CompactCommandRequest | null {
  const text = input.trim();
  if (matchesSlashCommand(text) !== '/compact') {
    return null;
  }

  return { followUp: stripSlashCommand(text, '/compact').trim() };
}
