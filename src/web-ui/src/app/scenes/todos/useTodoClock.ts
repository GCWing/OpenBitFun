import { useLayoutEffect, useState } from 'react';

const CLOCK_TICK_MS = 30_000;

/** Only the displayed countdown needs ticks; job subscriptions remain live. */
export function useTodoClock(isActive: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useLayoutEffect(() => {
    if (!isActive) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (document.hidden) return;
      // Catch up before a retained scene paints, including a day/month boundary.
      setNowMs(Date.now());
      timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [isActive]);
  return nowMs;
}
