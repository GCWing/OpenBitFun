import { genUICatalog, preflightGenUIApp, validateGenUISchema, type GenUICatalogContract } from './genUIContract';
import type { GenUIAppDefinition, GenUIAppState } from './genUITypes';

export const GENUI_PROTOCOL = 'openbitfun.genui.v1';
export interface GenUIGeneration { protocol: typeof GENUI_PROTOCOL; messages: Record<string, unknown>[] }
export interface GenUIDocument { app: GenUIAppDefinition; state: GenUIAppState }

/** Reduce only the source protocol. Graph messages are rejected before they
 * can reach a renderer, stream preview, or persistence boundary. */
export function reduceGenUIMessages(input: GenUIGeneration, product: GenUICatalogContract = genUICatalog, streaming = false): GenUIDocument {
  if (input.messages.some(message => message.updateComponents || message.updateLogic)) throw new Error('GenUI graph messages were removed; send a complete source document');
  const schema = product.generation ?? genUICatalog.generation;
  const issues = streaming ? [] : validateGenUISchema(input, schema, 'generation');
  if (issues.length) throw new Error(issues.map(issue => issue.path + ': ' + issue.message).join('; '));
  const messages = input.messages;
  const first = messages[0];
  if (!first?.createSurface) throw new Error('messages[0]: createSurface is required and must be first');
  if (messages.some(message => message.updateComponents || message.updateLogic)) throw new Error('GenUI graph messages were removed; send a complete source document');
  const surface = first.createSurface as Record<string, unknown>;
  if (!surface.source || typeof surface.source !== 'object') throw new Error('messages[0].createSurface.source is required');
  if (!product.templates[String(surface.template)]) throw new Error('messages[0]: unknown template');
  const app = { schemaVersion: 2, state: {}, ...structuredClone(surface) } as GenUIAppDefinition;
  const appIssues = preflightGenUIApp(app, false, product).issues;
  if (appIssues.length) throw new Error(appIssues.map(issue => issue.path + ': ' + issue.message).join('; '));
  const state: GenUIAppState = {};
  for (const [index, message] of messages.slice(1).entries()) {
    if (!message.updateDataModel) {
      if (streaming) break;
      throw new Error(`messages[${index + 1}]: only updateDataModel is supported after createSurface`);
    }
    const update = message.updateDataModel as { state?: GenUIAppDefinition['state']; values?: GenUIAppState };
    app.state = { ...app.state, ...structuredClone(update.state ?? {}) };
    Object.assign(state, structuredClone(update.values ?? {}));
  }
  return { app, state };
}

export function describeGenUIApp(app: GenUIAppDefinition, values?: GenUIAppState): GenUIGeneration {
  if (!app.source) throw new Error('GenUI source is required; semantic graph documents were removed');
  return { protocol: GENUI_PROTOCOL, messages: [
    { createSurface: { id: app.id, title: app.title, template: app.template, libraryId: app.libraryId, libraryRevision: app.libraryRevision, ...(app.description === undefined ? {} : { description: app.description }), ...(app.designSpec === undefined ? {} : { designSpec: app.designSpec }), source: app.source } },
    { updateDataModel: { state: app.state, ...(values ? { values } : {}) } },
  ] };
}
