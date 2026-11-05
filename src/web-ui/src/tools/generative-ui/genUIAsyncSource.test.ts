import { describe, expect, it } from 'vitest';
import { requiresGenUIAsyncProvider } from './genUIAsyncSource';

describe('requiresGenUIAsyncProvider', () => {
  it.each(['Query("lookup", {})', 'Mutation("save", {})', 'SearchImage("Shanghai")', 'Image("https://example.com/photo.jpg", "photo")', 'Map([], true)'])('loads a provider for %s', content => {
    expect(requiresGenUIAsyncProvider({ source: { kind: 'openui-lang', content } })).toBe(true);
  });

  it('does not open a catalog for ordinary transient OpenUI documents', () => {
    expect(requiresGenUIAsyncProvider({ source: { kind: 'openui-lang', content: 'root = Col([Text("hello")])' } })).toBe(false);
    expect(requiresGenUIAsyncProvider({ source: { kind: 'html-document', content: '<p>hello</p>' } })).toBe(false);
    expect(requiresGenUIAsyncProvider()).toBe(false);
  });
});
