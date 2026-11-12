import { createEmbeddedConfig } from './embedded-driver';

if (!process.env.OPENBITFUN_LONG_SESSION_EVIDENCE) {
  throw new Error('Use node tests/e2e/scripts/run-long-session-performance.mjs to prepare isolated fixtures');
}
export const config = createEmbeddedConfig(['../specs/performance/long-session-performance.spec.ts'], 'Long session performance');
config.mochaOpts = { ...config.mochaOpts, timeout: 20 * 60_000 };
config.connectionRetryCount = 0; // Failed measurements must remain failures, not hidden retries.
