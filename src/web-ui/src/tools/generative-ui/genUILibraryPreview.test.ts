import { describe, expect, it } from 'vitest';
import { createGenUILibraryPreview } from './genUILibraryPreview';

describe('GenUI library previews', () => {
  it('creates a preview from the selected library profile', () => {
    const preview = createGenUILibraryPreview('openbitfun', key => key);
    expect(preview.source).toMatchObject({ kind: 'openui-lang' });
    expect(preview.libraryId).toBe('openbitfun.composable.v1');
    expect(preview.source.kind === 'openui-lang' && preview.source.content).toContain('root = Col(');
  });
});
