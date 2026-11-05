// @openuidev/react-lang auto-mounts its inspector in development. GenUI owns
// the host surface and must not inject a second fixed overlay into previews or
// delivery probes; product diagnostics are surfaced through our checker.
if (import.meta.env.DEV) {
  (globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;
}

