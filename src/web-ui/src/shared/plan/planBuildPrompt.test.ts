import { describe, expect, it, vi } from 'vitest';

const preference = vi.hoisted(() => ({ locale: 'zh-CN' }));
vi.mock('@/infrastructure/i18n', async () => {
  const { getLocaleMetadata } = await import('@/infrastructure/i18n/presets');
  return {
    i18nService: {
      getCurrentLocale: () => preference.locale,
      getCurrentLocaleMetadata: () => getLocaleMetadata(preference.locale),
    },
  };
});

import { planBuildPrompt } from './planBuildPrompt';

describe('plan build language preference', () => {
  it('reads the current selection on each build and keeps the instructions in English', () => {
    for (const [locale, name] of [
      ['zh-CN', 'Simplified Chinese'],
      ['zh-TW', 'Traditional Chinese'],
      ['en-US', 'English (US)'],
    ]) {
      preference.locale = locale;
      const prompt = planBuildPrompt('/workspace/example.plan.md');
      expect(prompt).toContain('Implement the plan at `/workspace/example.plan.md`.');
      expect(prompt).toContain(`Language Preference: Use ${name} (${locale})`);
      expect(prompt).toContain('including progress updates and the final response');
      expect(prompt).toContain('unless the user explicitly requests another language');
      expect(prompt).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});
