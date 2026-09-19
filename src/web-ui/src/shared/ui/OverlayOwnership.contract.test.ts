import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path)
      : /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

describe('product overlay ownership', () => {
  it('routes product portals through the design system coordinator', () => {
    const unmanaged = sources(sourceRoot).filter(path =>
      /\bcreatePortal\s*\(/.test(readFileSync(path, 'utf8')),
    );
    expect(unmanaged.map(path => relative(sourceRoot, path))).toEqual([]);
  });

  it('keeps the shared context-menu service from competing with MenuPopover dismissal', () => {
    const manager = readFileSync(resolve(sourceRoot, 'shared/context-menu-system/core/ContextMenuManager.ts'), 'utf8');
    expect(manager).not.toMatch(/document\.addEventListener\(['"](?:click|keydown|mousedown|pointerdown)['"]/);
  });

  it('keeps portal geometry neutral and rank allocation in the coordinator', () => {
    const css = readFileSync(resolve(process.cwd(), '../../design-system/packages/ui/src/overlay/Portal.module.css'), 'utf8');
    expect(css).not.toMatch(/\b(?:z-index|transform|filter|backdrop-filter|contain|isolation)\s*:/);
    expect(css).toMatch(/position:\s*fixed/);
    expect(css).toMatch(/pointer-events:\s*none/);
  });
});
