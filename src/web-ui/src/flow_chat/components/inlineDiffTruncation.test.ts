import { expect, it } from 'vitest';
import { truncateForDiff } from './inlineDiffTruncation';

it('bounds minified inputs while retaining both ends without claiming a false line count', () => {
  const text = `HEAD${'x'.repeat(100_000)}TAIL`;
  const preview = truncateForDiff(text, text);
  expect(preview.originalContent.startsWith('HEAD')).toBe(true);
  expect(preview.originalContent.endsWith('TAIL')).toBe(true);
  expect(preview.originalContent.length + preview.modifiedContent.length).toBeLessThanOrEqual(50_000);
  expect(preview.omittedLines).toBeNull();
});

it('preserves exact small sources and reports whole-line omissions accurately', () => {
  expect(truncateForDiff('a\n', 'b\n')).toMatchObject({ originalContent: 'a\n', modifiedContent: 'b\n', truncated: false });
  const text = Array.from({ length: 1000 }, (_, index) => String(index)).join('\n');
  expect(truncateForDiff(text, text)).toMatchObject({ truncated: true, omittedLines: 1500 });
});
