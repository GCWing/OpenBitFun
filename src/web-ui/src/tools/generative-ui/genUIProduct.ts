import { genUICatalog, type GenUICatalogContract } from './genUIContract';
import { createGenUILibrary, type GenUIImplementations, type GenUILibrary } from './genUILibrary';
import './components/components.scss';
import { createGenUILibraryRegistry, type GenUILibraryAdapter } from './genUILibraryRegistry';
import { genUIAdapterImplementations } from './adapters';
export interface GenUIProduct {
  catalog: GenUICatalogContract;
  libraries: Record<string, GenUILibrary>;
  adapters: Record<string, GenUILibraryAdapter>;
}
/** Product assembly is the only place choosing component and function implementations. */
export function createGenUIProduct(catalog: GenUICatalogContract, implementations: Record<string, GenUIImplementations>): GenUIProduct {
  const libraries = Object.fromEntries(Object.entries(catalog.libraries).map(([id, contract]) => {
    if (!implementations[id])
      throw new Error('Missing product library: ' + id);
    return [id, createGenUILibrary(contract, implementations[id])];
  }));
  // Templates describe profile ownership only. Source documents are parsed by
  // OpenUI or the isolated HTML host; no semantic graph seed is assembled or
  // executed during product startup.
  const adapters = createGenUILibraryRegistry(catalog);
  for (const [id, library] of Object.entries(libraries)) adapters[id].implementations = library;
  return { catalog, libraries, adapters };
}
export const genUIProduct = createGenUIProduct(genUICatalog, Object.fromEntries(Object.entries(genUICatalog.libraryAdapters ?? {}).map(([id, metadata]) => {
  const implementation = genUIAdapterImplementations[metadata.adapterKind];
  if (!implementation) throw new Error('Missing GenUI adapter implementation: ' + metadata.adapterKind);
  return [id, implementation];
})));
