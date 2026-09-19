import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  });
}

/** Detect row collections whose immediate layout owner cannot supply MenuList spacing. */
function findUnownedRows(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@openbitfun/ui') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) {
        imports.set(entry.name.text, entry.propertyName?.text ?? entry.name.text);
      }
    }
  }
  if (![...imports.values()].includes('MenuItem')) return [];

  function rows(node: ts.Node, repeated = false): boolean[] {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const component = imports.get(opening.tagName.getText(ast));
      if (component === 'MenuItem') return [repeated];
      // Tooltip clones its child; every other element starts a new layout owner.
      if (component !== 'Tooltip') return [];
    }
    const isMap = ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'map';
    const result: boolean[] = [];
    ts.forEachChild(node, child => { result.push(...rows(child, repeated || isMap)); });
    return result;
  }

  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node)) {
      const name = node.openingElement.tagName.getText(ast);
      if (/^[a-z]/.test(name) || imports.get(name) === 'ScrollArea') {
        const ownedRows = node.children.flatMap(child => rows(child));
        if (ownedRows.length > 1 || ownedRows.some(Boolean)) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${file}:${line}: wrap the MenuItem collection in MenuList instead of <${name}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

describe('menu row layout ownership', () => {
  it('rejects ordinary wrappers that drop row spacing, including mapped and tooltip-wrapped items', () => {
    const imports = 'import { MenuItem, MenuList, ScrollArea, Tooltip } from "@openbitfun/ui";';
    for (const content of [
      '<div><MenuItem>A</MenuItem><MenuItem>B</MenuItem></div>',
      '<ScrollArea>{items.map(item => <MenuItem>{item}</MenuItem>)}</ScrollArea>',
      '<div>{items.map(item => <Tooltip content={item}><MenuItem>{item}</MenuItem></Tooltip>)}</div>',
    ]) {
      expect(findUnownedRows(`${imports} const view = ${content};`, 'menu.tsx')).toHaveLength(1);
    }
    expect(findUnownedRows(`${imports} const view = <ScrollArea><MenuList>{items.map(item => <MenuItem>{item}</MenuItem>)}</MenuList></ScrollArea>;`, 'menu.tsx')).toEqual([]);
    // A single action beside a header is not a vertical row collection.
    expect(findUnownedRows(`${imports} const view = <div><span>Presets</span><MenuItem>Auto</MenuItem></div>;`, 'menu.tsx')).toEqual([]);
  });

  it('keeps every product menu row collection under a design-system layout owner', () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('MenuItem') ? findUnownedRows(source, path.relative(sourceRoot, file)) : [];
    });
    expect(violations).toEqual([]);
  });
});
