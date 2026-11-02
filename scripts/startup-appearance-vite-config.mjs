import path from 'node:path';

/** This is an SSR data generator, not another instance of the product dev server. */
export function createStartupAppearanceViteConfig(webUiRoot) {
  return {
    root: webUiRoot,
    configFile: false,
    envFile: false,
    cacheDir: path.join(webUiRoot, 'node_modules/.vite-startup-appearance'),
    logLevel: 'error',
    appType: 'custom',
    resolve: { alias: { '@': path.join(webUiRoot, 'src') } },
    server: { middlewareMode: true, hmr: false },
    // entries/noDiscovery alone do not disable prebundling: Vite merges the
    // product config's include list and can replace a live server's deps cache.
    // With configFile:false, this empty include list remains empty.
    optimizeDeps: { entries: [], noDiscovery: true, include: [] },
  };
}
