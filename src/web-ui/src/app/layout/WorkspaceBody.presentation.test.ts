import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  fileURLToPath(new URL('./WorkspaceBody.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

const stylesheet = readFileSync(
  fileURLToPath(new URL('./WorkspaceBody.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

const navBarStylesheet = readFileSync(
  fileURLToPath(new URL('../components/NavBar/NavBar.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

const sceneTopBarStylesheet = readFileSync(
  fileURLToPath(new URL('../components/SceneTopBar/SceneTopBar.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

const layoutStylesheet = readFileSync(
  fileURLToPath(new URL('./AppLayout.scss', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

describe('WorkspaceBody presentation contract', () => {
  it('starts the navigation at 300px while retaining its resize range', () => {
    expect(componentSource).toContain('const NAV_DEFAULT_WIDTH = 300;');
    expect(componentSource).toContain('const NAV_MIN_WIDTH = 216;');
    expect(componentSource).toContain('const NAV_MAX_WIDTH = 480;');
    expect(stylesheet).toContain('$_nav-width: 300px;');
  });

  it('shares the split-view content-panel curvature with its resize feedback edge', () => {
    expect(stylesheet).toContain(
      '--_scene-surface-radius: var(--openbitfun-layout-split-view-content-panel-radius);',
    );
    expect(stylesheet.match(
      /border-radius: var\(--_scene-surface-radius\) 0 0 var\(--_scene-surface-radius\);/g,
    )).toHaveLength(2);
    expect(stylesheet).toContain('width: var(--_scene-surface-radius);');
    expect(stylesheet).not.toContain(
      'border-radius: $size-radius-xl 0 0 $size-radius-xl;',
    );
  });

  it('keeps the collapsed navigation control on the scene surface without a sidebar tile', () => {
    expect(navBarStylesheet).toContain('@include shell-surfaces.sidebar-background;');
    expect(navBarStylesheet).toMatch(
      /&--collapsed\s*\{[^}]*background:\s*transparent;/,
    );
  });

  it('keeps navigation and scene tabs on the same toolbar row with the viewport attached below', () => {
    const sharedHeight = 'var(--openbitfun-layout-toolbar-md-height)';
    expect(layoutStylesheet).not.toMatch(/--openbitfun-layout-toolbar-md-height\s*:/);
    expect(stylesheet).toContain(`$_nav-bar-height: ${sharedHeight};`);
    expect(stylesheet).toContain('padding: 0 var(--openbitfun-space-4);');
    expect(stylesheet).toMatch(
      /\.openbitfun-workspace-body__scene-surface\s*\{[^}]*gap:\s*0;/s,
    );
    expect(navBarStylesheet).toContain(`height: ${sharedHeight};`);
    expect(sceneTopBarStylesheet).toContain(`height: ${sharedHeight};`);
    expect(sceneTopBarStylesheet).toContain(`flex: 0 0 ${sharedHeight};`);
  });
});
