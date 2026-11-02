// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MermaidBlock } from './MermaidBlock';
const renderDiagram = vi.hoisted(() => vi.fn());
vi.mock('@/tools/mermaid-editor/services/MermaidService', () => ({ MermaidService: { getInstance: () => ({ renderDiagram }) } }));
vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@/infrastructure/appearance/adapters/MermaidAppearanceAdapter', () => ({ mermaidAppearanceAdapter: { getRevision: () => 0, subscribe: () => () => {} } }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); renderDiagram.mockReset().mockResolvedValue('<svg><text>diagram</text></svg>');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const render = async (code: string, isStreaming = false) => {
  await act(async () => root.render(<MermaidBlock code={code} isStreaming={isStreaming} />));
  await act(async () => vi.advanceTimersByTimeAsync(201));
};
it.each(['block-beta\ncolumns 2\na b', 'flowchart LR\nA-->B'])('delegates completed %s syntax to the rendering service', async code => {
  await render(code);
  expect(renderDiagram).toHaveBeenCalledWith(code);
  expect(host.querySelector('svg')).not.toBeNull();
  expect(host.textContent).not.toContain('mermaidBlock.codeIncomplete');
});
it('reports the actual parser failure for completed invalid syntax', async () => {
  renderDiagram.mockRejectedValue(new Error('Unknown diagram type'));
  await render('not-a-diagram');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Unknown diagram type');
  expect(host.querySelector('code')?.textContent).toBe('not-a-diagram');
  expect(host.textContent).not.toContain('mermaidBlock.codeIncomplete');
});
it('waits during a streaming fence and parses when the stream completes', async () => {
  await render('block-be', true);
  expect(renderDiagram).not.toHaveBeenCalled();
  expect(host.querySelector('[data-openbitfun-part="streaming"]')).not.toBeNull();
  await render('block-beta\ncolumns 1\nc');
  expect(renderDiagram).toHaveBeenCalledOnce();
  expect(host.querySelector('svg')).not.toBeNull();
});
it('ignores a late render after the block starts streaming newer content', async () => {
  let finish!: (svg: string) => void;
  renderDiagram.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render('flowchart LR\nC-->D');
  await render('sequenceDiagram\nparticipant', true);
  await act(async () => finish('<svg><text>obsolete</text></svg>'));
  expect(host.querySelector('svg')).toBeNull();
  expect(host.querySelector('[data-openbitfun-part="streaming"]')).not.toBeNull();
});
