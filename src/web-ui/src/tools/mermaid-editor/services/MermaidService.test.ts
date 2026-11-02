// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { MermaidService } from './MermaidService';
vi.mock('../appearance/mermaidAppearance', () => ({ getMermaidConfig: () => ({}) }));
it.each([
  'block-beta\ncolumns 2\na["Start"] b["Finish"]',
  'flowchart TD\nA[Start] --> B[Finish]',
])('accepts supported syntax through the real Mermaid parser: %s', async code => {
  expect(await MermaidService.getInstance().validateMermaidCode(code)).toEqual({ valid: true });
});
it('rejects malformed static source with a parser diagnostic', async () => {
  const result = await MermaidService.getInstance().validateMermaidCode('block-be');
  expect(result.valid).toBe(false);
  expect(result.error).toBeTruthy();
});
