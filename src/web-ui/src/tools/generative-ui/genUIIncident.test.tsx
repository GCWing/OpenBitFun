/** @vitest-environment jsdom */
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { preflightGenUIApp } from './genUIContract';
import { GenUIStream } from './genUIStream';
import { genUIProduct } from './genUIProduct';
import type { GenUIAppDefinition } from './genUITypes';
import GenUIApplication from './GenUIApplication';

const app: GenUIAppDefinition = {
  schemaVersion: 2,
  id: 'source-incident',
  title: 'Source incident',
  template: 'openbitfun.app',
  libraryId: 'openbitfun.composable.v1',
  libraryRevision: 2,
  designSpec: { id: 'openbitfun.desktop.v1', revision: 1 },
  source: { kind: 'openui-lang', content: 'root = Col([Title("Amount")])' },
  state: {},
};

describe('source GenUI incident regressions', () => {
  it('rejects a source-less candidate without mutating it', () => {
    const legacy = { ...app, source: undefined };
    const before = JSON.stringify(legacy);
    expect(preflightGenUIApp(legacy)).toMatchObject({ accepted: false });
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it('does not revive removed tree fields while projecting a stream', () => {
    const projected = new GenUIStream().project({ ...app, nodes: [{ id: 'old', component: 'Text', props: {} }] } as any, genUIProduct.catalog);
    expect(projected.source).toEqual(app.source);
    expect(projected.nodes).toBeUndefined();
  });

  it('renders source documents and reports parser failures', async () => {
    const element = document.createElement('div');
    const root = createRoot(element);
    const reports = vi.fn();
    try {
      await act(async () => root.render(<GenUIApplication definition={app} onVerification={reports} />));
      expect(element.textContent).toContain('Amount');
      expect(reports.mock.lastCall?.[0].render).toBe('passed');
      expect(element.querySelector('[data-openbitfun-state]')?.getAttribute('data-openbitfun-state')).toBe('rendered');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('reports invalid HtmlView source without exposing internal diagnostics', async () => {
    const element = document.createElement('div');
    const root = createRoot(element);
    const definition: GenUIAppDefinition = {
      ...app,
      id: 'invalid-htmlview-source',
      source: {
        kind: 'openui-lang',
        content: 'root = HtmlView("""<canvas></canvas>""", 360, "Pendulum")',
      },
    };
    try {
      await act(async () => root.render(<GenUIApplication definition={definition} />));
      expect(element.querySelector('iframe')).not.toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
      expect(element.querySelector('[data-gen-ui-postcheck="failed"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('does not publish the initial OpenUI snapshot or enter an update loop', async () => {
    const element = document.createElement('div');
    const root = createRoot(element);
    const onStateChange = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const definition: GenUIAppDefinition = {
      ...app,
      id: 'initial-openui-snapshot',
      source: {
        kind: 'openui-lang',
        content: 'root = Col([drawing, angle])\ndrawing = Svg([Line(0, 0, 100, 100, "accent", 2)], "0 0 100 100", "100%", 180)\nangle = Slider($angle, -35, 35, 1, "摆角")',
      },
      state: { angle: { type: 'number', default: 24 } },
    };
    try {
      await act(async () => root.render(<GenUIApplication definition={definition} initialState={{ angle: 24 }} onStateChange={onStateChange} />));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(onStateChange).not.toHaveBeenCalled();
      expect(consoleError.mock.calls.some(([message]) => String(message).includes('Maximum update depth exceeded'))).toBe(false);
    } finally {
      await act(async () => root.unmount());
      consoleError.mockRestore();
    }
  });

  it('does not re-emit an unchanged report when the owner callback rerenders', async () => {
    const element = document.createElement('div');
    const root = createRoot(element);
    const reports = vi.fn();
    function Owner() {
      const [, setRevision] = useState(0);
      return <GenUIApplication definition={app} onVerification={report => {
        reports(report);
        setRevision(value => value + 1);
      }} />;
    }
    try {
      await act(async () => root.render(<Owner />));
      await act(async () => { await Promise.resolve(); });
      expect(reports).toHaveBeenCalledTimes(2);
      await act(async () => root.render(<Owner />));
      expect(reports).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
