import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

function readRelative(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(filename, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

const cardCss = compile(fileURLToPath(new URL('./MiniAppCard.scss', import.meta.url))).css;

describe('Mini App card presentation', () => {
  it('keeps destructive actions in details and a unified app list', () => {
    const library = readRelative('../views/MiniAppLibraryView.tsx');

    expect(readRelative('./MiniAppCard.tsx')).not.toContain('name="delete"');
    expect(library).not.toContain('miniapp-running-zone');
    expect(library).not.toContain('gallery-zone-badge');
  });

  it('keeps installed, marketplace, and creation tabs in the shared gallery', () => {
    const library = readRelative('../views/MiniAppLibraryView.tsx');
    const submissions = readRelative('../views/MiniAppSubmissionsView.tsx');
    const tabs = readRelative('../MiniAppGalleryScene.tsx');

    expect(library).toContain('className="miniapp-gallery__filters"');
    expect(library).toContain('className="miniapp-gallery__categories"');
    expect(library).not.toContain('<SegmentedControl');
    expect(library).toContain(
      'buildMiniAppLibraryItems(marketItems, apps, marketOrigins, sort)',
    );
    expect(library).toContain('<MiniAppLibraryRow');
    expect(library).toContain('<MiniAppInstalledCard');
    expect(library).not.toContain('<MiniAppCard');
    expect(tabs).toContain('<TabGroup');
    expect(tabs).not.toContain('distribution="fill"');
    expect(tabs).toContain('size="sm"');
    expect(tabs).toContain("type MiniAppGalleryTab = 'installed' | 'market' | 'submissions';");
    expect(tabs).not.toContain('MiniAppMarketView');
    expect(submissions).toContain('<Disclosure');
    expect(submissions).toContain('<IconButton');
    expect(submissions).not.toContain('miniapp-submissions__advanced-toggle');
  });

  it('keeps both gallery panes on the home page content frame', () => {
    const sceneStyles = readRelative('../MiniAppGalleryScene.scss');
    const gallery = readRelative('../views/MiniAppLibraryView.tsx');
    const submissions = readRelative('../views/MiniAppSubmissionsView.tsx');
    const submissionStyles = readRelative('../views/MiniAppSubmissionsView.scss');

    expect(gallery).toContain('className="miniapp-gallery-pane miniapp-gallery"');
    expect(submissions.match(/className="miniapp-gallery-pane miniapp-submissions"/g)).toHaveLength(1);
    expect(submissions.match(/<GalleryPageHeader/g)).toHaveLength(1);
    expect(sceneStyles).toContain("@use '@/infrastructure/config/components/common/config-page-layout.tokens' as configLayout;");
    expect(sceneStyles).not.toContain('880px');
    expect(sceneStyles).not.toContain('width: calc(');
    expect(sceneStyles).toMatch(
      /\.miniapp-gallery-pane \{[\s\S]*?\.gallery-page-header \{[\s\S]*?@include configLayout\.content-frame;/,
    );
    expect(sceneStyles).toMatch(
      /\.miniapp-gallery-pane \{[\s\S]*?\.gallery-zones \{[\s\S]*?@include configLayout\.content-frame;/,
    );
    expect(sceneStyles).toMatch(/\.miniapp-gallery-tabs \{\s*@include configLayout\.content-frame;/);
    expect(sceneStyles).toMatch(/\.miniapp-submissions \.gallery-empty \{\s*@include configLayout\.content-frame;/);
    expect(sceneStyles).toContain('scrollbar-gutter: stable;');
    expect(submissionStyles).not.toContain('1360px');
    expect(submissionStyles).toMatch(/&__workspace \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('uses the compact vertical catalog-card geometry', () => {
    const stylesheet = readRelative('./MiniAppCard.scss');
    const rootStart = stylesheet.indexOf('.miniapp-card {');
    const rootEnd = stylesheet.indexOf('&:hover {', rootStart);
    const rootGeometry = stylesheet.slice(rootStart, rootEnd);

    expect(rootGeometry).not.toContain('max-width:');
    expect(rootGeometry).toContain('min-height: 193px;');
    expect(rootGeometry).not.toContain('aspect-ratio:');
    expect(stylesheet).toMatch(/&__main \{[\s\S]*?flex-direction: column;/);
    expect(stylesheet).toContain('-webkit-line-clamp: 3;');
    expect(stylesheet).toMatch(/&__footer \{[\s\S]*?margin-top: auto;/);
  });

  it('matches the home device grid and keeps preview-card skeletons aligned', () => {
    const source = readRelative('../views/MiniAppLibraryView.tsx');
    const stylesheet = readRelative('../views/MiniAppLibraryView.scss');
    const sceneStyles = readRelative('../MiniAppGalleryScene.scss');

    expect(source).toContain('<MarketList className={libraryListClassName} role="list"');
    expect(source).not.toContain('minCardWidth={640}');
    expect(stylesheet).toMatch(/&__list \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?gap: var\(--openbitfun-space-4\);/);
    expect(stylesheet).toMatch(
      /&__list\.gallery-grid--skeleton \{[\s\S]*?height: auto;[\s\S]*?aspect-ratio: 16 \/ 9;/,
    );
    expect(sceneStyles).toContain('container-name: miniapp-gallery-scene;');
    expect(sceneStyles).toMatch(
      /\.gallery-page-header \{[\s\S]*?flex-direction: column;/,
    );
    expect(stylesheet).toMatch(
      /@container miniapp-gallery-scene \(max-width: 600px\) \{\s*\.miniapp-gallery__list \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(stylesheet).toContain('border-radius: var(--openbitfun-layout-card-radius-lg);');
    expect(stylesheet).not.toContain('grid-template-columns: minmax(0, 224px) minmax(0, 1fr);');
  });

  it('groups catalog controls below the tabs without repeating the page heading', () => {
    const source = readRelative('../views/MiniAppLibraryView.tsx');
    const headerStart = source.indexOf('<GalleryPageHeader');
    const tabsStart = source.indexOf('{tabs}', headerStart);
    const allAppsStart = source.indexOf('<section className="gallery-zone"', tabsStart);
    const allAppsEnd = source.indexOf('</section>', allAppsStart);
    const pageHeader = source.slice(headerStart, tabsStart);
    const allAppsZone = source.slice(allAppsStart, allAppsEnd);

    expect(pageHeader).not.toContain('<SearchField');
    expect(allAppsZone).toContain("aria-label={t('allApps')}");
    expect(allAppsZone).toMatch(
      /miniapp-gallery__filters[\s\S]*?<SearchField[\s\S]*?miniapp-gallery__categories[\s\S]*?miniapp-gallery__sort/,
    );
  });

  it('aligns identity, runtime state, and icon metadata with their owning rows', () => {
    const row = readRelative('./MiniAppLibraryRow.tsx');
    const stylesheet = readRelative('../views/MiniAppLibraryView.scss');
    const titleStart = row.indexOf('className="miniapp-library-row__title-row"');
    const titleEnd = row.indexOf('</span>', titleStart);
    const titleRow = row.slice(titleStart, titleEnd);
    const actionsStart = row.indexOf('className="miniapp-library-row__actions"');
    const actions = row.slice(actionsStart);

    expect(titleRow.indexOf('miniapp-library-row__name')).toBeLessThan(
      titleRow.indexOf('miniapp-library-row__category'),
    );
    expect(actions.indexOf('miniapp-library-row__status-rail')).toBeLessThan(
      actions.indexOf('<Button'),
    );
    expect(row).toContain('<Package size={13}');
    expect(row).toContain('<UserRound size={13}');
    expect(row).toContain('<Star size={13}');
    expect(row).toContain('<Icon name="arrow-down" size="xs"');
    expect(row).toContain('<HardDrive size={13}');
    expect(stylesheet).toMatch(
      /&__summary \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) var\(--openbitfun-type-meta-line-height\);[\s\S]*?block-size: 126px;[\s\S]*?padding: var\(--openbitfun-space-3\) var\(--openbitfun-space-5\);/,
    );
    expect(stylesheet).toMatch(
      /&__meta \{[\s\S]*?align-self: end;[\s\S]*?block-size: var\(--openbitfun-type-meta-line-height\);/,
    );
    expect(stylesheet).toMatch(
      /&__actions \{[\s\S]*?align-self: end;[\s\S]*?align-items: center;/,
    );
    expect(stylesheet).not.toContain("content: '·';");
  });

  it('keeps local-only and installed status tags mutually exclusive', () => {
    const source = readRelative('../views/MiniAppLibraryView.tsx');
    const statusesStart = source.indexOf('function libraryStatuses(');
    const statusesEnd = source.indexOf('\nfunction requiresWorkspace', statusesStart);
    const statusPolicy = source.slice(statusesStart, statusesEnd);

    expect(statusPolicy).toContain(
      'const isLocalOnly = Boolean(item.app && !item.listing && !item.origin);',
    );
    expect(statusPolicy).toMatch(
      /else if \(isLocalOnly\) \{[\s\S]*?market\.library\.local[\s\S]*?\} else if \(item\.app\) \{[\s\S]*?market\.library\.installed/,
    );
  });

  it('uses local rating and download defaults for sorting without displaying them', () => {
    const source = readRelative('../views/MiniAppLibraryView.tsx');
    const projection = readRelative('../views/miniAppLibraryItems.ts');

    expect(projection).toMatch(
      /action: 'open',[\s\S]*?downloadCount: 0,[\s\S]*?ratingAverage: 3,/,
    );
    expect(source).toMatch(
      /downloadCount=\{item\.listing\s*\? formatNumber\(item\.downloadCount\)\s*: undefined\}/,
    );
    expect(source).toMatch(
      /rating=\{item\.listing \? item\.ratingAverage\.toFixed\(1\) : undefined\}/,
    );
  });

  it('crops marketplace images into one fixed showcase slot with a neutral fallback', () => {
    const row = readRelative('./MiniAppLibraryRow.tsx');
    const library = readRelative('../views/MiniAppLibraryView.tsx');
    const stylesheet = readRelative('../views/MiniAppLibraryView.scss');

    expect(library).toContain('getMiniAppShowcaseAsset(item.app.id)');
    expect(row).toMatch(/<MarketImage\s+source=\{showcaseUrl\}\s+responsive/);
    expect(row).toContain('<GalleryHorizontalEnd');
    expect(row).not.toContain('renderMiniAppIcon');
    expect(row).not.toContain('getMiniAppIconGradient');
    expect(stylesheet).toMatch(
      /&__showcase \{[\s\S]*?aspect-ratio: 16 \/ 9;[\s\S]*?overflow: hidden;/,
    );
    expect(stylesheet).toMatch(
      /&__showcase[\s\S]*?img \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: cover;[\s\S]*?object-position: center;/,
    );
  });

  it('keeps tags and the circular run action on one footer row', () => {
    const stylesheet = readRelative('./MiniAppCard.scss');
    const footer = cardCss.match(/\.miniapp-card__footer \{([^}]+)\}/)?.[1];
    const actionsStart = stylesheet.lastIndexOf('&__actions {');
    const actions = stylesheet.slice(actionsStart, stylesheet.indexOf('}', actionsStart));
    const source = readRelative('./MiniAppCard.tsx');

    expect(footer).toContain('margin-top: auto;');
    expect(footer).not.toContain('flex-wrap: wrap;');
    expect(footer).not.toContain('grid-template-columns:');
    expect(actions).toContain('margin-inline-start: auto;');
    expect(actions).toContain('flex: 0 0 auto;');
    expect(actions).not.toContain('grid-column:');
    expect(source).toContain('shape="circle"');
    expect(source).toContain('variant="primary"');
  });

  it('keeps version and tags in a clipped single-line metadata rail', () => {
    const tags = cardCss.match(/\.miniapp-card__tags \{([^}]+)\}/)?.[1];
    const tag = cardCss.match(/\.miniapp-card__tag \{([^}]+)\}/)?.[1];
    const source = readRelative('./MiniAppCard.tsx');

    expect(tags).toContain('flex: 1 1 auto;');
    expect(tags).toContain('overflow: hidden;');
    expect(tags).toContain('white-space: nowrap;');
    expect(tag).toContain('display: block;');
    expect(tag).toContain('flex: 0 1 auto;');
    expect(tag).toContain('box-sizing: border-box;');
    expect(tag).not.toContain('text-overflow: ellipsis;');
    expect(source).toContain('V{marketReleaseNumber ?? app.version}');
    expect(source).toContain('localizedTags.slice(0, 4)');
  });

  it('keeps App Store actions inline and never auto-opens after install or update', () => {
    const source = readRelative('../views/MiniAppLibraryView.tsx');
    const row = readRelative('./MiniAppLibraryRow.tsx');

    expect(source).toContain("item.action === 'get'");
    expect(source).toContain("item.action === 'update'");
    expect(source).toContain("item.action === 'open'");
    expect(source).toContain('setMarketOrigin(result.app.id, result.origin);');
    expect(source).not.toContain('openInstalledApp(result.app.id)');
    expect(row).toContain("variant={action === 'open' ? 'outline' : 'primary'}");
  });
});
