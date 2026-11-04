import { describe, expect, it } from 'vitest';
import { createGenUILibraryPreview } from './genUILibraryPreview';

describe('GenUI library previews', () => {
  it('shows Harmony pictograms only for the Harmony library', () => {
    const translate = (key: string) => key;
    const harmony = createGenUILibraryPreview('harmony', translate);
    const openbitfun = createGenUILibraryPreview('openbitfun', translate);

    expect(harmony.source).toMatchObject({ kind: 'openui-lang' });
    expect(harmony.source.kind === 'openui-lang' && harmony.source.content).toContain('Icon3D("☀️")');
    expect(openbitfun.source.kind === 'openui-lang' && openbitfun.source.content).not.toContain('Icon3D');
    expect(harmony.libraryRevision).toBe(3);
  });
});
