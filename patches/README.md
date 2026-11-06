# Dependency patches

## xterm 6.1.0-beta.141: respect hidden rendering

`@xterm__xterm@6.1.0-beta.141.patch` backports the render-pause routing from
[xterm PR #6283](https://github.com/xtermjs/xterm.js/pull/6283), reviewed at
`c279844f2a8cfcff9dd3466805d354b634c56223`.

The pinned release's DOM renderer redraws rows directly for selection, blur and
focus changes. This bypasses RenderService's visibility and synchronized-output
gates after an inactive OpenBitFun terminal releases its WebGL renderer. The
patch routes those row redraws through the existing renderer event, checks
visibility again when a queued frame runs, and clears the selection replay flag
before replaying it. Parsing, buffer retention, selection state and overlays,
focus classes, cursor behavior and PTY lifetime retain their existing owners.
Visible DOM row redraws are scheduled through RenderService, as WebGL redraws
already are; this changes scheduling and requires native interaction coverage.

This is not an xterm version upgrade. It does not include the newer upstream
selection-range algorithm from `5c2b19f2c89eef1fb9743746f093bf93264762a2`.
The beta release requires a named `_onRequestRedraw` emitter for the backport;
its prior anonymous emitter already exposed the same public event.

Reproduction uses the npm release's source commit
`8f9045ed882aa663a63935e216501f43d757188d`:

1. Check out that commit in a separate upstream directory and run
   `npm ci --ignore-scripts` with its package lock, including esbuild 0.25.12.
2. Use `src/common/Version.ts` from the published beta package. This is the
   only source difference between that checkout and the published sources.
3. Run `npm run package` before applying changes. Both `lib/xterm.js` and
   `lib/xterm.mjs`, plus both source maps, must match the unpatched npm package
   byte for byte. This control was verified when creating this patch.
4. Apply the two TypeScript source diffs from this patch and run
   `npm run package` again. Remove the trailing `sourceMappingURL` comment from
   the generated UMD bundle (`lib/xterm.js`). Its updated map would exceed the
   repository's 5 MiB limit for the patch, and the original map has stale offsets.
   Keep the generated ESM bundle and its updated map together.
5. Use `pnpm patch @xterm/xterm@6.1.0-beta.141 --edit-dir <staging-directory>`.
   Copy the two changed sources, both bundles, and the ESM map to staging,
   then use `pnpm patch-commit <staging-directory>`. Preserve the workspace's
   existing patch entries. Never modify the shared pnpm store directly.

Both package entry points carry the same source change. The Web UI consumes the
ESM entry point, which retains source-map support.

Run `node --test tests/e2e/scripts/xterm-render-pause.test.mjs` against the
installed package. It checks the actual RenderService source with controlled
frames and observers, including selection replay and synchronized output. It
does not establish actual DOM rendering, OS input or performance. Native
selection and heavy-output verification are documented in
[`tests/e2e/AGENTS.md`](../tests/e2e/AGENTS.md); results and outstanding work are
tracked in the [workload report](../docs/performance/06-workload-residency-baseline-2026-11-05.md).
