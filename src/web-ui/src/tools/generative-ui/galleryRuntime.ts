import type { GenUIAppDefinition } from './genUITypes';
import { genUICatalog, libraryFor } from './genUIContract';
import { demoTools } from '../../../../shared/generative-ui/gallery/demo-data';
import type { GenUIGalleryProgram } from '../../../../shared/generative-ui/gallery';

const galleryTemplate = 'openbitfun.app';

/** Turn a hand-written OpenUI Lang fixture into the same app envelope used by model output. */
export function galleryProgramToApp(program: GenUIGalleryProgram): GenUIAppDefinition {
  const template = genUICatalog.templates[galleryTemplate];
  if (!template) throw new Error(`GenUI gallery template is unavailable: ${galleryTemplate}`);
  const library = genUICatalog.libraries[template.library];
  const libraryRevision = library?.metadata?.revision;
  if (!library || typeof libraryRevision !== 'number' || !Number.isInteger(libraryRevision)) throw new Error(`GenUI gallery library is unavailable: ${template.library}`);
  const designSpecId = library.metadata?.designSpecIds[0];
  if (!designSpecId) throw new Error(`GenUI gallery library has no design specification: ${template.library}`);
  const designSpec = designSpecId ? genUICatalog.designSpecs?.[designSpecId] : undefined;
  if (!designSpec) throw new Error(`GenUI gallery design specification is unavailable for ${template.library}`);
  return {
    schemaVersion: 2,
    id: `gallery-${program.id}`,
    title: program.title,
    description: program.note,
    template: galleryTemplate,
    libraryId: template.library,
    libraryRevision,
    designSpec: { id: designSpecId, revision: designSpec.revision },
    source: { kind: 'openui-lang', content: program.code },
    state: {},
  };
}

/** Plain function map accepted by the existing GenUI async boundary. */
export const galleryToolProvider = demoTools;

export function galleryProgramLibrary(program: GenUIGalleryProgram) {
  return libraryFor(galleryProgramToApp(program), genUICatalog);
}
