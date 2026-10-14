import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSibling(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(filename, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('Nursery gallery presentation', () => {
  it('does not render decorative assistant artwork', () => {
    const source = readSibling('./NurseryGallery.tsx');

    expect(source).not.toContain('defaults-illustration.webp');
    expect(source).not.toContain('gallery-companion.webp');
    expect(source).not.toContain('nursery-defaults__artwork');
    expect(source).not.toContain('nursery-gallery__companion');
  });

  it('uses theme-aware surface and content tokens throughout the gallery', () => {
    const stylesheet = readSibling('./NurseryView.scss');
    const galleryStart = stylesheet.indexOf('.nursery-gallery {');
    const galleryEnd = stylesheet.indexOf('// ── Sub-page chrome', galleryStart);
    const gallerySection = stylesheet.slice(galleryStart, galleryEnd);

    expect(gallerySection).toMatch(
      /\.nursery-gallery \{\s+background: var\(--openbitfun-color-surface-scene\);/,
    );
    expect(readSibling('./AssistantCard.tsx')).toContain('appearance="subtle"');
    expect(gallerySection).toContain('background: var(--openbitfun-color-surface-tertiary);');
    expect(gallerySection).toContain('color: var(--openbitfun-color-content-primary);');
    expect(gallerySection).toContain('color: var(--openbitfun-color-content-muted);');
    expect(gallerySection).not.toContain('border-color: var(--openbitfun-color-border-subtle);');
    expect(gallerySection).not.toContain('--openbitfun-color-content-on-dark');
    expect(gallerySection).not.toContain('--openbitfun-color-content-on-light');
    expect(gallerySection).not.toContain('--openbitfun-color-overlay-scrim');
  });

  it('keeps assistant identity metadata close to its title', () => {
    const stylesheet = readSibling('./NurseryView.scss');
    const headerStart = stylesheet.indexOf('.acp-identity {');
    const headerEnd = stylesheet.indexOf('.acp-avatar-picker {', headerStart);
    const headerSection = stylesheet.slice(headerStart, headerEnd);

    expect(headerSection).toMatch(/&__info\s*\{[^}]*gap:\s*0;/s);
  });

  it('uses one borderless design-system surface with distinct actions', () => {
    const source = readSibling('./AssistantCard.tsx');
    const stylesheet = readSibling('./NurseryView.scss');
    const cardStart = stylesheet.indexOf('.assistant-card {');
    const cardEnd = stylesheet.indexOf('// ── Sub-page chrome', cardStart);
    const cardSection = stylesheet.slice(cardStart, cardEnd);

    expect(cardSection).toContain('&__main {');
    expect(cardSection).toContain('align-self: stretch;');
    expect(cardSection).not.toContain('min-height: 148px;');
    expect(cardSection).toContain('background: var(--openbitfun-color-action-neutral-surface-hover);');
    expect(cardSection).toContain('&__workspace-actions {');
    expect(cardSection).not.toContain('border-color: var(--openbitfun-color-border-subtle);');
    expect(cardSection).not.toContain('border-top: 1px solid var(--openbitfun-color-border-subtle);');
    expect(cardSection).not.toContain('min-height: clamp(310px, 23.8vw, 366px);');
    expect(cardSection).not.toContain('height: 100%;');
    expect(cardSection).not.toContain('--assistant-card-action-bg');
    expect(cardSection).not.toContain('&__new-session-btn {');
    expect(cardSection).not.toContain('&__set-primary-btn {');
    expect(cardSection).not.toContain('&__delete-btn {');
    expect(source).toMatch(/import \{[^}]*\bIconButton\b[^}]*} from '@openbitfun\/ui';/);
    expect(source).toContain('<CardHeader');
    expect(source).toContain('<CardFooter');
    expect(source).not.toContain('className="assistant-card__configure"');
    expect(source).toContain('className="assistant-card__workspace-actions"');
    expect(source).not.toContain('className="assistant-card__body"');
  });
});
