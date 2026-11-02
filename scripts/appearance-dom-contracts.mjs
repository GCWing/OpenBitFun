import ts from 'typescript';

// Concrete package owners, scanned by the audit as DOM evidence as well as imports.
export const flowChatAppearanceSources = {
  FlowGroup: 'design-system/packages/ui/src/flow-chat/conversation/FlowGroup.tsx',
  ThinkingBlock: 'design-system/packages/ui/src/flow-chat/conversation/ThinkingBlock.tsx',
  ExploreGroup: 'design-system/packages/ui/src/flow-chat/conversation/ToolGroup.tsx',
  ContextLoadGroup: 'design-system/packages/ui/src/flow-chat/conversation/ToolGroup.tsx',
  FlowChatRuntimeStatus: 'design-system/packages/ui/src/flow-chat/conversation/FlowChatRuntimeStatus.tsx',
  ToolDuration: 'design-system/packages/ui/src/flow-chat/conversation/ToolDuration.tsx',
};

/**
 * FlowGroup forwards one literal surface identity to its concrete anatomy. Read
 * the parts and states from that owner, never from a caller-supplied part list.
 */
export function collectForwardedFlowGroupParts(ast, ownerAst) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@openbitfun/ui/flow-chat') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'FlowGroup') names.add(binding.name.text);
    }
  }

  const parts = [];
  const readOwner = node => {
    if (ts.isFunctionExpression(node) && node.name?.text === 'FlowGroup') {
      const parameter = node.parameters[0]?.name;
      const identity = parameter && ts.isObjectBindingPattern(parameter)
        ? parameter.elements.find(element => element.propertyName && ts.isStringLiteral(element.propertyName)
          && element.propertyName.text === 'data-openbitfun-component')?.name
        : undefined;
      if (!identity || !ts.isIdentifier(identity)) return;
      const readPart = child => {
        if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
          const component = findDomAttribute(child, 'data-openbitfun-component')?.initializer;
          const part = findDomAttribute(child, 'data-openbitfun-part')?.initializer;
          if (component && ts.isJsxExpression(component) && component.expression
            && ts.isIdentifier(component.expression) && component.expression.text === identity.text
            && part && ts.isStringLiteral(part)) parts.push(child);
        }
        ts.forEachChild(child, readPart);
      };
      readPart(node.body);
      return;
    }
    ts.forEachChild(node, readOwner);
  };
  readOwner(ownerAst);

  const forwarded = new Map();
  const visit = node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName) && names.has(node.tagName.text)) {
      const attributes = node.attributes.properties;
      const identity = findDomAttribute(node, 'data-openbitfun-component');
      const part = findDomAttribute(node, 'data-openbitfun-part')?.initializer;
      if (identity?.initializer && ts.isStringLiteral(identity.initializer)
        && part && ts.isStringLiteral(part) && part.text === 'root'
        && !attributes.slice(attributes.indexOf(identity) + 1).some(ts.isJsxSpreadAttribute)) {
        forwarded.set(node, parts);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return forwarded;
}

export function collectFlowChatAppearanceHostTags(ast) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@openbitfun/ui/flow-chat') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (Object.hasOwn(flowChatAppearanceSources, (binding.propertyName ?? binding.name).text)) names.add(binding.name.text);
    }
  }
  return names;
}

const overlayPropNodes = new WeakSet();

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function property(object, name) {
  return object.properties.find(candidate => ts.isPropertyAssignment(candidate)
    && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name))
    && candidate.name.text === name);
}

/** Only literal item props on the published TabGroup forwarding path count as DOM evidence. */
export function collectForwardedTabProps(ast) {
  const tabGroupNames = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@openbitfun/ui') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'TabGroup') tabGroupNames.add(binding.name.text);
    }
  }
  const forwarded = new Set();
  function addItem(expression) {
    const item = unwrap(expression);
    if (!item || !ts.isObjectLiteralExpression(item)
      || item.properties.some(ts.isSpreadAssignment)) return;
    const props = unwrap(property(item, 'tabProps')?.initializer);
    if (props && ts.isObjectLiteralExpression(props)
      && !props.properties.some(ts.isSpreadAssignment)) forwarded.add(props);
  }
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName) && tabGroupNames.has(node.tagName.text)) {
      const attribute = findDomAttribute(node, 'items');
      const expression = unwrap(attribute?.initializer && ts.isJsxExpression(attribute.initializer)
        ? attribute.initializer.expression : undefined);
      if (expression && ts.isArrayLiteralExpression(expression)) expression.elements.forEach(addItem);
      if (expression && ts.isCallExpression(expression)
        && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'map') {
        const callback = expression.arguments[0];
        if (callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) addItem(callback.body);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return forwarded;
}

export function findDomAttribute(node, name) {
  if (overlayPropNodes.has(node) && [
    'data-openbitfun-component', 'data-openbitfun-part',
    'data-openbitfun-native-webview-occlusion', 'data-placement', 'data-state',
  ].includes(name)) return undefined;
  // TabGroup writes these after the spread, so caller values are not DOM evidence.
  if (ts.isObjectLiteralExpression(node)
    && (name === 'data-openbitfun-part' || name === 'data-openbitfun-value')) return undefined;
  return ts.isObjectLiteralExpression(node)
    ? property(node, name)
    : node.attributes.properties.find(candidate => ts.isJsxAttribute(candidate) && candidate.name.text === name);
}

/** Literal overlay props are forwarded only by the published Dialog and Sheet. */
export function collectForwardedOverlayProps(ast) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@openbitfun/ui') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (['Dialog', 'Sheet'].includes((binding.propertyName ?? binding.name).text)) names.add(binding.name.text);
    }
  }
  const forwarded = new Set();
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName) && names.has(node.tagName.text)
      && !node.attributes.properties.some(ts.isJsxSpreadAttribute)) {
      const attribute = findDomAttribute(node, 'overlayProps');
      const expression = unwrap(attribute?.initializer && ts.isJsxExpression(attribute.initializer)
        ? attribute.initializer.expression : undefined);
      if (expression && ts.isObjectLiteralExpression(expression)
        && !expression.properties.some(ts.isSpreadAssignment)) {
        forwarded.add(expression);
        overlayPropNodes.add(expression);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return forwarded;
}
