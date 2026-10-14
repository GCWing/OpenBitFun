import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSibling(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(filename, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('Skills scene presentation', () => {
  it('keeps the installed collection in the shared page scroll region', () => {
    const source = readSibling('./SkillsScene.tsx');

    expect(source).toContain('{installedPagination.skills.map((skill) => (');
    expect(source).toContain('<ScrollArea className="skills-scene__scroll" ref={scrollRef}>');
    expect(source).not.toMatch(/<ScrollArea\s+className="skills-main__/);
    expect(source.match(/<SkillsPagination\b/g)).toHaveLength(2);
    expect(source.match(/<SkillsGrid\b/g)).toHaveLength(2);
    expect(source).toContain('total={installedFiltered.length}');
  });

  it('lays out skill items in two columns inside the page scroll region', () => {
    const stylesheet = readSibling('./SkillsScene.scss');
    const gridStart = stylesheet.indexOf('.skills-main__grid,');
    const gridEnd = stylesheet.indexOf('.skills-card-skeleton {', gridStart);

    expect(stylesheet.slice(gridStart, gridEnd)).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(stylesheet.slice(gridStart, gridEnd)).not.toContain('overflow:');
    expect(stylesheet).toContain('scrollbar-gutter: stable both-edges;');
    expect(stylesheet).toContain('@container skills-content (max-width: 480px)');
    expect(stylesheet).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it('uses a centered title and a compact market entry above the shared content frame', () => {
    const stylesheet = readSibling('./SkillsScene.scss');
    const source = readSibling('./SkillsScene.tsx');
    const titleStart = stylesheet.indexOf('.skills-scene__title {');
    const titleEnd = stylesheet.indexOf('\n}', titleStart);
    const marketStart = source.indexOf('className="skills-scene__market-button"');
    const marketEnd = source.indexOf('</Button>', marketStart);

    expect(stylesheet).toContain('@include configLayout.content-frame;');
    expect(stylesheet.slice(titleStart, titleEnd)).toContain('text-align: center;');
    expect(source.slice(marketStart, marketEnd)).toContain('variant="text"');
    expect(source.slice(marketStart, marketEnd)).toContain('size="sm"');
    expect(source).not.toContain('NavigationPanel');
    expect(source).not.toContain('skills-navigation');
    expect(source).not.toContain('titleListAll');
  });

  it('presents add skill as the same compact primary action used to create an agent', () => {
    const source = readSibling('./SkillsScene.tsx');
    const actionStart = source.indexOf('className="skills-controls__add"');
    const actionEnd = source.indexOf('</Button>', actionStart);
    const action = source.slice(actionStart, actionEnd);

    expect(actionStart).toBeGreaterThan(-1);
    expect(action).toContain('variant="primary"');
    expect(action).toContain('size="sm"');
    expect(action).toContain('leadingIcon={<Icon name="plus" size="sm" />}');
    expect(action).toContain("{t('toolbar.addTooltip')}");
  });

  it('lets the skills page inherit the surrounding scene surface', () => {
    const stylesheet = readSibling('./SkillsScene.scss');
    const listSurfaceStart = stylesheet.indexOf('.skills-main__table {');
    const listSurfaceEnd = stylesheet.indexOf('\n}', listSurfaceStart);

    expect(stylesheet).not.toContain('background: var(--openbitfun-color-surface-canvas);');
    expect(stylesheet.slice(listSurfaceStart, listSurfaceEnd)).not.toContain('background:');
    expect(stylesheet.slice(listSurfaceStart, listSurfaceEnd)).not.toContain('border:');
    expect(readSibling('./components/SkillCard.scss')).toContain('background: var(--openbitfun-color-action-quiet-hover);');
  });

  it('aligns the groups with the shared page frame', () => {
    const stylesheet = readSibling('./SkillsScene.scss');
    expect(stylesheet).toContain('.skills-page .skill-groups {');
    expect(stylesheet).toContain('--skill-groups-inline-inset: 0px;');
  });

  it('keeps skill items to two text lines and management actions in the detail view', () => {
    const source = readSibling('./SkillsScene.tsx');
    const stylesheet = readSibling('./components/SkillCard.scss');
    const card = readSibling('./components/SkillCard.tsx');

    expect(source.match(/<SkillCard\b/g)).toHaveLength(2);
    expect(card).toContain('className="skills-card__actions"');
    expect(source).not.toContain('data-openbitfun-part="installedCardDelete"');
    expect(card).not.toContain('lines={2}');
    expect(source).toContain('data-openbitfun-part="detailStatus"');
    expect(source).toContain('installed.handleGlobalSkillToggle(selectedInstalledSkill, event.target.checked)');
    expect(source).toContain('setDeleteTarget(selectedInstalledSkill)');
    expect(stylesheet).toContain("grid-template-areas: 'identity actions';");
    expect(stylesheet).toContain('.skills-card__actions {');
  });
});
