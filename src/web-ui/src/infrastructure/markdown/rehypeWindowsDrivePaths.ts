import { visit } from 'unist-util-visit';

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Mark Windows drive-letter paths as local file references before
 * rehype-sanitize evaluates their apparent protocol (`C:`). The canonical
 * `file:///C:/...` form also keeps the transformed value a valid file URI if
 * another renderer ever observes it before local-path normalization.
 */
export function rehypeWindowsDrivePaths() {
  return (tree: unknown) => {
    visit(tree, 'element', (node: any) => {
      for (const property of ['src', 'href']) {
        const value = node.properties?.[property];
        if (typeof value === 'string' && WINDOWS_DRIVE_PATH.test(value)) {
          node.properties[property] = `file:///${value.replace(/\\/g, '/')}`;
        }
      }
    });
  };
}
