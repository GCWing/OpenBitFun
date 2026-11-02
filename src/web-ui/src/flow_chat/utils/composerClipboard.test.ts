import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpPromptReference } from './mcpPromptReference';
import {
  getComposerInlineTokenMatches,
  readComposerClipboardTokens,
  writeComposerClipboardData,
  writeComposerClipboardPayload,
} from './composerClipboard';

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describeWithJsdom('composer clipboard payload', () => {
  beforeEach(() => {
    const dom = new JSDOMCtor!('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', dom.window.document);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches every inline token family in text order', () => {
    const mcp = createMcpPromptReference({ serverName: 'Docs', serverId: 'docs' });
    const text = `[$pdf] ${mcp} [[openbitfun-additional-mode:review]] plain`;

    expect(getComposerInlineTokenMatches(text).map(match => match.token)).toEqual([
      '[$pdf]',
      mcp,
      '[[openbitfun-additional-mode:review]]',
    ]);
    expect(getComposerInlineTokenMatches('plain text')).toEqual([]);
  });

  it('keeps the readable value and the canonical tokens in separate flavors', () => {
    const clipboard = new Map<string, string>();
    const clipboardData = {
      setData: (type: string, value: string) => clipboard.set(type, value),
    } as unknown as DataTransfer;

    expect(writeComposerClipboardData(clipboardData, {
      text: '[Skill: pdf] summarize it',
      tokens: '[$pdf] summarize it',
    })).toBe(true);

    expect(clipboard.get('text/plain')).toBe('[Skill: pdf] summarize it');
    expect(readComposerClipboardTokens(clipboard.get('text/html') ?? ''))
      .toBe('[$pdf] summarize it');
  });

  it('ignores foreign or unmarked html', () => {
    expect(readComposerClipboardTokens('')).toBeNull();
    expect(readComposerClipboardTokens('<p>[$pdf]</p>')).toBeNull();
  });

  it('falls back to plain text when the rich clipboard is unavailable', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await writeComposerClipboardPayload({ text: '[Skill: pdf]', tokens: '[$pdf]' });

    expect(writeText).toHaveBeenCalledWith('[Skill: pdf]');
  });
});
