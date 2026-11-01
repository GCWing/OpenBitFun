import { afterEach, expect, it, vi } from 'vitest';
import { createSuggestedAgentId } from './suggestAgentId';
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, {}])('generates valid fallback IDs without randomUUID (%s)', crypto => {
  vi.stubGlobal('crypto', crypto);
  const id = createSuggestedAgentId();
  expect(id).toMatch(/^agent-[a-z0-9]+-[a-z0-9]*$/);
});
