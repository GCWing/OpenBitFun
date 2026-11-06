/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { GenUIRenderDiagnostic } from './genUIRenderDiagnostics';
import type { GenUIAppDefinition } from './genUITypes';
import { isFatalGenUIError, isRepairWorthyGenUIError } from './genUIRenderDiagnostics';
import GenUIApplication from './GenUIApplication';

const documentPort = vi.hoisted(() => ({ onError: undefined as undefined | ((errors: GenUIRenderDiagnostic[]) => void) }));
vi.mock('./GenUISourceDocument', () => ({ default: (props: { onError: (errors: GenUIRenderDiagnostic[]) => void; readOnly: boolean }) => {
  documentPort.onError = props.onError;
  return <button disabled={props.readOnly}>Working control</button>;
} }));
const app: GenUIAppDefinition = {
  schemaVersion: 2, id: 'errors', title: 'Errors', template: 'openbitfun.app',
  libraryId: 'openbitfun.composable.v1', libraryRevision: 2,
  designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, state: {},
  source: { kind: 'openui-lang', content: 'root = Col([])' },
};
const fatal: GenUIRenderDiagnostic = { source: 'parser', code: 'parse-failed', message: 'No statements parsed' };

describe('GenUI rendering diagnostics', () => {
  it.each<GenUIRenderDiagnostic>([
    { source: 'parser', code: 'type-mismatch', message: 'Wrong prop' },
    { source: 'parser', code: 'unknown-component', message: 'Unknown component' },
    { source: 'runtime', code: 'runtime-error', message: 'Evaluation failed' },
    { source: 'query', code: 'tool-error', message: 'Query failed' },
    { source: 'mutation', code: 'tool-error', message: 'Mutation failed' },
    { source: 'parser', code: 'unresolved-reference', message: 'Missing definition', statementId: 'missing' },
    { source: 'parser', code: 'missing-required', message: 'Component was removed' },
  ])('keeps controls usable for $source/$code and clears resolved diagnostics', async diagnostic => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const reports = vi.fn();
    try {
      await act(async () => root.render(<GenUIApplication definition={app} onVerification={reports} />));
      await act(async () => documentPort.onError?.([diagnostic]));
      expect(reports.mock.lastCall?.[0]).toMatchObject({ render: 'passed', diagnostics: [diagnostic] });
      expect(container.querySelector('button')?.disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () => documentPort.onError?.([]));
      expect(reports.mock.lastCall?.[0]).toMatchObject({ render: 'passed', diagnostics: [], issues: [] });
    } finally { await act(async () => root.unmount()); }
  });

  it.each(['parse-failed', 'parse-incomplete'] as const)('locks only completed %s failures and unlocks on an empty error report', async code => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const reports = vi.fn();
    try {
      await act(async () => root.render(<GenUIApplication definition={app} streaming onVerification={reports} />));
      await act(async () => documentPort.onError?.([{ ...fatal, code }]));
      expect(reports.mock.lastCall?.[0].render).toBe('unverified');
      expect(container.querySelector('button')?.disabled).toBe(false);
      await act(async () => root.render(<GenUIApplication definition={app} onVerification={reports} />));
      expect(reports.mock.lastCall?.[0].render).toBe('failed');
      expect(container.querySelector('button')?.disabled).toBe(true);
      await act(async () => documentPort.onError?.([]));
      expect(reports.mock.lastCall?.[0].render).toBe('passed');
      expect(container.querySelector('button')?.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); }
    expect(isFatalGenUIError({ ...fatal, code: 'parse-exception' })).toBe(true);
    expect(isFatalGenUIError({ ...fatal, severity: 'warning' })).toBe(false);
  });

  it('separates repair-worthy missing content from harmless diagnostics', () => {
    for (const code of ['unresolved-reference', 'missing-required', 'null-required'] as const) {
      expect(isRepairWorthyGenUIError({ ...fatal, code })).toBe(true);
      expect(isFatalGenUIError({ ...fatal, code })).toBe(false);
      expect(isRepairWorthyGenUIError({ ...fatal, code, severity: 'warning' })).toBe(false);
    }
    for (const code of ['type-mismatch', 'excess-args'] as const) expect(isRepairWorthyGenUIError({ ...fatal, code })).toBe(false);
  });
});
