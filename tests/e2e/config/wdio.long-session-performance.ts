import { createEmbeddedConfig } from './embedded-driver';

if (!process.env.OPENBITFUN_LONG_SESSION_EVIDENCE) {
  throw new Error('Use node tests/e2e/scripts/run-long-session-performance.mjs to prepare isolated fixtures');
}
if (process.env.OPENBITFUN_LONG_SESSION_CDP_PORT) {
  const port = Number(process.env.OPENBITFUN_LONG_SESSION_CDP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    `--remote-debugging-port=${port}`].filter(Boolean).join(' ');
}
export const config = createEmbeddedConfig(['../specs/performance/long-session-performance.spec.ts'], 'Long session performance');
config.mochaOpts = { ...config.mochaOpts, timeout: 20 * 60_000 };
config.connectionRetryCount = 0; // Failed measurements must remain failures, not hidden retries.
