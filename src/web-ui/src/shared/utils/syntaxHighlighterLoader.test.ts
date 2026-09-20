import { expect, it, vi } from 'vitest';

it('keeps the fallback available until the AST engine is ready and shares concurrent loads', async () => {
  vi.resetModules();
  let finishEngine!: () => void;
  const engineReady = new Promise<void>(resolve => { finishEngine = resolve; });
  const preload = vi.fn(() => engineReady);
  const component = Object.assign(() => null, { preload });
  vi.doMock('react-syntax-highlighter/dist/esm/prism-async-light', () => ({ default: component }));
  try {
    const loader = await import('./syntaxHighlighterLoader');
    const first = loader.loadPrismSyntaxHighlighter();
    const second = loader.loadPrismSyntaxHighlighter();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(1));
    expect(loader.getLoadedPrismSyntaxHighlighter()).toBeNull();
    finishEngine();
    expect(await first).toBe(component);
    expect(loader.getLoadedPrismSyntaxHighlighter()).toBe(component);
  } finally {
    vi.doUnmock('react-syntax-highlighter/dist/esm/prism-async-light');
    vi.resetModules();
  }
});
