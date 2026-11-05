import catalog from '../../../../shared/generative-ui/catalog.json';
import type { GenUIAppDefinition } from './genUITypes';
export const genUICatalog = catalog as unknown as GenUICatalogContract & { $defs: Record<string, JsonSchema>; generation: JsonSchema };
export type JsonSchema = {
  [key: string]: unknown;
};
const schemaValueKey = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export interface GenUIContractIssue {
  path: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}
/** The deliberately small schema vocabulary used by the product catalog. */
export function validateGenUISchema(value: unknown, schema: JsonSchema, path = 'app'): GenUIContractIssue[] {
  const issue = (message: string): GenUIContractIssue[] => [{ path, code: 'schema', severity: 'error', message }];
  if (typeof schema.$ref === 'string') {
    const key = schema.$ref.replace('#/$defs/', '');
    const target = schema.$ref.startsWith('#/$defs/') && Object.prototype.hasOwnProperty.call(catalog.$defs, key) ? (catalog.$defs as Record<string, JsonSchema>)[key] : undefined;
    return target ? validateGenUISchema(value, target, path) : issue(`Unknown schema reference ${schema.$ref}`);
  }
  if (Array.isArray(schema.allOf)) {
    const { allOf, ...rest } = schema;
    return [rest, ...allOf].flatMap(branch => validateGenUISchema(value, branch as JsonSchema, path));
  }
  if (Array.isArray(schema.anyOf)) {
    const { anyOf: _branches, ...rest } = schema;
    const outer = validateGenUISchema(value, rest, path);
    if (outer.length) return outer;
    const branches = schema.anyOf as JsonSchema[];
    // Discriminators retain the useful field path instead of a generic union error.
    const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const resolvedBranches = branches.map(branch => ({
      branch, schema: typeof branch.$ref === 'string'
        ? (catalog.$defs as Record<string, JsonSchema>)[branch.$ref.replace('#/$defs/', '')] : branch
    }));
    const discriminator = ['kind', 'component', 'type', 'template'].find(key => candidate[key] !== undefined && resolvedBranches.some(({ schema }) => Object.prototype.hasOwnProperty.call((schema?.properties as Record<string, JsonSchema> | undefined)?.[key] ?? {}, 'const')));
    const selected = resolvedBranches.find(({ schema }) => discriminator &&
      (schema?.properties as Record<string, JsonSchema> | undefined)?.[discriminator]?.const === candidate[discriminator])?.branch;
    if (selected)
      return validateGenUISchema(value, selected, path);
    // Single-key operation envelopes discriminate by their required field.
    // Keep the actual nested error instead of losing it at the union boundary.
    const keys = Object.keys(candidate);
    const envelope = keys.length === 1 ? resolvedBranches.filter(({ schema }) =>
      (schema?.required as string[] | undefined)?.includes(keys[0])
      && Object.keys((schema?.properties ?? {}) as object).length === 1) : [];
    if (envelope.length === 1) return validateGenUISchema(value, envelope[0].branch, path);
    const results = branches.map(branch => validateGenUISchema(value, branch, path));
    if (results.some(result => result.length === 0)) return [];
    const kinds = resolvedBranches.map(({ schema }) => (schema?.properties as Record<string, JsonSchema> | undefined)?.kind?.const).filter(Boolean);
    return issue(kinds.length ? 'Value does not match the selected source contract' : 'Value does not match a supported shape');
  }
  const type = schema.type;
  if (type && !(type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type))
    return issue(`Expected ${type}`);
  if ('const' in schema && schemaValueKey(value) !== schemaValueKey(schema.const))
    return issue(`Expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return issue(`Expected one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.trim().length < schema.minLength)
    return issue('Text must not be empty');
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      return issue(`Expected at least ${schema.minItems} item(s)`);
    return schema.items ? value.flatMap((item, index) => validateGenUISchema(item, schema.items as JsonSchema, `${path}[${index}]`)) : [];
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const issues: GenUIContractIssue[] = (schema.required as string[] | undefined ?? []).filter(key => !Object.prototype.hasOwnProperty.call(object, key)).map(key => ({ path: `${path}.${key}`, code: 'schema', severity: 'error' as const, message: 'Required field is missing' }));
    for (const [key, entry] of Object.entries(object)) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        issues.push(...validateGenUISchema(entry, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false)
        issues.push({ path: `${path}.${key}`, code: 'schema', severity: 'error', message: 'Unsupported property; use the advertised component schema' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        issues.push(...validateGenUISchema(entry, schema.additionalProperties as JsonSchema, `${path}.${key}`));
    }
    return issues;
  }
  return [];
}
export interface GenUIComponentContract {
  description: string;
  props: JsonSchema;
  slots: Record<string, string[]>;
  /** OpenUI Lang positional slot optionality, kept separate from the child allow-list. */
  slotRequired?: Record<string, boolean>;
  /** Props that are reactive state bindings (for example checked or seconds). */
  bindings?: string[];
  /** Components such as Button accept an OpenUI ActionExpression. */
  action?: boolean;
  events?: string[];
  repeat?: {
    slot: string;
    items: string;
    key: string;
  };
}
export interface GenUILibraryContract {
  id: string;
  metadata?: {
    revision: number;
    label: string;
    adapterKind: string;
    designSpecIds: string[];
    styleResources: string[];
    rootComponent?: string;
    readonly?: boolean;
  };
  components: Record<string, GenUIComponentContract>;
  functions: Record<string, {
    description: string;
    params: JsonSchema[];
    optionalParams?: number[];
    returns: JsonSchema;
  }>;
  examples: string[];
}
export interface GenUICatalogContract {
  generation?: JsonSchema;
  /** Generated from the same product declarations as the OpenUI adapter. */
  openuiLangReference?: string;
  openuiPrompts?: Record<string, string>;
  /** Official lang-core prompts selected by the active GenUI profile. */
  genuiSystemPrompts?: Record<string, string>;
  libraries: Record<string, GenUILibraryContract>;
  libraryAdapters?: Record<string, {
    id: string;
    revision: number;
    label: string;
    adapterKind: string;
    designSpecIds: string[];
    styleResources: string[];
    rootComponent?: string;
    readonly?: boolean;
  }>;
  designSpecs?: Record<string, GenUIDesignSpec>;
  profiles?: Record<string, { label: string; templates: string[]; designSpec: string }>;
  /** Historical template/library pairs retained for existing saved apps. */
  legacyTemplateLibraries?: Record<string, string[]>;
  htmlRuntime: GenUIHtmlRuntime;
  templates: Record<string, {
    library: string;
    description: string;
    roots: string[];
  }>;
  app: JsonSchema;
}
export interface GenUIHtmlRuntime {
  runtimeRevision: number;
  sanitizerRevision: number;
  inspectorRevision: number;
  bridgeRevision: number;
}
export interface GenUIDesignSpec {
  revision: number;
  label: string;
  componentLibraries: string[];
  sourceKinds: string[];
  styleResources: string[];
  rules: string[];
  viewport: { mode: 'responsive' | 'fixed'; width?: number; height?: number; unit: 'css-px' };
  shell: { kind: string; statusBarHeight?: number; hostOwnedParts: string[]; forbiddenContentSelectors?: string[]; contentInsets: { top: number; right: number; bottom: number; left: number } };
  acceptance: { checks: string[] };
}
export function designSpecForApp(app: Pick<GenUIAppDefinition, 'libraryId' | 'libraryRevision'> & Partial<Pick<GenUIAppDefinition, 'designSpec'>>, product: GenUICatalogContract = genUICatalog): GenUIDesignSpec | undefined {
  const adapter = product.libraryAdapters?.[app.libraryId] ?? product.libraries[app.libraryId]?.metadata;
  if (!app.designSpec) return undefined;
  const id = app.designSpec.id;
  const spec = id ? product.designSpecs?.[id] : undefined;
  return spec && app.designSpec.revision === spec.revision && (!adapter || adapter.revision === app.libraryRevision) ? spec : undefined;
}
export function libraryFor(app: GenUIAppDefinition, product: GenUICatalogContract = genUICatalog): GenUILibraryContract | undefined {
  const library = (product.libraries as Record<string, GenUILibraryContract | undefined>)[app.libraryId];
  const adapter = product.libraryAdapters?.[app.libraryId] ?? library?.metadata;
  return library && adapter && adapter.revision === app.libraryRevision ? library : undefined;
}
function templateAcceptsLibrary(template: string, libraryId: string, product: GenUICatalogContract): boolean {
  return product.templates[template]?.library === libraryId
    || product.legacyTemplateLibraries?.[template]?.includes(libraryId) === true;
}
export const safeKey = (key: string) => !['__proto__', 'constructor', 'prototype'].includes(key);
export function preflightGenUIApp(input: unknown, _streaming = false, product: GenUICatalogContract = genUICatalog): {
  accepted: boolean;
  issues: GenUIContractIssue[];
} {
  const issues = validateGenUISchema(input, product.app);
  const finish = () => ({ accepted: !issues.some(issue => issue.severity === 'error'), issues });
  if (issues.length)
    return finish();
  const app = input as GenUIAppDefinition;
  for (const field of ['nodes', 'flows', 'derived', 'checks']) {
    if (Object.prototype.hasOwnProperty.call(app, field)) {
      issues.push({ path: `app.${field}`, code: 'retired-graph', severity: 'error', message: 'Retired graph fields are unsupported; original data is retained' });
    }
  }
  const library = libraryFor(app, product);
  if (!library) {
    issues.push({ path: 'app.libraryId', code: 'library-identity', severity: 'error', message: `Component library ${app.libraryId}@${app.libraryRevision} is unavailable` });
    return finish();
  }
  const template = product.templates[app.template];
  if (!template || !templateAcceptsLibrary(app.template, app.libraryId, product)) {
    issues.push({ path: 'app.template', code: 'template-library', severity: 'error', message: `Template ${app.template} does not belong to component library ${app.libraryId}` });
  }
  if (app.designSpec) {
    const specification = product.designSpecs?.[app.designSpec.id];
    if (!specification || specification.revision !== app.designSpec.revision)
      issues.push({ path: 'app.designSpec', code: 'design-spec', severity: 'error', message: `UI specification ${app.designSpec.id}@${app.designSpec.revision} is unavailable` });
    else if (!specification.componentLibraries.includes(library.id))
      issues.push({ path: 'app.designSpec', code: 'design-spec-library', severity: 'error', message: `UI specification ${app.designSpec.id} does not allow component library ${library.id}` });
  }
  const specification = designSpecForApp(app, product);
  if (!specification)
    issues.push({ path: 'app.designSpec', code: 'design-spec', severity: 'error', message: `No design specification is registered for ${app.libraryId}@${app.libraryRevision}` });
  for (const [key, declaration] of Object.entries(app.state))
    issues.push(...validateGenUISchema(declaration.default, { type: declaration.type }, 'app.state.' + key + '.default'));
  if (app.source?.kind === 'html-document' || app.source?.kind === 'openui-lang') {
    if (app.source.kind === 'html-document' && app.htmlRuntime && schemaValueKey(app.htmlRuntime) !== schemaValueKey(product.htmlRuntime))
      issues.push({ path: 'app.htmlRuntime', code: 'html-runtime', severity: 'error', message: 'HTML runtime identity is unavailable on this host' });
    if (!specification?.sourceKinds.includes(app.source.kind))
      issues.push({ path: 'app.source', code: 'design-spec-source', severity: 'error', message: `The selected UI specification does not allow ${app.source.kind} documents` });
    return finish();
  }
  if (!app.source) {
    issues.push({ path: 'app.source', code: 'source-required', severity: 'error', message: 'A complete OpenUI or HTML source document is required' });
    return finish();
  }
  return finish();
}
