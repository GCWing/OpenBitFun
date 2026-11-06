# Terminal

Follow the Web UI guide. Terminal buffers, PTY lifetime and user interaction
remain owned by the existing terminal components and services.

For the opt-in, read-only native performance snapshot:

```bash
pnpm --dir src/web-ui exec vitest run src/tools/terminal/services/terminalDiagnostics.test.ts src/tools/terminal/components/Terminal.linkActivation.test.tsx
pnpm run check:web
```

For PTY/frontend geometry across suspended or interrupted pane resizing, run
`pnpm --dir src/web-ui exec vitest run src/tools/terminal/components/Terminal.resize.test.tsx`
and `pnpm run check:web`. The component fixture checks deferred synchronization
and deduplication; the native heavy-terminal runner in `tests/e2e/AGENTS.md`
checks real PTY geometry and continuing output through the UI.

The snapshot is enabled only by `__OPENBITFUN_PERF_TRACE_ENABLED__`. It exposes
copied viewport/tail text, geometry and buffer metadata, never engine handles or
write/resize/dispose operations. It adds no polling or parser/render callbacks.
Weak references and component cleanup keep observation from extending terminal
lifetime. Canvas count alone does not establish WebGL allocation or GPU memory;
buffer contents plus RAF opportunities do not establish compositor pixels.

These local fixtures prove the gate, readback and cleanup contract, not native
performance, OS input behavior or live remote transport.

For the pinned xterm rendering patch, run
`node --test tests/e2e/scripts/xterm-render-pause.test.mjs` from the repository
root. `patches/README.md` records upstream provenance and bundle reproduction.
The native selection and sustained-output runners in `tests/e2e/AGENTS.md`
cover the actual renderer and PTY; the service fixture cannot replace them.
