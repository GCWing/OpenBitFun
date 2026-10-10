import { useState } from 'react';
import { configManager } from '../services/ConfigManager';

/** Seed a form only from a complete, trusted snapshot. Never hydrate over a draft. */
export function useConfigSeed(paths: readonly string[]) {
  return useState(() => {
    const loaded = paths.every(path => configManager.hasCachedConfig(path));
    const values = new Map(paths.map(path => [path, loaded ? configManager.getCachedConfig(path) : undefined]));
    return {
      loaded,
      get<T>(path: string, fallback: T): T {
        const value = values.get(path);
        return value === undefined ? fallback : value as T;
      },
    };
  })[0];
}
