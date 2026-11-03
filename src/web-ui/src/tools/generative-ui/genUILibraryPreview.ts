import catalog from '../../../../shared/generative-ui/catalog.json';
import type { GenUIAppDefinition } from './genUITypes';

export const genUILibraryProfiles: Record<string, { label: string; templates: string[]; designSpec: string }> = catalog.profiles;

/** Build the disposable preview as OpenUI source, using the same parser and
 * renderer as generated applications. The settings page must never exercise a
 * second JSON component-tree runtime. */
export function createGenUILibraryPreview(profileId: string, t: (key: string) => string): GenUIAppDefinition {
  if (!Object.prototype.hasOwnProperty.call(genUILibraryProfiles, profileId)) throw new Error('Unknown GenUI preview collection: ' + profileId);
  const profile = genUILibraryProfiles[profileId];
  const template = profile.templates[0];
  const libraryId = catalog.templates[template as keyof typeof catalog.templates].library;
  const library = catalog.libraries[libraryId as keyof typeof catalog.libraries];
  const libraryRevision = (catalog.libraryAdapters as Record<string, { revision: number }> | undefined)?.[libraryId]?.revision ?? library.metadata?.revision;
  if (!Number.isInteger(libraryRevision)) throw new Error('GenUI preview library has no pinned revision: ' + libraryId);
  const specification = (catalog.designSpecs as Record<string, { revision: number }>)[profile.designSpec];
  const quote = (value: string) => value.replace(/"/g, '\\"');
  const statements = [
    `title = Title("${quote(profile.label)}", "lg")`,
    `intro = Text("${quote(t('genui.preview.hint'))}", "sm")`,
    `facts = Row([Badge("${quote(t('genui.preview.live'))}"), Badge("${quote(t('genui.preview.progress'))}", "info")], 2)`,
  ];
  const children = ['title', 'intro', 'facts'];
  if ('Input' in library.components) {
    statements.push(`note = Input($previewNote, "${quote(t('genui.preview.note'))}", "text")`);
    statements.push(`noteValue = Text($previewNote, "sm")`);
    children.push('note', 'noteValue');
  }
  statements.unshift(`root = Col([${children.join(', ')}])`);
  return {
    schemaVersion: 2,
    id: 'library-preview-' + profileId,
    title: profile.label,
    template,
    libraryId,
    libraryRevision,
    designSpec: { id: profile.designSpec, revision: specification.revision },
    source: { kind: 'openui-lang', content: statements.join('\n') },
    state: { '$previewNote': { type: 'string', default: t('genui.preview.noteValue') } },
  } as GenUIAppDefinition;
}
