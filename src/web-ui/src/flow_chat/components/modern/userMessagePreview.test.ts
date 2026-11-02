import { describe, expect, it } from 'vitest';
import type { ComposerPresentation } from '../../utils/composerPresentation';
import { splitUserMessagePreview } from './userMessagePreview';

const textPresentation = (text: string): ComposerPresentation => ({
  version: 1,
  segments: [{ kind: 'text', text }],
});

describe('user message preview', () => {
  it('excludes long hidden lines from a short preview with a blank paragraph', () => {
    const text = 'A short introduction\n\nA short question\nA much longer explanation follows here.';
    const source = textPresentation(text);
    const { preview, overflow } = splitUserMessagePreview(source);

    expect(preview).toEqual(textPresentation('A short introduction\n\nA short question'));
    expect(overflow).toEqual(textPresentation('\nA much longer explanation follows here.'));
    expect(source).toEqual(textPresentation(text));
  });

  it.each(['\n', '\r\n', '\r'])('preserves %j line endings in the complete text', separator => {
    const text = ['One', 'Two', 'Three', 'Four'].join(separator);
    const { preview, overflow } = splitUserMessagePreview(textPresentation(text));
    expect(preview).toEqual(textPresentation(['One', 'Two', 'Three'].join(separator)));
    expect(overflow).toEqual(textPresentation(`${separator}Four`));
  });

  it.each(['Short message', 'One\nTwo\nThree', 'A long wrapping paragraph. '.repeat(200)])(
    'leaves up to three explicit lines to the existing visual clamp', text => {
      const source = textPresentation(text);
      expect(splitUserMessagePreview(source)).toEqual({ preview: source, overflow: null });
    },
  );

  it('counts line breaks across text segments without splitting reference capsules', () => {
    const skill = { kind: 'inline-token', token: '[$pdf]', tokenType: 'skill', label: 'pdf' } as const;
    const context = {
      kind: 'context',
      context: { id: 'file-1', type: 'file', filePath: '/project/input.txt', timestamp: 1 },
      tag: '@input.txt', label: 'input.txt', title: '/project/input.txt',
    } as const;
    const source: ComposerPresentation = {
      version: 1,
      segments: [
        { kind: 'text', text: 'Review\n' }, skill,
        { kind: 'text', text: '\nThen read\n' }, context,
      ],
    };
    const original = JSON.stringify(source);
    const { preview, overflow } = splitUserMessagePreview(source);
    expect(preview.segments).toEqual([
      { kind: 'text', text: 'Review\n' }, skill, { kind: 'text', text: '\nThen read' },
    ]);
    expect(overflow?.segments).toEqual([{ kind: 'text', text: '\n' }, context]);
    expect(JSON.stringify(source)).toBe(original);
  });

  it('treats a Windows line ending split across text segments as one break', () => {
    const source: ComposerPresentation = {
      version: 1,
      segments: ['One\r', '', '\nTwo\r', '\nThree\r', '\nFour'].map(text => ({ kind: 'text', text })),
    };
    const { preview, overflow } = splitUserMessagePreview(source);
    const text = (presentation: ComposerPresentation | null) => presentation?.segments.map(
      segment => segment.kind === 'text' ? segment.text : '',
    ).join('');
    expect(text(preview)).toBe('One\r\nTwo\r\nThree');
    expect(text(overflow)).toBe('\r\nFour');
  });

  it('keeps line breaks separated by a capsule distinct', () => {
    const skill = { kind: 'inline-token', token: '[$pdf]', tokenType: 'skill', label: 'pdf' } as const;
    const source: ComposerPresentation = {
      version: 1,
      segments: [{ kind: 'text', text: 'One\r' }, skill, { kind: 'text', text: '\nThree\nFour' }],
    };
    const { preview, overflow } = splitUserMessagePreview(source);
    expect(preview.segments).toEqual([
      { kind: 'text', text: 'One\r' }, skill, { kind: 'text', text: '\nThree' },
    ]);
    expect(overflow).toEqual(textPresentation('\nFour'));
  });
});
