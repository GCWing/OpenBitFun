import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Keep prompt generation on the same implementation as Open Intelligent UI.
 * The product catalog still owns the renderer contract, so this adapter only
 * turns the catalog's positional signatures into lang-core's LibrarySpec.
 */
const requireOpenUI = createRequire(new URL('../../web-ui/package.json', import.meta.url));
const { generateSystemPrompt } = requireOpenUI('@openuidev/lang-core');
// The default profile is a faithful Open Intelligent UI port. Keep the
// upstream worked examples and wording as a checked-in resource instead of
// silently regenerating them from OpenBitFun's component catalog.
const upstreamOpenUISystemPrompt = readFileSync(new URL('./openui-system-prompt.txt', import.meta.url), 'utf8').trim();

/** Product declarations -> immutable libraries -> one generation/validation schema. */
export function extendLibrary(base, extension, id) {
  if (extension.removeActions || extension.actions) throw new Error('Library actions are retired; register OpenUI action bridge capabilities instead');
  const next = structuredClone(base);
  next.id = id;
  if (extension.metadata) next.metadata = structuredClone(extension.metadata);
  const removed = new Set(extension.removeComponents ?? []);
  for (const name of removed) {
    if (!Object.hasOwn(next.components, name)) throw new Error('Cannot remove unknown component: ' + name);
    delete next.components[name];
  }
  for (const [name, component] of Object.entries(extension.replaceComponents ?? {})) {
    if (!Object.hasOwn(next.components, name)) throw new Error('Cannot replace unknown component: ' + name);
    next.components[name] = structuredClone(component);
  }
  for (const [name, entry] of Object.entries(extension.addComponents ?? {})) {
    if (Object.hasOwn(next.components, name)) throw new Error('Component already exists: ' + name);
    next.components[name] = structuredClone(entry.component);
    for (const placement of entry.slots ?? []) {
      const [parent, slot] = placement.split('.');
      if (!next.components[parent]?.slots?.[slot]) throw new Error('Unknown placement: ' + placement);
      next.components[parent].slots[slot].push(name);
    }
  }
  for (const component of Object.values(next.components)) for (const [slot, children] of Object.entries(component.slots)) {
    component.slots[slot] = children.filter(name => !removed.has(name));
    for (const name of component.slots[slot]) if (!Object.hasOwn(next.components, name)) throw new Error('Unknown slot child: ' + name);
  }
  for (const name of extension.removeFunctions ?? []) delete next.functions[name];
  Object.assign(next.functions, structuredClone(extension.functions ?? {}));
  return next;
}
// Fail the product build on constraints the two validators cannot enforce.
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'allOf', 'const', 'enum', 'minLength', 'minItems', 'description', '$ref']);
function validateSchema(schema) {
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) throw new Error('Unsupported schema keyword: ' + key);
  if (schema.$ref && !['state', 'htmlDocument', 'openuiDocument'].some(name => schema.$ref === '#/$defs/' + name)) throw new Error('Unknown schema reference: ' + schema.$ref);
  for (const child of Object.values(schema.properties ?? {})) validateSchema(child);
  for (const child of schema.anyOf ?? []) validateSchema(child);
  for (const child of schema.allOf ?? []) validateSchema(child);
  if (schema.items) validateSchema(schema.items);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties);
}
function validateLibrary(library) {
  if (library.actions) throw new Error('Library actions are retired; register OpenUI action bridge capabilities instead');
  if (!library.metadata || !Number.isInteger(library.metadata.revision) || library.metadata.revision < 1 || typeof library.metadata.adapterKind !== 'string' || !Array.isArray(library.metadata.designSpecIds) || !Array.isArray(library.metadata.styleResources)) {
    throw new Error('Library requires versioned adapter metadata: ' + library.id);
  }
  for (const group of ['components', 'functions']) for (const name of Object.keys(library[group])) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Reserved library identity: ' + name);
  }
  for (const component of Object.values(library.components)) {
    validateSchema(component.props);
    for (const children of Object.values(component.slots)) for (const child of children) {
      if (!Object.hasOwn(library.components, child)) throw new Error('Unknown slot child: ' + child);
    }
    if (component.repeat && (!component.slots[component.repeat.slot] || !component.props.properties[component.repeat.items] || !component.props.properties[component.repeat.key])) throw new Error('Repeated slot requires declared slot and props');
  }
  for (const fn of Object.values(library.functions)) { fn.params.forEach(validateSchema); validateSchema(fn.returns); }
}
export function compileCatalog(source) {
  if (!source.htmlRuntime || Object.values(source.htmlRuntime).some(value => !Number.isInteger(value) || value < 1)) throw new Error('Catalog requires versioned HTML runtime capabilities');
  const libraries = Object.fromEntries(Object.entries(source.libraries ?? {}).map(([id, library]) => [id, { ...structuredClone(library), id }]));
  libraries[source.base.id] = structuredClone(source.base);
  for (const [id, extension] of Object.entries(source.extensions)) {
    const parent = extension.extends ? libraries[extension.extends] : source.base;
    if (!parent) throw new Error('Unknown or forward library parent: ' + extension.extends);
    libraries[id] = extendLibrary(parent, extension, id);
  }
  Object.values(libraries).forEach(validateLibrary);
  for (const template of Object.values(source.templates)) {
    const library = libraries[template.library];
    if (!library || !template.roots.length || template.roots.some(root => !Object.hasOwn(library.components, root))) throw new Error('Template requires an available library and root components');
  }

// OpenUI Lang is positional. Keep this prompt derived from the same product
// declarations that compile the runtime library so the model sees the exact
// signatures that GenUIOpenUI.tsx registers.
function openUISchemaType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(openUISchemaType).join(' | ');
  if (schema.type === 'array') return `${openUISchemaType(schema.items)}[]`;
  if (schema.type === 'object') {
    const properties = Object.entries(schema.properties ?? {}).map(([key, value]) => `${key}${(schema.required ?? []).includes(key) ? '' : '?'}: ${openUISchemaType(value)}`);
    return properties.length ? `{${properties.join(', ')}}` : 'object';
  }
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'string') return 'string';
  return 'any';
}

