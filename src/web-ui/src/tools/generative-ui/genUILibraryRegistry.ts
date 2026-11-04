import type { GenUICatalogContract, GenUILibraryContract } from './genUIContract';
import type { GenUIAppDefinition } from './genUITypes';
import type { GenUIImplementations } from './genUILibrary';

/** A registered GenUI adapter is the unit of schema, rendering and inspection. */
export interface GenUILibraryAdapter {
  id: string;
  revision: number;
  label: string;
  adapterKind: 'openui' | 'openbitfun' | 'harmony-genui' | string;
  readonly: boolean;
  contract: GenUILibraryContract;
  designSpecIds: string[];
  styleResources: string[];
  /** Bound renderer/function/action bridge for this exact contract revision. */
  implementations?: GenUIImplementations;
}

export function createGenUILibraryRegistry(catalog: GenUICatalogContract): Record<string, GenUILibraryAdapter> {
  return Object.fromEntries(Object.entries(catalog.libraries).map(([id, contract]) => {
    const metadata = catalog.libraryAdapters?.[id] ?? contract.metadata;
    if (!metadata) throw new Error('Missing adapter metadata for ' + id);
    return [id, { id, contract, revision: metadata.revision, label: metadata.label, adapterKind: metadata.adapterKind, readonly: Boolean(metadata.readonly), designSpecIds: metadata.designSpecIds, styleResources: metadata.styleResources }];
  }));
}

export function listGenUILibraryAdapters(catalog: GenUICatalogContract): GenUILibraryAdapter[] {
  return Object.values(createGenUILibraryRegistry(catalog));
}

export function getGenUILibraryAdapter(id: string, revision: number | undefined, catalog: GenUICatalogContract): GenUILibraryAdapter | undefined {
  const adapter = createGenUILibraryRegistry(catalog)[id];
  return adapter && (revision === undefined || adapter.revision === revision) ? adapter : undefined;
}

/** Resolve only the identity pinned in the app. Global settings never enter this path. */
export function resolveGenUILibraryForApp(app: Pick<GenUIAppDefinition, 'libraryId' | 'libraryRevision'>, catalog: GenUICatalogContract): GenUILibraryAdapter | undefined {
  return getGenUILibraryAdapter(app.libraryId, app.libraryRevision, catalog);
}
