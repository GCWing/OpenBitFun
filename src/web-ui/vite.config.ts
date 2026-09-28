import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { versionInjectionPlugin } from "./vite.config.version-plugin";
import { openbitfunCanvasRuntimeBundlePlugin } from "./vite.config.canvas-runtime-plugin";
import { watchSourcePlugin } from "../../design-system/tooling/vite/watch-source.mjs";
import {
  APPLE_SYSTEM_FONT_PROFILE,
  HARMONY_BUNDLED_FONT_PROFILE,
  WEB_FONT_PROFILE_ENV,
  assertWebFontProfileBundle,
  resolveWebFontProfile,
  verifyHarmonyFontSources,
} from "../../scripts/web-font-profile.mjs";

import { resolveDevServerPorts } from '../../scripts/dev-server-ports.mjs';

const host = process.env.TAURI_DEV_HOST;
const requireFromWebUi = createRequire(path.join(__dirname, 'package.json'));
const { port: devPort, hmrPort } = resolveDevServerPorts();
const designSystemUiSourceDirectory = path.resolve(
  __dirname,
  '../../design-system/packages/ui/src',
);
const fontAssetDirectory = path.resolve(__dirname, 'src/assets/fonts');
const FONT_PROFILE_STYLESHEET_MARKER = '<!-- OPENBITFUN_FONT_PROFILE_STYLESHEET -->';

export function createWebFontProfilePlugin(
  profile: typeof APPLE_SYSTEM_FONT_PROFILE | typeof HARMONY_BUNDLED_FONT_PROFILE,
  command: 'serve' | 'build',
): Plugin {
  const stylesheetPath = `/src/font-profiles/${profile}.css`;

  if (command === 'build' && profile === HARMONY_BUNDLED_FONT_PROFILE) {
    verifyHarmonyFontSources(path.join(fontAssetDirectory, 'harmonyos-sans'));
  }

  return {
    name: 'openbitfun-web-font-profile',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(FONT_PROFILE_STYLESHEET_MARKER)) {
          throw new Error('Web font profile stylesheet marker is missing from index.html.');
        }
        return html
          .replace(
            FONT_PROFILE_STYLESHEET_MARKER,
            `<link rel="stylesheet" href="${stylesheetPath}" data-openbitfun-font-profile-stylesheet="${profile}" />`,
          )
          .replace(
            '<html lang="zh-CN">',
            `<html lang="zh-CN" data-openbitfun-font-profile="${profile}">`,
          );
      },
    },
    buildStart() {
      if (command !== 'build' || profile !== HARMONY_BUNDLED_FONT_PROFILE) return;

      for (const [fileName, sourcePath] of [
        [
          'third-party/fonts/harmonyos-sans/LICENSE.txt',
          path.join(fontAssetDirectory, 'harmonyos-sans/LICENSE.txt'),
        ],
        [
          'third-party/fonts/harmonyos-sans/NOTICE.txt',
          path.join(fontAssetDirectory, 'harmonyos-sans/NOTICE.txt'),
        ],
        [
          'third-party/fonts/fira-code/LICENSE.txt',
          path.join(fontAssetDirectory, 'fira-code/LICENSE.txt'),
        ],
      ]) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(sourcePath) });
      }
    },
    generateBundle(_options, bundle) {
      if (command !== 'build') return;
      assertWebFontProfileBundle(profile, Object.keys(bundle));
    },
  };
}

/**
 * Product development consumes the design-system source so Vite can preserve
 * React Fast Refresh and CSS-module HMR. Production builds deliberately return
 * no aliases and resolve the package's published `dist` exports instead.
 */
export function createDesignSystemSourceAliases(command: 'serve' | 'build') {
  if (command !== 'serve') {
    return [];
  }

  return [
    {
      find: /^@openbitfun\/ui\/brand$/,
      replacement: path.join(designSystemUiSourceDirectory, 'brand.ts'),
    },
    {
      find: /^@openbitfun\/ui\/flow-chat$/,
      replacement: path.join(designSystemUiSourceDirectory, 'flow-chat.ts'),
    },
    {
      find: /^@openbitfun\/ui\/registry$/,
      replacement: path.join(designSystemUiSourceDirectory, 'registry.ts'),
    },
    {
      find: /^@openbitfun\/ui\/styles\.css$/,
      replacement: path.join(designSystemUiSourceDirectory, 'styles/layers.css'),
    },
    {
      find: /^@openbitfun\/ui$/,
      replacement: path.join(designSystemUiSourceDirectory, 'index.ts'),
    },
  ];
}

export function createDevServerResponseHeaders() {
  return {
    // Vite normally marks optimized dependencies as immutable for one year.
    // WKWebView can retain those responses across desktop dev launches and
    // then reject a lazy module graph after the optimizer has refreshed it.
    'Cache-Control': 'no-store',
  };
}

