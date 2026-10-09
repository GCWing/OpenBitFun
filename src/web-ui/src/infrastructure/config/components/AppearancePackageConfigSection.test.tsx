// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearancePackageValidationError } from '@/infrastructure/appearance';
import {
  AppearancePackageConfigSection,
  AppearancePackageFailurePanel,
} from './AppearancePackageConfigSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getPreviewAssetMock = vi.hoisted(() => vi.fn());
const selectAppearanceMock = vi.hoisted(() => vi.fn());
const appearanceStateMock = vi.hoisted(() => ({
  selectedAppearanceId: 'sample.appearance',
}));

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
      {
        id: 'sample.appearance',
        name: 'Sample Appearance',
        version: '1.0.0',
        author: 'Studio',
        mode: 'dark',
        source: 'imported',
        importedAt: '2026-07-28T00:00:00.000Z',
      },
    ],
    selectedAppearanceId: appearanceStateMock.selectedAppearanceId,
    initialized: true,
    status: 'ready',
    getPreviewAsset: getPreviewAssetMock,
    importPackage: vi.fn(),
    exportPackage: vi.fn(),
    select: selectAppearanceMock,
    deletePackage: vi.fn(),
  }),
}));

describe('AppearancePackageConfigSection', () => {
  beforeEach(() => {
    getPreviewAssetMock.mockReset();
    getPreviewAssetMock.mockResolvedValue(null);
    selectAppearanceMock.mockReset();
    selectAppearanceMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    appearanceStateMock.selectedAppearanceId = 'sample.appearance';
  });

  it('renders the default package and installed skins as peer cards', () => {
    const html = renderToStaticMarkup(<AppearancePackageConfigSection />);
    expect(html).toContain('Sample Appearance');
    expect(html).toContain('package.nativeName');
    expect(html.match(/data-testid="appearance-package-card"/g)).toHaveLength(2);
    expect(html).toContain('data-appearance-id="system"');
    expect(html).toContain('data-appearance-id="sample.appearance"');
    expect(html).toContain('data-openbitfun-package-type="native"');
    expect(html).toContain('data-openbitfun-package-type="imported"');
    expect(html).toContain('data-testid="appearance-builtin-theme-select"');
    expect(html.match(/data-testid="appearance-builtin-theme-option"/g)).toHaveLength(3);
    expect(html.match(/class="appearance-package-config__selected-mark"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="package.export"');
    expect(html).toContain('aria-label="package.delete"');
    expect(html).toContain('data-openbitfun-part="packageSection"');
    expect(html).toContain('data-openbitfun-part="packageActions"');
    expect(html).toContain('data-openbitfun-component="icon-button"');
    expect(html).toContain('openbitfun-config-page-section');
    expect(html).not.toContain('appearance-package-config__action-button');
    expect(html).not.toContain('.openbitfun-skin');
  });

  it('hides the Skin market and appearance package import entry points', () => {
    const html = renderToStaticMarkup(<AppearancePackageConfigSection />);

    expect(html).not.toContain('package.market.open');
    expect(html).not.toContain('package.import');
    expect(html).not.toContain('accept=".openbitfun-appearance,.zip,application/zip"');
    expect(html).not.toContain('appearance-package-config__file-input');
    expect(html).toContain('aria-label="package.export"');
    expect(html).toContain('aria-label="package.delete"');
  });

  it('uses high-density artwork and a separate selection mark for the built-in package card', () => {
    appearanceStateMock.selectedAppearanceId = 'system';

    const html = renderToStaticMarkup(<AppearancePackageConfigSection />);

    expect(html).toContain('src="/assets/appearance/openbitfun-default-preview@4x.png"');
    expect(html).toContain('appearance-package-config__card-preview--builtin');
    expect(html).toContain('appearance-package-config__card-body--inline');
    expect(html.match(/class="appearance-package-config__selected-mark"/g)).toHaveLength(1);
    expect(html).toContain('package.nativeName');
    expect(html).toContain('package.nativeDescription');

    const imageSrc = html.match(/<img[^>]+src="([^"]+)"/)?.[1];
    expect(imageSrc).toBeDefined();
    const artwork = readFileSync(resolve(process.cwd(), 'public', imageSrc!.slice(1)));
    expect(artwork.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // Keep enough source pixels for the 240px card at high display scaling.
    expect(artwork.readUInt32BE(16)).toBeGreaterThanOrEqual(240 * 4);
    expect(artwork.readUInt32BE(20)).toBeGreaterThanOrEqual(120 * 4);
  });

  it('keeps cards borderless and the default package copy beside its theme selector', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'src', 'app', 'scenes', 'settings', 'pages', 'application', 'AppearanceSettingsPage.scss'),
      'utf8',
    );
    const galleryRule = styles.match(/&__gallery \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    const cardRule = styles.match(/&__card \{([\s\S]*?)\n  \}/)?.[1] ?? '';

    expect(galleryRule).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(cardRule).toContain('width: 100%;');
    expect(cardRule).not.toContain('border:');
    expect(styles).toMatch(/&__card-body--inline \{\s*flex-direction: row;/);
    expect(styles).toMatch(/&__builtin-theme-select \{[\s\S]*?flex: 0 0 var\(--openbitfun-overlay-menu-inline-size\);/);
  });

  it('reuses the built-in high-density artwork in the hover preview without requesting a package asset', async () => {
    appearanceStateMock.selectedAppearanceId = 'system';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<AppearancePackageConfigSection />);
      });

      const preview = container.querySelector<HTMLImageElement>('.appearance-package-config__card-preview img');
      await act(async () => {
        preview?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 220));
      });

      const largerPreview = document.querySelector<HTMLImageElement>(
        '[data-testid="appearance-package-preview-popover"] img',
      );
      expect(largerPreview?.getAttribute('src')).toBe('/assets/appearance/openbitfun-default-preview@4x.png');
      expect(getPreviewAssetMock).not.toHaveBeenCalledWith('system');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('renders stored preview assets and releases their object URLs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const createObjectURL = vi.fn(() => 'blob:appearance-preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    getPreviewAssetMock.mockResolvedValue({
      mimeType: 'image/webp',
      bytes: new Uint8Array([1, 2, 3]).buffer,
      width: 16,
      height: 9,
    });

    try {
      await act(async () => {
        root.render(<AppearancePackageConfigSection />);
        await Promise.resolve();
      });

      const preview = container.querySelector<HTMLImageElement>(
        '[data-appearance-id="sample.appearance"] .appearance-package-config__card-preview img',
      );
      expect(preview?.src).toBe('blob:appearance-preview');
      expect(preview?.alt).toBe('');
      expect(preview?.closest('article')?.getAttribute('aria-label')).toBe('Sample Appearance');
      expect(container.querySelectorAll('.appearance-package-config__selected-mark')).toHaveLength(1);
      expect(container.querySelector('.appearance-package-config__card-preview--builtin')).not.toBeNull();
      expect(createObjectURL).toHaveBeenCalledOnce();

      await act(async () => {
        preview?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 220));
      });

      const largerPreview = document.querySelector<HTMLImageElement>(
        '[data-testid="appearance-package-preview-popover"] img',
      );
      expect(largerPreview?.src).toBe('blob:appearance-preview');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:appearance-preview');
  });

  it('selects built-in themes inside the default card and installed skins from peer cards', async () => {
    appearanceStateMock.selectedAppearanceId = 'system';
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<AppearancePackageConfigSection />);
      });

      const builtinSelect = container.querySelector<HTMLSelectElement>(
        'select[data-testid="appearance-builtin-theme-select"]',
      );
      expect(builtinSelect).not.toBeNull();
      await act(async () => {
        if (builtinSelect) {
          builtinSelect.value = 'openbitfun-light';
          builtinSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await Promise.resolve();
      });
      expect(selectAppearanceMock).toHaveBeenCalledWith('openbitfun-light');

      const importedCard = container.querySelector<HTMLButtonElement>(
        '[data-appearance-id="sample.appearance"] .appearance-package-config__card-select',
      );
      await act(async () => {
        importedCard?.click();
        await Promise.resolve();
      });
      expect(importedCard?.closest('[data-openbitfun-component="action-card"]')).not.toBeNull();
      expect(selectAppearanceMock.mock.calls).toEqual([['openbitfun-light'], ['sample.appearance']]);
    } finally {
      act(() => root.unmount());
    }
  });

  it('renders validation failures as grouped component diagnostics', () => {
    const validationError = new AppearancePackageValidationError([
      {
        code: 'UNKNOWN_PART',
        path: 'components.toolbar-mode.parts.sessionMenu',
        message: 'Unknown part sessionMenu',
        context: {
          surfaceKind: 'component',
          surfaceId: 'toolbar-mode',
          partId: 'sessionMenu',
          allowedParts: ['root', 'header', 'content'],
        },
      },
      {
        code: 'UNKNOWN_PART',
        path: 'components.toolbar-mode.parts.input',
        message: 'Unknown part input',
        context: {
          surfaceKind: 'component',
          surfaceId: 'toolbar-mode',
          partId: 'input',
          allowedParts: ['root', 'header', 'content'],
        },
      },
    ]);
    const html = renderToStaticMarkup(
      <AppearancePackageFailurePanel
        failure={{ operation: 'import', validationError }}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain('package.diagnostics.validationTitle');
    expect(html).toContain('package.diagnostics.componentGroup');
    expect(html).toContain('components.toolbar-mode.parts.sessionMenu');
    expect(html).toContain('components.toolbar-mode.parts.input');
    expect(html).toContain('packageDiagnosticAllowedParts');
    expect(html).not.toContain('Invalid appearance package');
  });
});
