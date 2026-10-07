import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { formatThreadGoalElapsedSeconds } from './threadGoalDuration';

// Mirrors the shape of the `threadGoal.duration.*` locale entries: the assertion
// is which units a duration is decomposed into, not the wording of one locale.
const PATTERNS: Record<string, string> = {
  'threadGoal.duration.seconds': '{{seconds}}s',
  'threadGoal.duration.minutesSeconds': '{{minutes}}m {{seconds}}s',
  'threadGoal.duration.hoursMinutesSeconds': '{{hours}}h {{minutes}}m {{seconds}}s',
  'threadGoal.duration.daysHoursMinutesSeconds': '{{days}}d {{hours}}h {{minutes}}m {{seconds}}s',
};

const t = ((key: string, options?: Record<string, unknown>) => {
  const pattern = PATTERNS[key];
  if (pattern === undefined) {
    throw new Error(`Unexpected duration key: ${key}`);
  }
  return pattern.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(options?.[name] ?? '')
  );
}) as unknown as TFunction;

describe('formatThreadGoalElapsedSeconds', () => {
  it('counts seconds while the goal is younger than a minute', () => {
    expect(formatThreadGoalElapsedSeconds(0, t)).toBe('0s');
    expect(formatThreadGoalElapsedSeconds(59, t)).toBe('59s');
  });

  it('names minutes and the seconds under them', () => {
    expect(formatThreadGoalElapsedSeconds(60, t)).toBe('1m 0s');
    expect(formatThreadGoalElapsedSeconds(91, t)).toBe('1m 31s');
  });

  it('names hours instead of counting a growing minute total', () => {
    expect(formatThreadGoalElapsedSeconds(3600, t)).toBe('1h 0m 0s');
    expect(formatThreadGoalElapsedSeconds(3661, t)).toBe('1h 1m 1s');
    expect(formatThreadGoalElapsedSeconds(86_399, t)).toBe('23h 59m 59s');
  });

  it('names days once a goal has been running that long', () => {
    expect(formatThreadGoalElapsedSeconds(86_400, t)).toBe('1d 0h 0m 0s');
    expect(formatThreadGoalElapsedSeconds(90_061, t)).toBe('1d 1h 1m 1s');
  });

  it('keeps a readout for values a clock cannot supply', () => {
    expect(formatThreadGoalElapsedSeconds(-5, t)).toBe('0s');
    expect(formatThreadGoalElapsedSeconds(Number.NaN, t)).toBe('0s');
  });
});
