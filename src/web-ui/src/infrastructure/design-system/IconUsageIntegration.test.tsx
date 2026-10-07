import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon, iconNames } from '@openbitfun/ui';
import { HARNESS_PRESENTATION } from '@/shared/agents/harnessPresentation';
import { ConfigRefreshButton } from '@/infrastructure/config/components/common';

const sourceRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(path.join(sourceRoot, relativePath), 'utf8');
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'generated') return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(file);
    return /\.tsx?$/.test(file) && !/\.(test|appearance)\./.test(file) ? [file] : [];
  });
}

describe('catalog icon consumer integration', () => {
  it('renders general-purpose icons through Lucide while retaining reviewed authored artwork', () => {
    const preserved = new Set([
      'minimal', 'standard', 'ultimate', 'creative', 'git', 'thinking',
      'reasoning-auto',
    ]);
    for (const name of iconNames) {
      const markup = renderToStaticMarkup(createElement(Icon, { name }));
      if (preserved.has(name)) {
        expect(markup).toContain('mask-image');
        expect(markup).not.toContain('<svg');
      } else {
        expect(markup).toContain('class="lucide lucide-');
        expect(markup).not.toContain('mask-image');
      }
    }
  });

  it('uses catalog marks in navigation, the creative entry and string-based menus', () => {
    expect(source('app/components/NavPanel/components/MiniAppEntry.tsx')).toContain('<Icon name="mini-app" size="sm"');
    expect(source('app/components/NavBar/NavBar.tsx')).toContain('<Icon name="sidebar-left"');
    const harnessSource = source('app/scenes/agents/components/AgentHarnessOverview.tsx');
    expect(harnessSource).toContain('HARNESS_PRESENTATION[id]');
    expect(HARNESS_PRESENTATION.Creative.icon).toBe('creative');
    expect(harnessSource).toContain('<Icon name={icon}');
    expect(source('shared/context-menu-system/components/ContextMenuRenderer.tsx')).toContain("RefreshCw: 'refresh'");
    expect(source('shared/context-menu-system/components/ContextMenuRenderer.tsx')).toContain("MessageSquarePlus: 'side-chat'");
    expect(source('shared/context-menu-system/components/ContextMenuRenderer.tsx')).toContain("FileInput: 'duplicate'");
    expect(source('shared/context-menu-system/components/ContextMenuRenderer.tsx')).toContain("FileOutput: 'duplicate'");
    expect(source('shared/context-menu-system/components/ContextMenuRenderer.tsx')).toContain("PanelRightOpen: 'browser'");
    expect(source('app/components/NavBar/NavBar.tsx')).not.toContain('PanelLeftIcon');
  });

  it('uses canonical catalog names instead of compatibility aliases', () => {
    const leftovers = filesIn(sourceRoot).flatMap(file => {
      const contents = readFileSync(file, 'utf8');
      return ['download', 'circle']
        .filter(name => contents.includes(`name="${name}"`))
        .map(name => `${path.relative(sourceRoot, file).replaceAll('\\', '/')}: ${name}`);
    });
    expect(leftovers).toEqual([]);
  });

  it('keeps pixel-to-token and Lucide line-weight adaptation inside the shared Icon boundary', () => {
    const localAdapters = filesIn(sourceRoot).flatMap(file => {
      const contents = readFileSync(file, 'utf8');
      const hasPixelMapping = contents.includes("<= 11")
        && contents.includes("'2xs'")
        && contents.includes("'xs'")
        && contents.includes("'sm'")
        && contents.includes("'md'")
        && contents.includes("'lg'");
      return hasPixelMapping
        ? [path.relative(sourceRoot, file).replaceAll('\\', '/')]
        : [];
    });

    expect(localAdapters).toEqual([]);
    expect(source('app/components/NavPanel/MainNav.tsx')).toContain('<Icon glyph={Users} size="sm" />');
    expect(source('app/components/NavPanel/MainNav.tsx')).toContain('<Icon glyph={Network} size="sm" />');
    expect(source('app/scenes/agents/agentsIcons.ts')).toContain('Record<AgentIconKey, IconSource>');
    expect(source('app/scenes/ecosystem-compatibility/ExternalAgentContent.tsx'))
      .toContain('Record<EcosystemImportItemKind, IconSource>');

    const galleryEmpty = source('app/components/GalleryLayout/GalleryEmpty.tsx');
    expect(galleryEmpty).toContain('icon: IconSource');
    expect(galleryEmpty).toContain('<Icon {...icon} />');
    expect(source('app/components/GalleryLayout/GalleryLayout.scss'))
      .toContain('--_gallery-empty-icon-size:');

    for (const normalizedSurface of [
      'app/components/NavPanel/MainNav.tsx',
      'app/scenes/agents/AgentsScene.tsx',
      'app/scenes/skills/SkillsScene.tsx',
      'app/scenes/skills/components/SkillGroupsView.tsx',
    ]) {
      expect(source(normalizedSurface)).not.toContain('strokeWidth=');
    }
  });

  it('keeps the shared refresh action compact and disables it while loading', () => {
    const props = { tooltip: 'Refresh', onClick: () => {} };
    const idle = renderToStaticMarkup(createElement(ConfigRefreshButton, props));
    expect(idle).toContain('data-openbitfun-name="refresh"');
    expect(idle).toContain('data-size="sm"');
    const loading = renderToStaticMarkup(createElement(ConfigRefreshButton, { ...props, loading: true }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('disabled=""');
  });

  it('preserves consumer animation classes and exact non-token dimensions on Lucide icons', () => {
    const markup = renderToStaticMarkup(createElement(Icon, {
      name: 'refresh', size: 'lg', className: 'browser-panel__spinning',
      style: { width: 20, height: 20 },
    }));
    expect(markup).toContain('browser-panel__spinning');
    expect(markup).toContain('width:20px;height:20px');
    for (const scene of ['BrowserPanel', 'BrowserScene']) {
      const styles = source(`app/scenes/browser/${scene}.scss`);
      expect(styles).toMatch(/&__spinning\s*\{\s*animation:/);
      expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?__spinning\s*\{\s*animation:\s*none/);
    }
  });
});
