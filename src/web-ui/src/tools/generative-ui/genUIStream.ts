import { genUICatalog, safeKey, validateGenUISchema, type GenUICatalogContract } from './genUIContract';
import type { GenUIAppDefinition, GenUIAppEnvelope } from './genUITypes';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Project a streaming source envelope without executing partial source or
 * reviving the removed semantic graph. The source renderer owns final parse. */
export class GenUIStream {
  project(input: GenUIAppEnvelope, _product: GenUICatalogContract): GenUIAppDefinition {
    const raw = input as unknown as Record<string, unknown>;
    const template = typeof raw.template === 'string' ? raw.template : '';
    const source = record(raw.source);
    const state = Object.fromEntries(Object.entries(record(raw.state)).filter(([key, declaration]) => {
      const value = record(declaration);
      return safeKey(key) && validateGenUISchema(value, genUICatalog.$defs.state).length === 0;
    }));
    return {
      schemaVersion: 2,
      id: input.id,
      title: input.title,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      template,
      libraryId: typeof raw.libraryId === 'string' ? raw.libraryId : '',
      libraryRevision: typeof raw.libraryRevision === 'number' ? raw.libraryRevision : 0,
      ...(raw.designSpec && typeof raw.designSpec === 'object' ? { designSpec: raw.designSpec } : {}),
      source: source.kind === 'openui-lang' || source.kind === 'html-document' ? source as unknown as GenUIAppDefinition['source'] : undefined,
      state,
    } as GenUIAppDefinition;
  }
}
