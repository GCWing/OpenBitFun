import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { collectForwardedTabProps, collectForwardedOverlayProps, collectForwardedFlowGroupParts, findDomAttribute, flowChatAppearanceSources, collectFlowChatAppearanceHostTags } from './appearance-dom-contracts.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(repoRoot, 'src', 'web-ui', 'src');
const sceneRoot = path.join(sourceRoot, 'app', 'scenes');
const registryFile = path.join(sourceRoot, 'infrastructure', 'appearance', 'registry', 'defaultAppearanceRegistry.ts');
const retiredOwnershipFile = path.join(sourceRoot, 'infrastructure', 'appearance', 'registry', 'appearanceSourceOwnership.ts');
const externalAppearanceContractFiles = [
  path.join(repoRoot, 'design-system', 'packages', 'ui', 'src', 'components', 'SplitView', 'SplitView.tsx'),
  path.join(repoRoot, 'design-system', 'packages', 'ui', 'src', 'components', 'ConfirmDialog', 'ConfirmDialog.tsx'),
  ...Object.values(flowChatAppearanceSources).map(file => path.join(repoRoot, file)),
  path.join(repoRoot, 'packages/flow-chat-presentation/src/terminal/TerminalOutputRenderer.tsx'),
  path.join(repoRoot, 'packages/flow-chat-presentation/src/terminal/LazyTerminalOutputRenderer.tsx'),
];
const crossBoundaryRoots = [
  path.join(repoRoot, 'MiniApp'),
  path.join(repoRoot, 'tests', 'e2e', 'specs'),
  path.join(repoRoot, 'tests', 'e2e', 'helpers'),
  path.join(repoRoot, 'src', 'crates', 'contracts', 'product-domains', 'src', 'miniapp'),
  path.join(repoRoot, 'src', 'crates', 'services', 'services-integrations', 'src', 'canvas'),
  path.join(repoRoot, 'src', 'crates', 'assembly', 'core', 'builtin_skills', 'openbitfun-canvas'),
  path.join(repoRoot, 'src', 'crates', 'assembly', 'core', 'builtin_skills', 'miniapp-dev'),
];
const failures = [];
const warnings = [];
const compoundOwnerMinimumParts = 4;
const forbiddenAggregateItemSurfaces = new Set(['workbench', 'flow-chat']);

const retiredAppearancePaths = [
  'scripts/generate-startup-theme-bootstrap.mjs',
  'scripts/generate-startup-theme-bootstrap.test.mjs',
  'src/apps/desktop/src/theme.rs',
  'src/apps/desktop/src/generated/startup_theme_bootstrap.json',
  'src/web-ui/src/infrastructure/theme',
  'src/web-ui/src/infrastructure/skin',
];
for (const retiredPath of retiredAppearancePaths) {
  if (fs.existsSync(path.join(repoRoot, retiredPath))) {
    failures.push(`${retiredPath}: retired Theme/Skin path is forbidden`);
  }
}

const finalStateContractFiles = [
  'package.json',
  'scripts/generate-startup-appearance-bootstrap.mjs',
  'src/apps/desktop/src/appearance.rs',
  'src/web-ui/src/infrastructure/config/index.ts',
  'src/web-ui/src/shared/context-menu-system/types/menu.types.ts',
  'tests/e2e/helpers/performance-trace.ts',
  'docs/development/ui-testids.md',
  'docs/development/ui-testids-CN.md',
];
const retiredFinalStateContracts = [
  ['generate-startup-theme-bootstrap', /generate-startup-theme-bootstrap/],
  ['startup_theme_bootstrap', /startup_theme_bootstrap/],
  ['STARTUP_THEME_BOOTSTRAP', /STARTUP_THEME_BOOTSTRAP/],
  ['__OPENBITFUN_BOOTSTRAP_THEME', /__OPENBITFUN_BOOTSTRAP_THEME/],
  ['prepare_theme', /prepare_theme/],
  ['prepareThemeDurationMs', /prepareThemeDurationMs/],
  ['theme-switching', /theme-switching/],
  ['MenuTheme', /\bMenuTheme\b/],
  ['appearance-theme-option', /appearance-theme-option/],
  ['data-theme-id', /data-theme-id/],
  ['legacy bootstrap CSS token', /--(?:color-(?:bg|text|accent)|border|element)-/],
];
for (const contractFile of finalStateContractFiles) {
  const absolute = path.join(repoRoot, contractFile);
  if (!fs.existsSync(absolute)) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  for (const [name, pattern] of retiredFinalStateContracts) {
    if (pattern.test(source)) {
      failures.push(`${contractFile}: retired final-state contract ${name} is forbidden`);
    }
  }
}

if (fs.existsSync(path.join(repoRoot, 'docs', 'architecture', 'skin-package-system.md'))) {
  failures.push('docs/architecture/skin-package-system.md: retired Appearance document alias is forbidden');
}
if (fs.existsSync(path.join(repoRoot, 'tests', 'e2e', 'specs', 'l0-theme.spec.ts'))) {
  failures.push('tests/e2e/specs/l0-theme.spec.ts: retired Web UI Theme E2E alias is forbidden');
}
if (fs.existsSync(retiredOwnershipFile)) {
  failures.push(`${relative(retiredOwnershipFile)}: directory-level Appearance source ownership is forbidden`);
}

