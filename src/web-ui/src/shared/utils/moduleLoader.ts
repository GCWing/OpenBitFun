/** Only module transport errors are retryable; execution and syntax errors are not. */
export function isModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError') {
    return /(?:failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module)/i.test(error.message);
  }
  return /^Unable to preload CSS for /i.test(error.message);
}

/** Keep the literal import at the call site so Vite can still split/preload it. */
export async function importWithRetry<T>(load: () => Promise<T>): Promise<T> {
  const delays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (!isModuleLoadError(error) || attempt >= delays.length) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Share preload/render work and successful modules, but never a rejected promise. */
export function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= importWithRetry(load).catch(error => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

const failedModuleListeners = new Set<() => void>();

export function subscribeToModuleRecovery(retry: () => void): () => void {
  failedModuleListeners.add(retry);
  return () => { failedModuleListeners.delete(retry); };
}

export function retryFailedModuleLoads(): void {
  // Retrying unsubscribes the failed boundary. Snapshot before notifying.
  for (const retry of [...failedModuleListeners]) retry();
}

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', retryFailedModuleLoads);
  import.meta.hot.on('vite:ws:connect', retryFailedModuleLoads);
  import.meta.hot.dispose(() => {
    import.meta.hot?.off('vite:afterUpdate', retryFailedModuleLoads);
    import.meta.hot?.off('vite:ws:connect', retryFailedModuleLoads);
    failedModuleListeners.clear();
  });
}
