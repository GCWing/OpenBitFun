// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SkillScanDiagnostics } from './SkillScanDiagnostics';

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({ useI18n: () => ({
  t: (key: string, values?: { count?: number }) => values?.count ? `${key}:${values.count}` : key,
}) }));

describe('SkillScanDiagnostics', () => {
  it('keeps actionable scan details on the page and disables revealing remote paths', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onRetry = vi.fn(), onCopyPath = vi.fn(), onRevealPath = vi.fn();
    const props = { diagnostics: [{ sourceId: 'codex', path: '/remote/bad/SKILL.md', message: 'missing description' }],
      diagnosticsAvailable: true, loading: false, canRevealPath: false, onRetry, onCopyPath, onRevealPath };
    await act(async () => root.render(<SkillScanDiagnostics {...props} />));
    expect(container.querySelector('summary')?.textContent).toBe('list.diagnostics.title:1');
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).toContain('/remote/bad/SKILL.md');
    expect(container.textContent).toContain('missing description');
    expect(container.textContent).toContain('list.item.revealPathUnavailableRemote');
    const button = (text: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)!;
    await act(async () => { button('file.copyPath').click(); button('list.retry').click(); });
    expect(onCopyPath).toHaveBeenCalledWith('/remote/bad/SKILL.md');
    expect(onRetry).toHaveBeenCalledOnce();
    expect(button('list.item.openPathInExplorer').disabled).toBe(true);
    expect(onRevealPath).not.toHaveBeenCalled();
    await act(async () => root.render(<SkillScanDiagnostics {...props} canRevealPath />));
    await act(async () => button('list.item.openPathInExplorer').click());
    expect(onRevealPath).toHaveBeenCalledWith('/remote/bad/SKILL.md');
    await act(async () => root.render(<SkillScanDiagnostics {...props} diagnostics={[]} />));
    expect(container.textContent).toBe('');
    await act(async () => root.render(<SkillScanDiagnostics {...props} diagnostics={[]} diagnosticsAvailable={false} />));
    expect(container.textContent).toContain('list.diagnosticsUnavailable');
    await act(async () => root.unmount());
    container.remove();
  });
});