function openUIComponentSignature(name, component) {
  const args = [];
  // The React adapter inserts slot props first, then required catalog props,
  // the OpenUI action prop for eventful components, and optional props.
  for (const slot of Object.keys(component.slots ?? {})) {
    const optional = component.slotRequired?.[slot] === false ? '?' : '';
    args.push(`${slot}${optional}: ${(component.slots[slot] ?? []).join(' | ')}[]`);
  }
  const properties = component.props?.properties ?? {};
  const required = new Set(component.props?.required ?? []);
  for (const key of Object.keys(properties).filter(key => required.has(key))) args.push(`${key}: ${openUISchemaType(properties[key])}`);
  if (component.action) args.push('action?: ActionExpression');
  for (const key of Object.keys(properties).filter(key => !required.has(key))) args.push(`${key}?: ${openUISchemaType(properties[key])}`);
  return `${name}(${args.join(', ')})`;
}

function openUILibrarySpec(library) {
  return {
    id: library.id,
    root: library.metadata?.rootComponent ?? Object.keys(library.components)[0],
    components: Object.fromEntries(Object.entries(library.components).map(([name, component]) => [name, {
      signature: openUIComponentSignature(name, component),
      description: component.description,
    }])),
    functions: Object.fromEntries(Object.entries(library.functions ?? {}).map(([name, fn]) => [name, {
      signature: `@${name}(${(fn.params ?? []).map((param, index) => `${fn.paramNames?.[index] ?? `arg${index}`}${fn.optionalParams?.includes(index) ? '?' : ''}: ${openUISchemaType(param)}`).join(', ')}) → ${openUISchemaType(fn.returns)}`,
      description: fn.description,
    }])),
  };
}

