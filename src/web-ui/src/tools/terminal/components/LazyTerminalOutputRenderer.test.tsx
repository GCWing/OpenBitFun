// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TerminalOutputFallback } from './LazyTerminalOutputRenderer';
import { readTerminalOutputFontFamily } from './terminalOutputPresentation';
import { getTypographyTokenValue } from '@/infrastructure/design-system/typographyRuntime';

it('resolves the active output font at use time rather than module import time', () => {
  const style = document.documentElement.style;
  const property = '--openbitfun-font-family-mono';
  const previous = style.getPropertyValue(property);
  try {
    const family = '"Fira Code", "OpenBitFun HarmonyOS Sans SC", monospace';
    style.setProperty(property, family);
    expect(readTerminalOutputFontFamily()).toBe(family);
    style.removeProperty(property);
    expect(readTerminalOutputFontFamily()).toBe(getTypographyTokenValue('font.family.mono'));
  } finally {
    if (previous) style.setProperty(property, previous);
    else style.removeProperty(property);
  }
});

describe('TerminalOutputFallback', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('reserves bounded row height while the xterm renderer chunk loads', () => {
    act(() => {
      root.render(
        <TerminalOutputFallback
          content={['one', 'two', 'three', 'four'].join('\n')}
          maxRows={2}
        />
      );
    });

    const fallback = container.querySelector<HTMLPreElement>('pre.terminal-output-pre');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe('three\nfour');
    expect(fallback?.dataset.openbitfunComponent).toBe('terminal-tool');
    expect(fallback?.dataset.openbitfunPart).toBe('output');
    expect(fallback?.style.height).toBe('34px');
    expect(fallback?.style.overflow).toBe('hidden');
  });

  it('uses the same normalized rows as the xterm renderer', () => {
    act(() => {
      root.render(
        <TerminalOutputFallback
          content={'one\n\x1b[?25h'}
          maxRows={2}
        />
      );
    });

    const fallback = container.querySelector<HTMLPreElement>('pre.terminal-output-pre');
    expect(fallback?.textContent).toBe('one');
    expect(fallback?.style.height).toBe('17px');
  });
});