const ignoredWalkDirectories = new Set(['node_modules', 'dist', 'build']);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredWalkDirectories.has(entry.name)) return [];
      return walk(absolute);
    }
    return /\.(?:css|scss|ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function walkContractSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredWalkDirectories.has(entry.name)) return [];
      return walkContractSources(absolute);
    }
    return /\.(?:css|d\.ts|html|js|json|md|rs|scss|ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(repoRoot, file);
}

function extractObject(source, start) {
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

function extractArrayProperty(source, property) {
  const match = new RegExp(`\\b${property}\\s*:`).exec(source);
  if (!match) return null;
  const open = source.indexOf('[', match.index + match[0].length);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

function extractTopLevelObjects(arraySource) {
  const objects = [];
  let index = 0;
  while (index < arraySource.length) {
    const open = arraySource.indexOf('{', index);
    if (open < 0) break;
    const object = extractObject(arraySource, open);
    if (!object) break;
    objects.push(object);
    index = open + object.length;
  }
  return objects;
}

function extractStringProperty(source, property) {
  const match = new RegExp(`\\b${property}\\s*:\\s*(?:'((?:\\\\.|[^'\\\\])*)'|"((?:\\\\.|[^"\\\\])*)")`).exec(source);
  return match ? (match[1] ?? match[2]) : null;
}

function literalAttributes(source, attribute) {
  return new Set([...source.matchAll(new RegExp(`${attribute}=["']([^"']+)["']`, 'g'))].map(match => match[1]));
}

function importedVisualClassIds(file, source) {
  const classIds = new Set();
  for (const match of source.matchAll(/import\s+['"]([^'"]+\.(?:css|scss))['"]/g)) {
    const styleFile = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(styleFile)) continue;
    const styleSource = fs.readFileSync(styleFile, 'utf8');
    for (const classMatch of styleSource.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const classId = classMatch[1];
      if (!classId.startsWith('xterm') && !classId.startsWith('is-') && !classId.includes('--')) {
        classIds.add(classId);
      }
    }
    for (const nestedMatch of styleSource.matchAll(/&(__[A-Za-z_][\w-]*)/g)) {
      classIds.add(nestedMatch[1]);
    }
  }
  return classIds;
}

function intrinsicName(node) {
  const tagName = node.tagName;
  return ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text) ? tagName.text : null;
}

function jsxTagName(node) {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : null;
}

function jsxAttribute(node, name) {
  const attribute = findDomAttribute(node, name);
  if (!attribute) return { present: false, value: null };
  if (!attribute.initializer) return { present: true, value: null };
  if (ts.isStringLiteral(attribute.initializer)) {
    return { present: true, value: attribute.initializer.text };
  }
  if (ts.isJsxExpression(attribute.initializer)
    && attribute.initializer.expression
    && ts.isStringLiteral(attribute.initializer.expression)) {
    return { present: true, value: attribute.initializer.expression.text };
  }
  return { present: true, value: null };
}

function jsxLiteralAttribute(node, name) {
  return jsxAttribute(node, name).value;
}

function jsxAttributeStringLiterals(node, name) {
  const attribute = findDomAttribute(node, name);
  if (!attribute?.initializer) return { present: false, dynamic: false, values: [] };
  if (ts.isStringLiteral(attribute.initializer)) {
    return { present: true, dynamic: false, values: [attribute.initializer.text] };
  }
  const expression = ts.isPropertyAssignment(attribute) ? attribute.initializer
    : ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
  if (!expression) {
    return { present: true, dynamic: true, values: [] };
  }
  const values = new Set();
  const collectReturnedValues = expression => {
    if (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)) {
      collectReturnedValues(expression.expression);
      return;
    }
    if (ts.isStringLiteralLike(expression)) {
      values.add(expression.text);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      collectReturnedValues(expression.whenTrue);
      collectReturnedValues(expression.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        collectReturnedValues(expression.right);
      } else if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        collectReturnedValues(expression.left);
        collectReturnedValues(expression.right);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      expression.elements.forEach(collectReturnedValues);
      return;
    }
    if (ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === 'join') {
      let receiver = expression.expression.expression;
      while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
        receiver = receiver.expression.expression;
      }
      if (ts.isArrayLiteralExpression(receiver)) {
        receiver.elements.forEach(collectReturnedValues);
      }
    }
  };
  collectReturnedValues(expression);
  return { present: true, dynamic: true, values: [...values] };
}