/**
 * Native fs events do not work reliably on UNC network shares (\\server\...,
 * including \\wsl$ / \\wsl.localhost) or on WSL drvfs mounts (/mnt/<drive>).
 * Users upgrading from the polling-based watcher would silently lose HMR
 * there, so print a one-line hint pointing at the VITE_USE_POLLING escape
 * hatch.
 */
function warnIfNativeWatchUnreliable(): void {
  const cwd = process.cwd();
  const looksLikeNetworkOrWslMount =
    cwd.startsWith("\\\\") || /^\/mnt\/[a-z]\//i.test(cwd);
  if (looksLikeNetworkOrWslMount) {
    console.warn(
      `[openbitfun] Project path "${cwd}" looks like a network share or WSL mount; ` +
        "native file watching may miss changes here. " +
        "Set VITE_USE_POLLING=1 to restore polling-based HMR.",
    );
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isProduction = mode === 'production' || (command === 'build' && mode !== 'development');
  const fontProfile = resolveWebFontProfile({
    requested: process.env[WEB_FONT_PROFILE_ENV],
    command,
    platform: process.platform,
  });

  console.log(`[font-profile] ${fontProfile}`);

  if (command === 'serve' && !process.env.VITE_USE_POLLING) {
    warnIfNativeWatchUnreliable();
  }

  return {
    // Independent dev ports must not replace each other's optimized deps.
    // In-process generators use their own config and cache directory.
    cacheDir: path.resolve(__dirname, 'node_modules/.vite', `dev-${devPort}`),
    plugins: [
      createWebFontProfilePlugin(fontProfile, command),
      react(),
      watchSourcePlugin(designSystemUiSourceDirectory),
      openbitfunCanvasRuntimeBundlePlugin(),
      versionInjectionPlugin()
    ],

    // Path resolution
    resolve: {
      dedupe: ['react', 'react-dom', 'lucide-react'],
      alias: [
        // @xterm/headless 6.1.0-beta.141 advertises a missing lib/xterm.mjs.
        // Resolve its published ESM entry for both dev optimization and builds.
        {
          find: /^@xterm\/headless$/,
          replacement: requireFromWebUi.resolve('@xterm/headless/lib-headless/xterm-headless.mjs'),
        },
        ...createDesignSystemSourceAliases(command),
        { find: "@/shared", replacement: path.resolve(__dirname, "./src/shared") },
        { find: "@/core", replacement: path.resolve(__dirname, "./src/core") },
        { find: "@/tools", replacement: path.resolve(__dirname, "./src/tools") },
        { find: "@/hooks", replacement: path.resolve(__dirname, "./src/hooks") },
        { find: "@/types", replacement: path.resolve(__dirname, "./src/shared/types") },
        { find: "@/utils", replacement: path.resolve(__dirname, "./src/shared/utils") },
        { find: "@", replacement: path.resolve(__dirname, "./src") },
      ],
    },

  css: {
    preprocessorOptions: {
      scss: {
        // SCSS preprocessing options (sourcemap is controlled by build.sourcemap)
      },
    },
    // dev mode enabled, release mode disabled
    devSourcemap: !isProduction,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
    // The desktop launcher uses the same configured development port.
    // If Vite silently falls back to another port, the desktop webview stays blank.
    strictPort: true,
    host: host || "localhost",
    headers: createDevServerResponseHeaders(),
    hmr: {
      protocol: "ws",
      host: host || "localhost",
      port: hmrPort,
    },
    // Allow access to workspace root for dependencies like monaco-editor
    fs: {
      allow: [
        path.resolve(__dirname, '../../'), // Workspace root
      ],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and `apps`
      ignored: ["**/src-tauri/**", "**/apps/**"],
      // Native fs events by default (polling burned CPU scanning ~1.7k files
      // every 100ms). Escape hatch for network drives / exotic filesystems:
      // set VITE_USE_POLLING=1 to re-enable polling.
      ...(process.env.VITE_USE_POLLING
        ? { usePolling: true, interval: 1000 }
        : {}),
    },
  },

  // Optimize dependency pre-building
  optimizeDeps: {
    // Exclude dependencies that need to be dynamically loaded
    exclude: [
      '@openbitfun/design-tokens',
      '@openbitfun/theme-openbitfun',
      '@openbitfun/ui',
    ],
    // Force pre-building dependencies
    // Resolve Vite 7 and React 18 compatibility issues
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'mermaid',
      'mermaid/dist/mermaid.esm.min.mjs',
    ],
  },

  // Build options
  build: {
    // Enable CSS code splitting
    cssCodeSplit: true,
    // release version disable sourcemap, dev/debug version enable
    sourcemap: !isProduction,
    // Output to the project root directory dist/
    outDir: '../../dist',
    // Empty the output directory
    emptyOutDir: true,
  }
  };
});
