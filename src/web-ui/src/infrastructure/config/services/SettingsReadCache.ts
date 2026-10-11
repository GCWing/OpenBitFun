import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

/** A last successful runtime read, never persisted and never shared across device activations.
 * Reads still revalidate; only simultaneous requests are deduplicated.
 * Configuration values belong to ConfigManager instead.
 */
export function createSettingsReadCache<T>() {
  let snapshot: { epoch: number; key: string; value: T } | undefined;
  let pending: { epoch: number; key: string; promise: Promise<T> } | undefined;
  let revision = 0;
  return {
    peek(key = ''): T | undefined {
      return snapshot?.epoch === getActiveSurfaceScope().epoch && snapshot.key === key
        ? snapshot.value : undefined;
    },
    invalidate() {
      revision += 1;
      snapshot = undefined;
      pending = undefined;
    },
    read(load: () => Promise<T>, key = ''): Promise<T> {
      const scope = getActiveSurfaceScope();
      if (pending?.epoch === scope.epoch && pending.key === key) return pending.promise;
      const requestRevision = ++revision;
      const promise = Promise.resolve().then(() => {
        scope.assertCurrent('read settings runtime state');
        return load();
      }).then(value => {
        scope.assertCurrent('receive settings runtime state');
        if (requestRevision === revision) snapshot = { epoch: scope.epoch, key, value };
        return value;
      }).finally(() => {
        if (pending?.promise === promise) pending = undefined;
      });
      pending = { epoch: scope.epoch, key, promise };
      return promise;
    },
  };
}
