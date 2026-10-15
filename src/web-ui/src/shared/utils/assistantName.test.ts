import { describe, expect, it, vi } from 'vitest';
import { resolveAssistantName } from './assistantName';
vi.mock('@/infrastructure/i18n', () => ({ i18nService: { formatNumber: (n: number) => String(n) } }));
describe('assistant names', () => {
  it('localizes only host-proven defaults and preserves custom names', () => {
    expect(resolveAssistantName({ name: 'old', defaultNameNumber: 1 }, 'Assistant')).toBe('Assistant');
    expect(resolveAssistantName({ name: 'old', defaultNameNumber: 3 }, 'Assistant')).toBe('Assistant 3');
    expect(resolveAssistantName({ name: 'Claw abc' }, 'Assistant')).toBe('Claw abc');
    expect(resolveAssistantName({ name: 'fallback', defaultNameNumber: 2, identity: { name: 'Claw' } }, 'Assistant')).toBe('Claw');
    expect(resolveAssistantName({ name: 'My assistant', defaultNameNumber: null }, 'Assistant')).toBe('My assistant');
  });
});