function openUILibraryPrompt(library, promptOptions) {
  return generateSystemPrompt({
    library: openUILibrarySpec(library),
    promptOptions,
  });
}

const openuiLangReference = [
  'OpenUI Lang source.content is the raw declarative program, not JSON, JSX, TSX, markdown or a compiled artifact; do not include ``` fences in source.content.',
  'Use one statement per line: `identifier = Expression`. The first statement should be `root = Component(...)`; references may be forward-referenced but every non-root statement must be reachable from root.',
  'Arguments are positional, not named: use `Card([body], "Title")`, never `Card(children: [body], title: "Title")`. Child slots are arrays of statement references.',
  'Use `$name` for reactive state bindings and `@Function(...)` for listed pure functions. Event handlers use OpenUI built-ins such as `@ToAssistant(...)`, `@OpenUrl(...)` or `Action([...])`, subject to the host capability bridge. Use only the selected library signatures and the examples supplied below.',
].join(' ');
  const str = { type: 'string', minLength: 1 };
  const ref = name => ({ $ref: '#/$defs/' + name });
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const state = object({ type: { enum: ['string', 'number', 'boolean', 'array', 'object'] }, default: {} });
  const htmlDocument = object({ kind: { const: 'html-document' }, html: { type: 'string', minLength: 1 }, css: { type: 'string' }, script: { type: 'string' } }, ['kind', 'html']);
  const openuiDocument = object({ kind: { const: 'openui-lang' }, content: { type: 'string', minLength: 1 } }, ['kind', 'content']);
  const designSpecIdentity = object({ id: { enum: Object.keys(source.designSpecs ?? {}) }, revision: { type: 'integer' } }, ['id', 'revision']);
  const htmlRuntime = object({ runtimeRevision: { type: 'integer' }, sanitizerRevision: { type: 'integer' }, inspectorRevision: { type: 'integer' }, bridgeRevision: { type: 'integer' } });
  const libraryIds = Object.keys(libraries);
  const app = { type: 'object', properties: { schemaVersion: { const: 2 }, id: str, title: str, description: { type: 'string' }, template: { enum: Object.keys(source.templates) }, libraryId: { enum: libraryIds }, libraryRevision: { type: 'integer' }, designSpec: designSpecIdentity, htmlRuntime, source: { anyOf: [ref('openuiDocument'), ref('htmlDocument')] }, state: { type: 'object', additionalProperties: ref('state') } }, required: ['schemaVersion', 'id', 'title', 'template', 'libraryId', 'libraryRevision', 'designSpec', 'source', 'state'], additionalProperties: true };
  const propertyOrder = ['schemaVersion', 'id', 'title', 'description', 'template', 'libraryId', 'libraryRevision', 'designSpec', 'htmlRuntime', 'source', 'state'];
  app.properties = Object.fromEntries(propertyOrder.map(key => [key, app.properties[key]]));
  app.description = source.rules.join(' ') + ' Templates: ' + JSON.stringify(source.templates) + '. Libraries: ' + JSON.stringify(libraries);
  const message = { anyOf: [
    object({ createSurface: object({ id: str, title: str, description: { type: 'string' }, template: { enum: Object.keys(source.templates) }, libraryId: { enum: libraryIds }, libraryRevision: { type: 'integer' }, designSpec: designSpecIdentity, source: { anyOf: [ref('openuiDocument'), ref('htmlDocument')] } }, ['id', 'title', 'template', 'libraryId', 'libraryRevision', 'designSpec', 'source']) }),
    object({ updateDataModel: object({ state: app.properties.state, values: { type: 'object' } }, []) }),
  ] };
  const generation = object({ protocol: { const: 'openbitfun.genui.v1' }, messages: { type: 'array', minItems: 1, items: message } });
  const generationInstructions = 'Write protocol first, then messages. For a new component application, prefer createSurface.source.kind = openui-lang and stream the raw OpenUI Lang program in source.content as it is produced; keep stable statement IDs so completed statements can render before the enclosing transport object closes. Use only the selected library. For a free design request, use source.kind = html-document with HTML/CSS/SVG. The host renders both source kinds in the selected design specification and rejects TSX or per-app compilation. updateDataModel only provides initial state values and must not be required for the first render. ' + openuiLangReference;
  generation.description = generationInstructions + ' ' + app.description;
  const profiles = structuredClone(source.profiles ?? {});
  for (const profile of Object.values(profiles)) {
    if (!profile.templates?.length || profile.templates.length !== 1 || profile.templates.some(id => !source.templates[id])) throw new Error('Profile must bind exactly one available template');
    const designSpec = source.designSpecs?.[profile.designSpec];
    if (!designSpec || !Number.isInteger(designSpec.revision) || !designSpec.componentLibraries?.length || !designSpec.sourceKinds?.length || !designSpec.styleResources?.length || !designSpec.rules?.length || !designSpec.acceptance?.checks?.length || !['fixed', 'responsive'].includes(designSpec.viewport?.mode) || !designSpec.shell?.kind || !Array.isArray(designSpec.shell.hostOwnedParts) || !designSpec.shell.contentInsets) throw new Error('Profile requires a complete versioned design specification');
    for (const sourceKind of designSpec.sourceKinds) if (!['openui-lang', 'html-document'].includes(sourceKind)) throw new Error('Unsupported design-spec source kind: ' + sourceKind);
    for (const id of profile.templates) if (!designSpec.componentLibraries.includes(source.templates[id].library)) throw new Error('Design specification does not include template library: ' + id);
    for (const [key, inset] of Object.entries(designSpec.shell?.contentInsets ?? {})) if (!Number.isFinite(inset) || inset < 0) throw new Error('Invalid design specification content inset: ' + key);
    if (designSpec.viewport.mode === 'fixed' && (!Number.isInteger(designSpec.viewport.width) || !Number.isInteger(designSpec.viewport.height))) throw new Error('Fixed design viewport requires integer dimensions');
  }
  app.properties.designSpec = object({ id: { enum: Object.keys(source.designSpecs ?? {}) }, revision: { type: 'integer' } });
  app.properties.designSpec.required = ['id', 'revision'];
  app.description = app.description + ' Design specifications: ' + JSON.stringify(source.designSpecs) + '. Profiles: ' + JSON.stringify(profiles);
  generation.description += ' Design specifications: ' + JSON.stringify(source.designSpecs) + '. Profiles: ' + JSON.stringify(profiles);
  const promptOptions = { bindings: true, additionalRules: source.rules, examples: source.examples };
  const profilePromptOverrides = { openui: upstreamOpenUISystemPrompt, ...(source.profileSystemPrompts ?? {}) };
  const openuiPrompts = Object.fromEntries(Object.entries(libraries).map(([id, library]) => [id, id === 'openui.v1' ? (profilePromptOverrides.openui ?? openUILibraryPrompt(library, promptOptions)) : openUILibraryPrompt(library, promptOptions)]));
  const genuiSystemPrompts = Object.fromEntries(Object.entries(profiles).map(([profileId, profile]) => {
    const template = source.templates[profile.templates[0]];
    const library = libraries[template.library];
    const generated = openUILibraryPrompt(library, promptOptions);
    const override = profilePromptOverrides[profileId];
    return [profileId, override ?? generated];
  }));
  const libraryAdapters = Object.fromEntries(Object.entries(libraries).map(([id, library]) => [id, { ...structuredClone(library.metadata), id }]));
  return { contractVersion: 4, $defs: { state, htmlDocument, openuiDocument }, app, generation, generationInstructions, openuiLangReference, openuiPrompts, genuiSystemPrompts, libraries, libraryAdapters, templates: source.templates, legacyTemplateLibraries: source.legacyTemplateLibraries ?? {}, designSpecs: source.designSpecs ?? {}, profiles, rules: source.rules, htmlRuntime: source.htmlRuntime };
}
