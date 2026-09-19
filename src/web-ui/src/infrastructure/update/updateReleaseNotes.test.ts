import { expect, it } from 'vitest';
import { getUpdateIntroduction } from './updateReleaseNotes';

it('uses the first prose paragraph without headings, badges, code blocks, or Markdown syntax', () => {
  const notes = [
    '# Version 2.0.0',
    '![Build status](https://example.com/badge.svg)',
    '```sh\ninstall package\n```',
    'A **smoother** workspace with [faster navigation](https://example.com) and `Ctrl+K` shortcuts.\nReady for everyday work.',
    '## Changes',
    '- Other improvements.',
  ].join('\n\n');
  expect(getUpdateIntroduction(notes)).toBe('A smoother workspace with faster navigation and Ctrl+K shortcuts. Ready for everyday work.');
});

it('uses the first readable list item when the release has no opening paragraph', () => {
  expect(getUpdateIntroduction('## Changes\n\n- ![Badge](https://example.com/badge.svg)\n- Faster **navigation**.\n- Smoother scrolling.')).toBe('Faster navigation.');
});

it('reads quoted prose and decodes entities without rendering raw HTML', () => {
  expect(getUpdateIntroduction('<script>untrusted()</script>\n\n> Faster files &amp; clearer tasks.')).toBe('Faster files & clearer tasks.');
});

it.each([null, undefined, '', '  ', '# Version 2.0.0\n\n![Badge](https://example.com/badge.svg)'])('does not invent an introduction when prose is absent: %s', notes => {
  expect(getUpdateIntroduction(notes)).toBe('');
});
