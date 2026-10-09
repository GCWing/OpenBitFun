import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

const submissions = new Map<string, Set<Promise<unknown>>>();
const closures = new Map<string, Promise<void>>();
const sessionKey = (sessionId: string) => getActiveSurfaceScope().key('btw-lifecycle', sessionId);

export function isBtwSessionClosing(sessionId: string): boolean {
  return closures.has(sessionKey(sessionId));
}

/** Tracks both the initial context fork and subsequent accepted submissions. */
export async function trackBtwSessionSubmission<T>(sessionId: string, submit: () => Promise<T>): Promise<T> {
  const scope = getActiveSurfaceScope();
  const key = sessionKey(sessionId);
  if (closures.has(key)) throw new Error('BTW session is closing');
  const pending = submissions.get(key) ?? new Set<Promise<unknown>>();
  submissions.set(key, pending);
  const request = Promise.resolve().then(() => {
    scope.assertCurrent('submit BTW question');
    return submit();
  });
  pending.add(request);
  try {
    return await request;
  } finally {
    pending.delete(request);
    if (pending.size === 0) submissions.delete(key);
  }
}

/** Admission stops immediately; cleanup waits until in-flight submissions settle. */
export function closeBtwSessionAfterSubmissions(sessionId: string, close: () => Promise<void>): Promise<void> {
  const key = sessionKey(sessionId);
  const existing = closures.get(key);
  if (existing) return existing;
  const request = (async () => {
    await Promise.allSettled([...(submissions.get(key) ?? [])]);
    await close();
  })().finally(() => closures.delete(key));
  closures.set(key, request);
  return request;
}
