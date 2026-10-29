// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearancePackageConfigSection } from './AppearancePackageConfigSection';

const selectAppearanceMock = vi.hoisted(() => vi.fn());
const appearanceStateMock = vi.hoisted(() => ({ selectedAppearanceId: 'system' }));

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/infrastructure/appearance', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/appearance')>(),
  SYSTEM_APPEARANCE_ID: 'system',
  useAppearance: () => ({
    appearances: [
      {
        id: 'openbitfun-dark',
        name: 'Dark',
        description: 'Default dark appearance',
        version: '1.0.0',
        mode: 'dark',
        source: 'builtin',
      },
      {
        id: 'openbitfun-light',
        name: 'Light',
        description: 'Default light appearance',
        version: '1.0.0',
        mode: 'light',
        source: 'builtin',
      },
    ],
    selectedAppearanceId: appearanceStateMock.selectedAppearanceId,
    initialized: true,
    status: 'ready',
    select: selectAppearanceMock,
  }),
}));

describe('AppearancePackageConfigSection', () => {
  beforeEach(() => {
    appearanceStateMock.selectedAppearanceId = 'system';
    selectAppearanceMock.mockReset();
  });

  it('renders only the built-in appearance selector', () => {
    const html = renderToStaticMarkup(<AppearancePackageConfigSection />);

    expect(html).toContain('theme.nativeName');
    expect(html).toContain('data-testid="appearance-builtin-theme-select"');
    expect(html.match(/data-testid="appearance-builtin-theme-option"/g)).toHaveLength(3);
    expect(html).toContain('data-openbitfun-package-type="native"');
    expect(html).not.toContain('theme.market');
    expect(html).not.toContain('theme.import');
    expect(html).not.toContain('openbitfun-appearance');
    expect(html).not.toContain('theme.export');
    expect(html).not.toContain('theme.delete');
  });

  it('falls back to the system option when a persisted package selection is unavailable', () => {
    appearanceStateMock.selectedAppearanceId = 'removed.appearance';
    const html = renderToStaticMarkup(<AppearancePackageConfigSection />);
    expect(html).toContain('data-testid="appearance-builtin-theme-select"');
  });
});
