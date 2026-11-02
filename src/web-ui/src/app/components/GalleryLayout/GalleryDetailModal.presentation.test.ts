import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

describe('GalleryDetailModal presentation contract', () => {
  it('supports an accessible hero title without changing the default gallery layout', () => {
    const source = readSource('./GalleryDetailModal.tsx');
    const appearance = readSource('./GalleryDetailModal.appearance.ts');

    expect(source).toContain("titlePlacement = 'header'");
    expect(source).toContain('aria-labelledby={usesHeroTitle ? heroTitleId : undefined}');
    expect(source).toContain('<DialogTitle data-testid={titleTestId}>{title}</DialogTitle>');
    expect(source).toContain('data-openbitfun-part="title"');
    expect(appearance).toContain("{ id: 'title' }");
  });

  it('keeps optional stable sizing owned by the gallery dialog', () => {
    const source = readSource('./GalleryDetailModal.tsx');
    const styles = readSource('./GalleryDetailModal.scss');

    expect(source).toContain("size = 'md'");
    expect(source).toContain('size={size}');
    expect(styles).toContain('container-name: gallery-detail-modal;');
    expect(styles).not.toContain('width: min(900px, 100%);');
    expect(styles).toContain('height: min(540px, calc(100vh - 48px));');
    expect(styles).toContain('overflow-y: auto;');
    expect(styles).toContain('overscroll-behavior: contain;');
    expect(styles).toContain('@container gallery-detail-modal (max-width: 360px)');
    expect(styles).not.toContain('@media (max-width: 720px)');
  });
});
