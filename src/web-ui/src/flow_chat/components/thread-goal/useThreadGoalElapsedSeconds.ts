import { useEffect, useRef, useState } from 'react';

const TICK_INTERVAL_MS = 1000;

export interface ThreadGoalElapsedClock {
  /** Identity of the goal the accounted value belongs to. */
  goalId?: string;
  /** Seconds the backend has accounted for this goal so far. */
  accountedSeconds: number;
  /** True while a turn is driving the goal, which is the only time it is counted. */
  advancing: boolean;
}

/**
 * Elapsed seconds for one goal, counted up while the goal is being driven.
 *
 * The runtime accounts `timeUsedSeconds` at turn accounting points, so the value
 * arrives in steps and a track that only echoed it would jump. While a turn is
 * driving the goal the elapsed time really is growing, so the readout counts on
 * from the last accounted value and reads as a stopwatch instead.
 */
export function useThreadGoalElapsedSeconds({
  goalId,
  accountedSeconds,
  advancing,
}: ThreadGoalElapsedClock): number {
  const [displayedSeconds, setDisplayedSeconds] = useState(accountedSeconds);
  const goalIdRef = useRef(goalId);

  useEffect(() => {
    // Another goal is another clock. For the same goal the readout only moves
    // forward: an accounting snapshot can land behind the seconds already
    // counted here, and a goal must not appear to lose time.
    if (goalIdRef.current !== goalId) {
      goalIdRef.current = goalId;
      setDisplayedSeconds(accountedSeconds);
      return;
    }
    setDisplayedSeconds(previous => Math.max(previous, accountedSeconds));
  }, [accountedSeconds, goalId]);

  useEffect(() => {
    if (!advancing) return undefined;
    // Count from the clock rather than once per tick, so a timer the browser
    // throttled in a background tab does not silently lose the seconds it slept
    // through.
    let lastTickAt = Date.now();
    const timer = globalThis.setInterval(() => {
      const now = Date.now();
      const advancedSeconds = Math.floor((now - lastTickAt) / 1000);
      if (advancedSeconds <= 0) return;
      lastTickAt += advancedSeconds * 1000;
      setDisplayedSeconds(previous => previous + advancedSeconds);
    }, TICK_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [advancing]);

  return displayedSeconds;
}