function datasetPropertyForAttribute(attribute) {
  return attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

const sharedToolCardHostTags = new Set([
  'AmbientToolCard',
  'CommandToolCard',
  'ContextCompressionToolCard',
  'FileOperationCardView',
  'FileOperationToolCard',
  'ProminentToolCard',
  'ReadFileToolCard',
]);

function analyzeStyledOwnerContract(file, source, visualClassIds) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const flowChatHosts = collectFlowChatAppearanceHostTags(ast);
  let hasIntrinsicContract = false;
  let hasSharedToolCardContract = false;
  let hasConfigPageLayoutContract = false;
  let hasProductAppearanceHostContract = false;
  let styledIntrinsicNodeCount = 0;
  const declaredPartIds = new Set();
  const usedVisualClassIds = new Set();

  const collectVisualClassIds = text => {
    for (const match of text.matchAll(/[A-Za-z_][\w-]*/g)) {
      if (visualClassIds.has(match[0])) usedVisualClassIds.add(match[0]);
    }
  };

  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const productSurface = jsxLiteralAttribute(node, 'data-openbitfun-product-component');
      const surface = jsxLiteralAttribute(node, 'data-openbitfun-component')
        ?? productSurface
        ?? jsxLiteralAttribute(node, 'data-openbitfun-scene');
      const part = productSurface
        ? jsxLiteralAttribute(node, 'data-openbitfun-product-part')
        : jsxLiteralAttribute(node, 'data-openbitfun-part');
      const standardPart = jsxLiteralAttribute(node, 'data-openbitfun-part');
      const productPart = jsxLiteralAttribute(node, 'data-openbitfun-product-part');
      if (standardPart) declaredPartIds.add(standardPart);
      if (productPart) declaredPartIds.add(productPart);
      if (intrinsicName(node)) {
        if (jsxAttribute(node, 'className').present) styledIntrinsicNodeCount += 1;
        if (surface && part) {
          hasIntrinsicContract = true;
        }
      }

      const tagName = jsxTagName(node);
      if (sharedToolCardHostTags.has(tagName) || flowChatHosts.has(tagName)) {
        hasSharedToolCardContract = true;
      }
      if (tagName === 'ConfigPageLayout' && surface && part) {
        hasConfigPageLayoutContract = true;
      }
      if (tagName === 'Menu' && productSurface && productPart) {
        hasProductAppearanceHostContract = true;
      }
    }
    if (ts.isStringLiteralLike(node)) collectVisualClassIds(node.text);
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      collectVisualClassIds(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);

  return {
    hasIntrinsicContract,
    hasSharedToolCardContract,
    hasConfigPageLayoutContract,
    hasProductAppearanceHostContract,
    styledIntrinsicNodeCount,
    declaredPartIds,
    usedVisualClassIds,
  };
}

const sourceFiles = walk(sourceRoot);
const sources = new Map(sourceFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));
const productionSources = [...sources.entries()].filter(([file]) => !/\.(?:test|spec)\.[jt]sx?$/.test(file));
const productionCodeSources = productionSources.filter(([file]) => /\.(?:ts|tsx)$/.test(file));
const externalAppearanceContractSources = externalAppearanceContractFiles
  .filter(file => fs.existsSync(file))
  .map(file => [file, fs.readFileSync(file, 'utf8')]);
const aggregate = productionSources.map(([, source]) => source).join('\n');
const registeredSource = fs.readFileSync(registryFile, 'utf8');
const registeredComponentExports = new Set(
  [...registeredSource.matchAll(/\.registerComponent\((\w+)\)/g)].map(match => match[1]),
);
const registeredSceneExports = new Set(
  [...registeredSource.matchAll(/\.registerScene\((\w+)\)/g)].map(match => match[1]),
);
const rendererTypesSource = fs.readFileSync(path.join(sourceRoot, 'infrastructure', 'appearance', 'types', 'index.ts'), 'utf8');

if (/settings:\s*Record<string,\s*unknown>/.test(rendererTypesSource)) {
  failures.push('Appearance renderer settings must use the closed host-owned settings map');
}
if (!rendererTypesSource.includes('export interface AppearanceRendererSettingsMap')) {
  failures.push('Appearance renderer settings must declare AppearanceRendererSettingsMap');
}

const descriptors = [];
for (const [file, source] of productionCodeSources) {
  const declaration = /export const\s+(\w+)\s*:\s*AppearanceSurfaceDescriptor\s*=\s*/g;
  for (const match of source.matchAll(declaration)) {
    const body = extractObject(source, match.index + match[0].length);
    const id = body?.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1];
    const partsBody = body ? extractArrayProperty(body, 'parts') : null;
    const statesBody = body ? extractArrayProperty(body, 'states') : null;
    const facetsBody = body ? extractArrayProperty(body, 'facets') : null;
    if (!body || !id || !partsBody) {
      failures.push(`${relative(file)}: ${match[1]} must declare literal id and parts`);
      continue;
    }
    const parts = [...partsBody.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map(part => part[1]);
    const states = statesBody ? extractTopLevelObjects(statesBody).map(state => ({
      id: state.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1],
      kind: state.match(/\bkind:\s*['"]([^'"]+)['"]/)?.[1],
      part: state.match(/\bpart:\s*['"]([^'"]+)['"]/)?.[1],
      suffix: extractStringProperty(state, 'suffix'),
    })).filter(state => state.id) : [];
    const facets = facetsBody ? extractTopLevelObjects(facetsBody).map(facet => ({
      id: facet.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1],
      attribute: facet.match(/\battribute:\s*['"]([^'"]+)['"]/)?.[1],
      values: [...(extractArrayProperty(facet, 'values') ?? '').matchAll(/['"]([^'"]+)['"]/g)].map(value => value[1]),
    })).filter(facet => facet.id && facet.attribute) : [];
    const registeredAsComponent = registeredComponentExports.has(match[1]);
    const registeredAsScene = registeredSceneExports.has(match[1]);
    if (registeredAsComponent === registeredAsScene) {
      failures.push(`${relative(file)}: ${match[1]} must be registered exactly once as a component or scene`);
    }
    descriptors.push({
      file,
      exportName: match[1],
      id,
      hostSelectorId: body.match(/\bhostSelectorId:\s*['"]([^'"]+)['"]/)?.[1],
      parts,
      states,
      facets,
      kind: registeredAsScene ? 'scene' : 'component',
      componentAttribute: body.match(/\bcomponentAttribute:\s*['"](data-openbitfun-(?:component|product-component))['"]/)?.[1]
        ?? 'data-openbitfun-component',
    });
  }
}

