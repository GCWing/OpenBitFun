/**
 * Adapter-fence regression test.
 *
 * The `no-restricted-imports` / `no-restricted-syntax` rules in
 * `eslint.config.mjs` block direct and dynamic `invoke` imports from
 * `@tauri-apps/api/core` everywhere except `adapters/**` and the documented
 * `PeerHostInvokeBridge` exception. PR #2428 review #3 found that a global
 * `ignores` entry for `src/shared/context-system/core/types/**` let the whole
 * fence be bypassed in that directory — a direct `invoke` there passed lint.
 *
 * This test pins that the fence now applies to:
 *  - an ordinary business directory (always did), and
 *  - the context-system types directory (the regression).
 *
 * It also pins that the adapter exception still permits direct `invoke` inside
 * `adapters/**`. Run via `pnpm vitest run`.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const webUiRoot = resolve(__dirname);

interface ProbeCase {
  name: string;
  filename: string;
  source: string;
  expectError: boolean;
}

const STATIC_PROBE = `import { invoke } from '@tauri-apps/api/core';
export const run = () => invoke('probe');
`;

const DYNAMIC_PROBE = `const mod = await import('@tauri-apps/api/core');
export const run = () => mod.invoke('probe');
`;

const cases: ProbeCase[] = [
  {
    name: 'ordinary business dir: static invoke is blocked',
    filename: 'src/app/__fence_probe_static.tsx',
    source: STATIC_PROBE,
    expectError: true,
  },
  {
    name: 'ordinary business dir: dynamic invoke is blocked',
    filename: 'src/app/__fence_probe_dynamic.tsx',
    source: DYNAMIC_PROBE,
    expectError: true,
  },
  {
    name: 'context-system types dir: static invoke is blocked (regression)',
    filename: 'src/shared/context-system/core/types/__fence_probe_static.tsx',
    source: STATIC_PROBE,
    expectError: true,
  },
  {
    name: 'context-system types dir: dynamic invoke is blocked (regression)',
    filename: 'src/shared/context-system/core/types/__fence_probe_dynamic.tsx',
    source: DYNAMIC_PROBE,
    expectError: true,
  },
  {
    name: 'adapter dir: static invoke is allowed (exception)',
    filename: 'src/infrastructure/api/adapters/__fence_probe_static.ts',
    source: STATIC_PROBE,
    expectError: false,
  },
];

// Exercise the real file-selected config with one ESLint instance. Spawning a
// fresh CLI for each probe made cold Node/config loading exceed the test budget
// under the full suite's worker load. Load config during module collection,
// like the other imports, and keep assertions about the actual rule outcomes.
const eslint = new ESLint({ cwd: webUiRoot });
await eslint.calculateConfigForFile(cases[0].filename);

async function lintProbe(probe: ProbeCase): Promise<{ hasError: boolean; errorCount: number; output: string }> {
  const results = await eslint.lintText(probe.source, { filePath: probe.filename });
  const messages = results.flatMap(result => result.messages);
  return {
    hasError: messages.some(message => /^no-restricted-(imports|syntax)$/.test(message.ruleId ?? '')),
    errorCount: results.reduce((count, result) => count + result.errorCount, 0),
    output: messages.map(message => `${message.ruleId ?? 'config'}: ${message.message}`).join('\n'),
  };
}

describe('adapter fence regression', () => {
  for (const probe of cases) {
    it(probe.name, async () => {
      const { hasError, errorCount, output } = await lintProbe(probe);
      if (probe.expectError) {
        expect(
          hasError,
          `expected the fence to block a direct/dynamic invoke at ${probe.filename}, but it did not:\n${output}`,
        ).toBe(true);
      } else {
        expect(
          hasError,
          `expected the adapter exception to allow invoke at ${probe.filename}, but the fence fired:\n${output}`,
        ).toBe(false);
        expect(errorCount, output).toBe(0);
      }
    });
  }
});
