import { useSyncExternalStore } from 'react';
import { VisualSkinRuntime } from './runtime';

export * from './types';
export * from './contract';
export * from './validator';
export * from './parser';
export * from './storage';
export * from './runtime';

export const skinRuntime = new VisualSkinRuntime();

export function useVisualSkin() {
  const snapshot = useSyncExternalStore(
    listener => skinRuntime.subscribe(listener),
    () => skinRuntime.getSnapshot(),
    () => skinRuntime.getSnapshot(),
  );
  return {
    ...snapshot,
    watchProjection: skinRuntime.watchProjection,
    skins: snapshot.catalog,
    activate: (id: string) => skinRuntime.activate(id),
    preview: (id: string) => skinRuntime.preview(id),
    cancelPreview: () => skinRuntime.cancelPreview(),
    importPackage: (source: ArrayBuffer) => skinRuntime.importPackage(source),
    remove: (id: IDBValidKey) => skinRuntime.remove(id),
  };
}
