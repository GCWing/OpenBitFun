import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const pickerNames = new Set(['Select', 'Combobox', 'MultiSelect']);
const settingsRoots = [
  new URL('../../', import.meta.url),
  new URL('../../../font-preference/', import.meta.url),
  new URL('../../../../app/scenes/settings/', import.meta.url),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(path) ? [path] : [];
  });
}

it('uses the design-system small size consistently across settings selection fields', () => {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const path of settingsRoots.flatMap(url => sourceFiles(fileURLToPath(url)))) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Map<string, string>();

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== '@openbitfun/ui') continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (pickerNames.has(name)) imports.set(binding.name.text, name);
      }
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = imports.get(node.tagName.getText(source));
        if (name) {
          seen.add(name);
          const size = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'size',
          )?.initializer;
          if (!size || !ts.isStringLiteral(size) || size.text !== 'sm') {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            violations.push(`${relative(process.cwd(), path)}:${line} ${name} must use size="sm"`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A picker may have no consumers; every picker that is used must still be checked.
  expect(seen.size).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
