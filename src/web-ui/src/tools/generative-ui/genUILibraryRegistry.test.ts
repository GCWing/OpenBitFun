import { describe, expect, it } from 'vitest';
import { genUICatalog } from './genUIContract';
import { genUIProduct } from './genUIProduct';
import { getGenUILibraryAdapter, listGenUILibraryAdapters, resolveGenUILibraryForApp } from './genUILibraryRegistry';

describe('GenUI library registry', () => {
  it('registers the OpenUI and explicit Harmony adapters', () => {
    const adapters = listGenUILibraryAdapters(genUICatalog).filter(adapter => !adapter.readonly);
    expect(adapters.map(adapter => adapter.adapterKind).sort()).toEqual(['bitfun', 'harmony-genui', 'openui']);
    expect(adapters.every(adapter => adapter.revision >= 1 && adapter.designSpecIds.length > 0 && adapter.styleResources.length > 0)).toBe(true);
  });

  it('resolves only the application pinned identity and revision', () => {
    const app = { libraryId: 'openbitfun.composable.v1', libraryRevision: 2 } as const;
    expect(resolveGenUILibraryForApp(app, genUICatalog)?.adapterKind).toBe('bitfun');
    expect(getGenUILibraryAdapter(app.libraryId, 3, genUICatalog)).toBeUndefined();
  });

  it('keeps renderer provenance inside each adapter contract', () => {
    expect(genUIProduct.libraries['openui.v1'].nativeLibrary).toBeDefined();
    expect(genUIProduct.libraries['openui.v1'].components).toEqual({});
    expect(genUIProduct.libraries['openbitfun.composable.v1'].rendererSources.Button).toMatchObject({ kind: 'bitfun-host', source: '@openbitfun/ui component adapter' });
    expect(genUIProduct.libraries['openbitfun.harmony.v1'].rendererSources.Button).toMatchObject({ kind: 'openui-react', source: 'open-intelligent-ui component contract adapter' });
    expect(genUIProduct.libraries['openbitfun.harmony.v1'].rendererSources.Steps).toMatchObject({ kind: 'openui-react', source: 'task_genui/openui/packages/react-ui/src/components/Steps' });
  });

  it('keeps the three profile identities separate', () => {
    expect(genUICatalog.profiles).toMatchObject({
      openui: { templates: ['openui.app'], designSpec: 'openui.desktop.v1' },
      openbitfun: { templates: ['openbitfun.app'], designSpec: 'openbitfun.desktop.v1' },
      harmony: { templates: ['openbitfun.harmony.app'], designSpec: 'harmony.phone.v1' },
    });
    expect(resolveGenUILibraryForApp({ libraryId: 'openui.v1', libraryRevision: 1 }, genUICatalog)?.adapterKind).toBe('openui');
    expect(resolveGenUILibraryForApp({ libraryId: 'openbitfun.harmony.v1', libraryRevision: 2 }, genUICatalog)?.adapterKind).toBe('harmony-genui');
  });
});