const duplicateIds = descriptors.filter((item, index) => descriptors.findIndex(other => other.id === item.id) !== index);
duplicateIds.forEach(item => failures.push(`${relative(item.file)}: duplicate appearance surface id ${item.id}`));
descriptors
  .filter(item => /(?:^|[-_.])(?:v\d+|legacy)(?:$|[-_.])/.test(item.id))
  .forEach(item => failures.push(`${relative(item.file)}: transitional Appearance surface id ${item.id} is forbidden`));

const descriptorsById = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
for (const descriptor of descriptors) {
  if (!descriptor.hostSelectorId) continue;
  const hostDescriptor = descriptorsById.get(descriptor.hostSelectorId);
  if (!hostDescriptor) {
    failures.push(`${relative(descriptor.file)}: Appearance host selector ${descriptor.hostSelectorId} is not registered`);
    continue;
  }
  if (hostDescriptor.hostSelectorId) {
    failures.push(`${relative(descriptor.file)}: Appearance host selector ${descriptor.hostSelectorId} must target a current DOM descriptor`);
  }
  if (hostDescriptor.kind !== descriptor.kind || hostDescriptor.componentAttribute !== descriptor.componentAttribute) {
    failures.push(`${relative(descriptor.file)}: Appearance host selector ${descriptor.hostSelectorId} must use the same surface kind and attribute`);
  }
  for (const part of descriptor.parts) {
    if (!hostDescriptor.parts.includes(part)) {
      failures.push(`${relative(descriptor.file)}: legacy Appearance part ${descriptor.id}.${part} is missing from host ${descriptor.hostSelectorId}`);
    }
  }
}
const domSurfaceParts = new Map(descriptors.map(descriptor => [descriptor.id, new Set()]));
const domSurfaceStates = new Map(descriptors.map(descriptor => [descriptor.id, new Set()]));
const domSurfaceDynamicStates = new Set();
const domSurfaceFacets = new Map(descriptors.map(descriptor => [descriptor.id, new Map()]));
let domContractCount = 0;

