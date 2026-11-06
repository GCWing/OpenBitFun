// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenUIOpenUIDocument from './genUIOpenUI';
import { genUIProduct } from './genUIProduct';
import { isFatalGenUIError, isRepairWorthyGenUIError, type GenUIRenderDiagnostic } from './genUIRenderDiagnostics';

const valid = `root = Col([chart, picker, detail, foot])
chart = Svg(@Each(layerData, "f", Rect(0, f.y, 100, 20, "info")), "0 0 100 60", 100, 60)
picker = Col(@Each(layerData, "f", Button(f.name)))
detail = Text(layerData[0].name)
foot = Row([Button("Next", @ToAssistant("Next")), Button("More", @ToAssistant("More"))])
layerData = [{y: 0, name: "First floor"}, {y: 30, name: "Second floor"}]`;
const broken = valid.replace('@ToAssistant("Next")), Button', '@ToAssistant("Next"), Button');

describe('completed OpenUI structural evidence', () => {
  let container: HTMLDivElement;
  let root: Root;
  const reports = vi.fn<(errors: GenUIRenderDiagnostic[]) => void>();
  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    reports.mockClear();
  });
  afterEach(async () => { await act(async () => root.unmount()); });
  const render = async (content: string, streaming = false) => {
    await act(async () => root.render(<StrictMode><GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content }} library={genUIProduct.libraries['openui.v1']}
      isStreaming={streaming} onError={reports}
    /></StrictMode>));
    return reports.mock.lastCall?.[0] ?? [];
  };

  it('reports swallowed definitions and restores SVG, controls and detail after the missing parenthesis is repaired', async () => {
    const errors = await render(broken);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'parse-incomplete' }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', statementId: 'layerData' }));
    expect(errors.some(isFatalGenUIError)).toBe(true);
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(await render(valid)).toEqual([]);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(container.querySelectorAll('button')).toHaveLength(4);
    expect(container.textContent).toContain('First floor');
  });

  it.each([
    'root = Col([label])\nlabel = Text("Unclosed',
    'root = Text("Complete")\nunused = Button("Unclosed"',
  ])('reports incomplete source even without unresolved references: %s', async content => {
    expect((await render(content)).some(error => error.code === 'parse-incomplete')).toBe(true);
  });

  it('does not emit structural errors during streaming, but reports them when streaming ends', async () => {
    expect(await render(broken, true)).toEqual([]);
    expect((await render(broken)).some(isFatalGenUIError)).toBe(true);
    expect(await render(broken, true)).toEqual([]);
    expect(await render(valid)).toEqual([]);
  });

  it('requests repair for an undefined reference without treating it as a fatal parse failure', async () => {
    const errors = await render('root = Col([Text("Still usable"), missing])');
    expect(errors).toContainEqual(expect.objectContaining({ code: 'unresolved-reference', statementId: 'missing' }));
    expect(errors.some(isRepairWorthyGenUIError)).toBe(true);
    expect(errors.some(isFatalGenUIError)).toBe(false);
    expect(container.textContent).toContain('Still usable');
  });

  it('does not escalate a property type error or a state binding', async () => {
    const errors = await render('root = Col([Button("Wrong variant", null, 3), Text($name)])\n$name = "State value"');
    expect(errors).toContainEqual(expect.objectContaining({ code: 'type-mismatch' }));
    expect(errors.some(isRepairWorthyGenUIError)).toBe(false);
    expect(container.textContent).toContain('State value');
  });

  it('reports only the latest source when replacements are batched', async () => {
    await act(async () => {
      root.render(<GenUIOpenUIDocument source={{ kind: 'openui-lang', content: broken }} library={genUIProduct.libraries['openui.v1']} onError={reports} />);
      root.render(<GenUIOpenUIDocument source={{ kind: 'openui-lang', content: valid }} library={genUIProduct.libraries['openui.v1']} onError={reports} />);
    });
    expect(reports.mock.calls.every(([errors]) => errors.length === 0)).toBe(true);
  });
});
