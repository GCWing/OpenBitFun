import type { ComposerPresentation, ComposerPresentationSegment } from '../../utils/composerPresentation';

/**
 * CSS clamps wrapped text to three visual lines, but still sizes it using every
 * hidden line. Separate everything after the third explicit line break so that
 * it can leave layout while preserving the complete rendered-text sequence.
 */
export function splitUserMessagePreview(presentation: ComposerPresentation): {
  preview: ComposerPresentation;
  overflow: ComposerPresentation | null;
} {
  const segments: ComposerPresentationSegment[] = [];
  let remainingBreaks = 3;
  let previousTextEndsWithCR = false;

  for (const [index, segment] of presentation.segments.entries()) {
    if (segment.kind === 'text') {
      for (const lineBreak of segment.text.matchAll(/\r\n|[\r\n]/g)) {
        // Persisted presentation segments need not coincide with line endings.
        // A CR followed by LF in the next text segment is still one break.
        if (previousTextEndsWithCR && lineBreak.index === 0 && lineBreak[0] === '\n') continue;
        if (--remainingBreaks === 0) {
          segments.push({ ...segment, text: segment.text.slice(0, lineBreak.index) });
          return {
            preview: { ...presentation, segments },
            overflow: {
              ...presentation,
              segments: [
                { ...segment, text: segment.text.slice(lineBreak.index) },
                ...presentation.segments.slice(index + 1),
              ],
            },
          };
        }
      }
      if (segment.text) previousTextEndsWithCR = segment.text.endsWith('\r');
    } else {
      previousTextEndsWithCR = false;
    }
    segments.push(segment);
  }

  return { preview: presentation, overflow: null };
}