const domContractSources = [
  ...productionCodeSources
    .filter(([candidate]) => candidate.endsWith('.tsx'))
    .map(([file, source]) => [file, source, true]),
  ...externalAppearanceContractSources.map(([file, source]) => [file, source, false]),
];
const flowGroupOwnerPath = path.join(repoRoot, flowChatAppearanceSources.FlowGroup);
const flowGroupOwnerAst = ts.createSourceFile(flowGroupOwnerPath, fs.readFileSync(flowGroupOwnerPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

for (const [file, source, strictContractOwnership] of domContractSources) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const forwardedProps = new Set([...collectForwardedTabProps(ast), ...collectForwardedOverlayProps(ast)]);
  const forwardedFlowGroupParts = collectForwardedFlowGroupParts(ast, flowGroupOwnerAst);
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || forwardedProps.has(node)) {
      const component = jsxAttribute(node, 'data-openbitfun-component');
      const productComponent = jsxAttribute(node, 'data-openbitfun-product-component');
      const scene = jsxAttribute(node, 'data-openbitfun-scene');
      const part = jsxAttribute(node, 'data-openbitfun-part');
      const productPart = jsxAttribute(node, 'data-openbitfun-product-part');
      const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      const sourceLocation = `${relative(file)}:${location.line + 1}`;
      const surfaceAttributeCount = Number(component.present) + Number(scene.present);

      if (strictContractOwnership) {
        if (surfaceAttributeCount > 1) {
          failures.push(`${sourceLocation}: DOM node cannot declare both data-openbitfun-component and data-openbitfun-scene`);
        }
        if (surfaceAttributeCount !== Number(part.present)) {
          failures.push(`${sourceLocation}: Appearance surface and part attributes must be declared together on the same DOM node`);
        }
        if (Number(productComponent.present) !== Number(productPart.present)) {
          failures.push(`${sourceLocation}: Product Appearance surface and part attributes must be declared together on the same DOM node`);
        }
        if (component.present && component.value === null) {
          failures.push(`${sourceLocation}: data-openbitfun-component must use a string literal`);
        }
        if (productComponent.present && productComponent.value === null) {
          failures.push(`${sourceLocation}: data-openbitfun-product-component must use a string literal`);
        }
        if (scene.present && scene.value === null) {
          failures.push(`${sourceLocation}: data-openbitfun-scene must use a string literal`);
        }
        if (part.present && part.value === null) {
          failures.push(`${sourceLocation}: data-openbitfun-part must use a string literal`);
        }
        if (productPart.present && productPart.value === null) {
          failures.push(`${sourceLocation}: data-openbitfun-product-part must use a string literal`);
        }
      }

      const contracts = [
        ...(forwardedFlowGroupParts.has(node)
          ? forwardedFlowGroupParts.get(node).map(ownerNode => ({
            surface: component, part: jsxAttribute(ownerNode, 'data-openbitfun-part'),
            kind: 'component', attribute: 'data-openbitfun-component', ownerNode,
          }))
          : [{ surface: component, part, kind: 'component', attribute: 'data-openbitfun-component' }]),
        { surface: productComponent, part: productPart, kind: 'component', attribute: 'data-openbitfun-product-component' },
        { surface: scene, part, kind: 'scene', attribute: 'data-openbitfun-scene' },
      ];
      for (const contract of contracts) {
        const surfaceId = contract.surface.value;
        if (!surfaceId || !contract.part.value) continue;
        if (forbiddenAggregateItemSurfaces.has(surfaceId) && contract.part.value === 'item') {
          failures.push(`${sourceLocation}: aggregate Appearance contract ${surfaceId}.item is forbidden; the visible owner must declare a dedicated surface`);
        }
        const descriptor = descriptorsById.get(surfaceId);
        if (!descriptor) {
          if (strictContractOwnership) {
            failures.push(`${sourceLocation}: unknown Appearance ${contract.kind} id ${surfaceId}`);
          }
          continue;
        }
        const expectedAttribute = descriptor.kind === 'scene'
          ? 'data-openbitfun-scene'
          : descriptor.componentAttribute;
        if (contract.attribute !== expectedAttribute) {
          if (strictContractOwnership) {
            failures.push(`${sourceLocation}: Appearance surface ${surfaceId} must use ${expectedAttribute}`);
          }
          continue;
        }
        domContractCount += 1;
        if (descriptor.kind !== contract.kind) {
          failures.push(`${sourceLocation}: ${surfaceId} is registered as a ${descriptor.kind}, not a ${contract.kind}`);
        }
        if (!descriptor.parts.includes(contract.part.value)) {
          failures.push(`${sourceLocation}: unknown Appearance part ${surfaceId}.${contract.part.value}`);
        } else {
          domSurfaceParts.get(surfaceId)?.add(contract.part.value);
        }
        const contractNode = contract.ownerNode ?? node;
        const stateAttribute = jsxAttributeStringLiterals(contractNode, 'data-openbitfun-state');
        if (stateAttribute.present && stateAttribute.dynamic) {
          domSurfaceDynamicStates.add(surfaceId);
        }
        const stateValues = stateAttribute.values
          .flatMap(value => value.split(/\s+/).filter(Boolean));
        stateValues.forEach(stateId => {
          domSurfaceStates.get(surfaceId)?.add(stateId);
          const knownStateTokens = descriptor.states.map(candidate => (
            candidate.suffix?.match(/\[data-openbitfun-state~=["']([^"']+)["']\]/)?.[1] ?? candidate.id
          ));
          if (!knownStateTokens.includes(stateId)) {
            failures.push(`${sourceLocation}: unknown Appearance state ${surfaceId}.${stateId}`);
          }
        });
        for (const facet of descriptor.facets) {
          const facetAttribute = jsxAttributeStringLiterals(contractNode, facet.attribute);
          if (!facetAttribute.present) continue;
          const facetEntry = domSurfaceFacets.get(surfaceId)?.get(facet.attribute) ?? { dynamic: false, values: new Set() };
          facetEntry.dynamic ||= facetAttribute.dynamic;
          facetAttribute.values.forEach(value => facetEntry.values.add(value));
          domSurfaceFacets.get(surfaceId)?.set(facet.attribute, facetEntry);
          facetAttribute.values.forEach(value => {
            if (!facet.values.includes(value)) {
              failures.push(`${sourceLocation}: unknown Appearance facet value ${surfaceId}.${facet.id}.${value}`);
            }
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);

  const dynamicContractPattern = /\b([A-Za-z_$][\w$]*)\.dataset\.openbitfunComponent\s*=\s*['"]([^'"]+)['"]\s*;[\s\S]{0,240}?\b\1\.dataset\.openbitfunPart\s*=\s*['"]([^'"]+)['"]\s*;/g;
  for (const match of source.matchAll(dynamicContractPattern)) {
    const surfaceId = match[2];
    const partId = match[3];
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    const sourceLocation = `${relative(file)}:${line}`;
    const descriptor = descriptorsById.get(surfaceId);
    domContractCount += 1;
    if (!descriptor) {
      failures.push(`${sourceLocation}: unknown dynamic Appearance component id ${surfaceId}`);
      continue;
    }
    if (descriptor.kind !== 'component') {
      failures.push(`${sourceLocation}: dynamic DOM contract ${surfaceId} must reference a component descriptor`);
      continue;
    }
    if (!descriptor.parts.includes(partId)) {
      failures.push(`${sourceLocation}: unknown dynamic Appearance part ${surfaceId}.${partId}`);
      continue;
    }
    domSurfaceParts.get(surfaceId)?.add(partId);
    const dynamicNodeSource = source.slice(match.index, match.index + 800);
    for (const facet of descriptor.facets) {
      const datasetProperty = datasetPropertyForAttribute(facet.attribute);
      const assignmentPattern = new RegExp(`\\b${match[1]}\\.dataset\\.${datasetProperty}\\s*=`);
      if (!assignmentPattern.test(dynamicNodeSource)) continue;
      domSurfaceFacets.get(surfaceId)?.set(facet.attribute, { dynamic: true, values: new Set() });
    }
  }
}

for (const descriptor of descriptors) {
  const kind = descriptor.kind === 'scene' ? 'Scene' : 'Component';
  const domSurfaceId = descriptor.hostSelectorId ?? descriptor.id;
  for (const part of descriptor.parts) {
    if (!domSurfaceParts.get(domSurfaceId)?.has(part)) {
      failures.push(`${relative(descriptor.file)}: registered part ${descriptor.id}.${part} has no exact DOM contract`);
    }
  }
  for (const state of descriptor.states) {
    const stateToken = state.suffix?.match(/\[data-openbitfun-state~=["']([^"']+)["']\]/)?.[1];
    if (state.kind === 'ancestorPart' && state.part && !descriptor.parts.includes(state.part)) {
      failures.push(`${relative(descriptor.file)}: state ${descriptor.id}.${state.id} references unknown ancestor part ${state.part}`);
    }
    if (stateToken
      && !domSurfaceStates.get(domSurfaceId)?.has(stateToken)
      && !domSurfaceDynamicStates.has(domSurfaceId)) {
      failures.push(`${relative(descriptor.file)}: registered state ${descriptor.id}.${state.id} has no DOM state source (${stateToken})`);
    }
  }
  for (const facet of descriptor.facets) {
    if (!domSurfaceFacets.get(domSurfaceId)?.has(facet.attribute)) {
      failures.push(`${relative(descriptor.file)}: registered facet ${descriptor.id}.${facet.id} has no DOM attribute source (${facet.attribute})`);
    }
  }
  if (!registeredSource.includes(`register${kind}(${descriptor.exportName})`)) {
    failures.push(`${relative(descriptor.file)}: ${descriptor.exportName} is not registered in defaultAppearanceRegistry`);
  }
}

for (const sceneFile of walk(sceneRoot).filter(file => file.endsWith('Scene.tsx') && !/\.(?:test|spec)\.tsx$/.test(file))) {
  const appearanceFile = path.join(path.dirname(sceneFile), 'appearance.ts');
  if (!fs.existsSync(appearanceFile)) {
    failures.push(`${relative(sceneFile)}: top-level Scene must own colocated appearance.ts`);
    continue;
  }
  const sceneIds = literalAttributes(sources.get(sceneFile) ?? '', 'data-openbitfun-scene');
  const colocatedDescriptorIds = new Set(descriptors.filter(item => item.file === appearanceFile).map(item => item.id));
  if (sceneIds.size === 0) {
    failures.push(`${relative(sceneFile)}: top-level Scene must expose a literal data-openbitfun-scene root contract`);
  } else if (![...sceneIds].some(id => colocatedDescriptorIds.has(id))) {
    failures.push(`${relative(sceneFile)}: no data-openbitfun-scene value matches a descriptor in colocated appearance.ts`);
  }
}

const visualEntryPoints = new Set([
  'main.tsx',
  'tools/openbitfun-canvas/runtime/entry.tsx',
]);
const styledProductionTsx = productionCodeSources.filter(([file, source]) => {
  if (!file.endsWith('.tsx')) return false;
  const sourceRelative = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
  if (visualEntryPoints.has(sourceRelative)) return false;
  return /\.(?:css|scss)['"]/.test(source);
});
const allVisualClassIds = new Set();
for (const [file, source] of productionSources) {
  if (!/\.(?:css|scss)$/.test(file)) continue;
  for (const match of source.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
    if (!match[1].startsWith('xterm') && !match[1].startsWith('is-') && !match[1].includes('--')) {
      allVisualClassIds.add(match[1]);
    }
  }
  for (const match of source.matchAll(/&(__[A-Za-z_][\w-]*)/g)) allVisualClassIds.add(match[1]);
}
const flowChatToolCardFile = path.join(
  repoRoot,
  'design-system',
  'packages',
  'ui',
  'src',
  'flow-chat',
  'tool-cards',
  'FlowChatToolCard.tsx',
);
const flowChatToolCardSource = fs.existsSync(flowChatToolCardFile)
  ? fs.readFileSync(flowChatToolCardFile, 'utf8')
  : '';
if (!flowChatToolCardSource.includes('data-openbitfun-component="flow-chat-tool-card"')
  || !flowChatToolCardSource.includes('data-openbitfun-part="root"')
  || !flowChatToolCardSource.includes('data-openbitfun-part="surface"')
  || !flowChatToolCardSource.includes('data-openbitfun-part="summary"')
  || !flowChatToolCardSource.includes('part: "error" | "expanded"')
  || !flowChatToolCardSource.includes('data-openbitfun-part={part}')) {
  failures.push('@openbitfun/ui FlowChat tool cards must project the shared multi-part Appearance contract');
}
const configPageLayoutSource = sources.get(path.join(sourceRoot, 'infrastructure', 'config', 'components', 'common', 'ConfigPageLayout.tsx')) ?? '';
if (!configPageLayoutSource.includes('...props')
  || !configPageLayoutSource.includes('data-openbitfun-component="config"')
  || !configPageLayoutSource.includes('data-openbitfun-part="root"')) {
  failures.push('ConfigPageLayout must forward caller Appearance attributes to its real config root');
}

for (const [file, source] of styledProductionTsx) {
  const visualClassIds = importedVisualClassIds(file, source);
  const contract = analyzeStyledOwnerContract(file, source, visualClassIds);
  if (!contract.hasIntrinsicContract
    && !contract.hasSharedToolCardContract
    && !contract.hasConfigPageLayoutContract
    && !contract.hasProductAppearanceHostContract) {
    failures.push(`${relative(file)}: styled production component must expose a direct DOM Appearance contract or an approved host-forwarded contract`);
    continue;
  }

  const visualClassCount = contract.usedVisualClassIds.size;
  if (visualClassCount >= compoundOwnerMinimumParts
    && contract.styledIntrinsicNodeCount >= compoundOwnerMinimumParts) {
    const requiredPartCount = Math.min(
      compoundOwnerMinimumParts,
      visualClassCount,
      contract.styledIntrinsicNodeCount,
    );
    if (contract.declaredPartIds.size < requiredPartCount) {
      failures.push(
        `${relative(file)}: compound styled owner (${visualClassCount} used visual classes, ${contract.styledIntrinsicNodeCount} styled DOM nodes) must expose at least ${requiredPartCount} distinct Appearance parts`,
      );
    }
  }

}

for (const [file, source] of productionCodeSources.filter(([candidate]) => candidate.endsWith('.tsx'))) {
  if (styledProductionTsx.some(([styledFile]) => styledFile === file)) continue;
  const contract = analyzeStyledOwnerContract(file, source, allVisualClassIds);
  if (contract.usedVisualClassIds.size < 8 || contract.hasIntrinsicContract
    || contract.hasSharedToolCardContract || contract.hasConfigPageLayoutContract
    || contract.hasProductAppearanceHostContract) continue;
  warnings.push(`${relative(file)}: uses ${contract.usedVisualClassIds.size} shared visual classes without a direct Appearance contract; review whether it needs a dedicated surface`);
}

const adapterFiles = productionCodeSources.filter(([file]) => file.includes(`${path.sep}infrastructure${path.sep}appearance${path.sep}adapters${path.sep}`) && file.endsWith('AppearanceAdapter.ts'));
for (const [file, source] of adapterFiles) {
  const exportName = source.match(/export const\s+(\w+)/)?.[1];
  const id = source.match(/(?:readonly\s+)?id\s*(?:=|:)\s*['"]([^'"]+)['"]/)?.[1];
  if (!exportName || !id) {
    failures.push(`${relative(file)}: renderer adapter must export a singleton with a literal id`);
    continue;
  }
  if (!registeredSource.includes(`registerRenderer(${exportName})`)) {
    failures.push(`${relative(file)}: ${exportName} is not registered in defaultAppearanceRegistry`);
  }
  if (!aggregate.includes(`'${id}':`) && !aggregate.includes(`${id}:`)) {
    failures.push(`${relative(file)}: renderer ${id} has no Appearance package settings producer`);
  }
  if (/extends\s+Record<string,\s*unknown>|Readonly<Record<string,\s*unknown>>/.test(source)) {
    failures.push(`${relative(file)}: renderer adapters must not expose open Record<string, unknown> payloads`);
  }
}

const themeTokenAdapterSource = fs.readFileSync(path.join(sourceRoot, 'infrastructure', 'appearance', 'adapters', 'ThemeTokenAppearanceAdapter.ts'), 'utf8');
if (!themeTokenAdapterSource.includes('APPEARANCE_ROOT_TOKEN_NAMES') || themeTokenAdapterSource.includes("startsWith(ALLOWED_TOKEN_PREFIX)")) {
  failures.push('ThemeTokenAppearanceAdapter must validate against the closed canonical token registry');
}
const widgetAdapterSource = fs.readFileSync(path.join(sourceRoot, 'infrastructure', 'appearance', 'adapters', 'WidgetAppearanceAdapter.ts'), 'utf8');
if (!widgetAdapterSource.includes('WIDGET_APPEARANCE_VARIABLE_NAMES')) {
  failures.push('WidgetAppearanceAdapter must validate against the closed widget variable registry');
}

const runtimeSource = fs.readFileSync(path.join(sourceRoot, 'infrastructure', 'appearance', 'runtime', 'AppearanceRuntime.ts'), 'utf8');
if (!runtimeSource.includes('getRendererAdapters()')) {
  failures.push('AppearanceRuntime must consume every registered renderer adapter');
}
const compilerSource = fs.readFileSync(path.join(sourceRoot, 'infrastructure', 'appearance', 'compiler', 'AppearanceCompiler.ts'), 'utf8');
if (/\bfetch\s*\(/.test(compilerSource) || /127\.0\.0\.1:7469|#region agent log/.test(compilerSource)) {
  failures.push('AppearanceCompiler must remain a pure compiler without debug network side effects');
}

for (const [file, source] of productionSources) {
  if (source.includes('data-openbitfun-kind')) {
    failures.push(`${relative(file)}: data-openbitfun-kind is forbidden; use a dedicated surface, semantic part, facet, or state`);
  }
  const normalizedFile = relative(file).replaceAll('\\', '/');
  if (/appearance(?:[-_.]?(?:v\d+|new|legacy))/i.test(normalizedFile)
    || /\b(?:AppearanceV\d+|appearanceV\d+|newAppearance|appearanceNew|legacyAppearance|appearanceLegacy)\b/.test(source)) {
    failures.push(`${relative(file)}: versioned or transitional Appearance naming is forbidden`);
  }
  if (/\.(?:css|scss)$/.test(file) && /prefers-color-scheme/.test(source)) {
    failures.push(`${relative(file)}: production styles must follow data-openbitfun-appearance-mode instead of OS color-scheme media queries`);
  }
  if (source.includes('createPortal(') && !source.includes('getAppearanceOverlayHost')) {
    failures.push(`${relative(file)}: createPortal must target getAppearanceOverlayHost()`);
  }
  if (/infrastructure[\\/]skin|\bSkinService\b|\buseSkin\b/.test(source)) {
    failures.push(`${relative(file)}: legacy Skin runtime reference is forbidden`);
  }
  if (/\bThemeService\b|\bthemeService\b|\buseTheme\b|\buseThemeStore\b|ThemeAppearanceBridge/.test(source)) {
    failures.push(`${relative(file)}: legacy Theme runtime reference is forbidden`);
  }
  if (/data-theme(?:-type)?|data-openbitfun-theme(?!-scope(?=$|[="'\]\s]))|openbitfun\/request-theme|themeChange|onThemeChange/.test(source)) {
    failures.push(`${relative(file)}: legacy Theme DOM or bridge contract is forbidden`);
  }
  if (/--(?:color|border|element|git-color|scrollbar|shadow|blur|size|opacity|motion|easing|font|line-height|btn|flowchat|scene)-/.test(source)) {
    failures.push(`${relative(file)}: legacy CSS token prefix is forbidden`);
  }
  if (/--(?:glass|tool-card)-/.test(source)) {
    failures.push(`${relative(file)}: surface-local visual token prefix is forbidden`);
  }
  if (/theme-config|theme-card|theme-preview|preview-theme-selector|deep-skin/.test(source)) {
    failures.push(`${relative(file)}: retired Theme/Skin presentation naming is forbidden`);
  }
  if (/section\s*===\s*['"]theme['"]/.test(source)) {
    failures.push(`${relative(file)}: retired Theme settings deep-link alias is forbidden`);
  }
  if (file.includes(`${path.sep}infrastructure${path.sep}appearance${path.sep}`)
    && source.includes('selectorSuffix')) {
    failures.push(`${relative(file)}: retired selectorSuffix state contract is forbidden`);
  }
}


const crossBoundaryForbiddenContracts = [
  ['hostTheme', /\bhostTheme\b/],
  ['CanvasHostTheme', /\bCanvasHostTheme\b/],
  ['openbitfun-canvas-theme', /openbitfun-canvas-theme/],
  ['onThemeChange', /\bonThemeChange\b/],
  ['data-theme-type', /data-theme-type/],
  ['openbitfun/request-theme', /openbitfun\/request-theme/],
  ['ThemeService', /\bThemeService\b/],
  ['SkinService', /\bSkinService\b/],
  ['tools/editor/themes', /tools[\\/]editor[\\/]themes/],
  ['editor.theme', /\beditor\.theme\b/],
  ['terminal.theme', /\bterminal\.theme\b/],
  ['app.theme', /\bapp\.theme\b/],
  ['theme-config', /theme-config/],
  ['--glass-*', /--glass-[a-z0-9-]+/i],
  ['--tool-card-*', /--tool-card-[a-z0-9-]+/i],
];

const crossBoundaryFiles = crossBoundaryRoots.flatMap(walkContractSources);
for (const file of crossBoundaryFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [name, pattern] of crossBoundaryForbiddenContracts) {
    if (pattern.test(source)) failures.push(`${relative(file)}: retired cross-boundary contract ${name} is forbidden`);
  }
}

if (failures.length > 0) {
  console.error('Appearance contract audit failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn('Appearance contract audit warnings:');
  warnings.forEach(warning => console.warn(`- ${warning}`));
}

console.log(`Appearance contract audit passed (${descriptors.length} surfaces, ${domContractCount} DOM contracts, ${styledProductionTsx.length} styled component owners, ${warnings.length} shared-style owner warnings, ${sourceFiles.length} Web UI files, ${crossBoundaryFiles.length} cross-boundary files).`);
