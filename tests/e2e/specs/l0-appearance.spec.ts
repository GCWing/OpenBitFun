/**
 * L0 Appearance spec: verifies the global Appearance runtime and settings flow.
 */

import { browser, expect, $ } from '@wdio/globals';
import { saveElementScreenshot, saveStepScreenshot } from '../helpers/screenshot-utils';

interface WindowRect {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function getWebDriverSessionId(): string {
  const sessionId = (browser as unknown as { sessionId?: string }).sessionId;
  if (!sessionId) throw new Error('WebDriver session id is unavailable');
  return sessionId;
}

function webDriverEndpoint(pathname: string): string {
  const port = Number(process.env.OPENBITFUN_E2E_WEBDRIVER_PORT || 4445);
  return `http://127.0.0.1:${port}${pathname}`;
}

async function readWebDriverWindowRect(): Promise<WindowRect> {
  const response = await fetch(webDriverEndpoint(`/session/${getWebDriverSessionId()}/window/rect`));
  if (!response.ok) {
    throw new Error(`Failed to read WebDriver window rect: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { value?: Partial<WindowRect> };
  const rect = payload.value;
  if (!rect || typeof rect.width !== 'number' || typeof rect.height !== 'number') {
    throw new Error(`WebDriver window rect response is invalid: ${JSON.stringify(payload)}`);
  }
  return {
    x: typeof rect.x === 'number' ? rect.x : undefined,
    y: typeof rect.y === 'number' ? rect.y : undefined,
    width: rect.width,
    height: rect.height,
  };
}

async function setWebDriverWindowRect(rect: Partial<WindowRect>): Promise<void> {
  const response = await fetch(webDriverEndpoint(`/session/${getWebDriverSessionId()}/window/rect`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rect),
  });
  if (!response.ok) {
    throw new Error(`Failed to set WebDriver window rect: ${response.status} ${await response.text()}`);
  }
}

async function performWebDriverWheel(x: number, y: number, deltaY: number): Promise<void> {
  const response = await fetch(webDriverEndpoint(`/session/${getWebDriverSessionId()}/actions`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [{
        type: 'wheel',
        id: 'miniapp-gallery-wheel',
        actions: [{ type: 'scroll', x, y, deltaX: 0, deltaY }],
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to perform WebDriver wheel action: ${response.status} ${await response.text()}`);
  }
}

async function waitForDisplayed(selector: string, timeout = 15000) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout });
  return element;
}

async function openAppearanceSettings(): Promise<void> {
  const existingPicker = await $('[data-testid="appearance-palette-select"]');
  if (await existingPicker.isDisplayed().catch(() => false)) {
    return;
  }

  const settingsItem = await waitForDisplayed('[data-testid="nav-footer-settings-item"]');
  await settingsItem.click();

  const themeConfiguration = await waitForDisplayed('[data-testid="nav-settings-theme-item"]');
  await themeConfiguration.click();

  await waitForDisplayed('[data-testid="settings-scene"]');
  await waitForDisplayed('[data-testid="appearance-palette-select"]');
}

async function selectAppearance(appearanceId: string): Promise<void> {
  await openAppearanceSettings();

  const picker = await $('[data-testid="appearance-palette-select"]');
  await picker.click();

  const option = await waitForDisplayed(
    `[data-testid="appearance-palette-option"][data-appearance-id="${appearanceId}"]`,
  );
  await option.click();

  await browser.waitUntil(async () => {
    return browser.execute((expectedId: string) => {
      return document.documentElement.getAttribute('data-openbitfun-appearance') === expectedId;
    }, appearanceId);
  }, {
    timeout: 10000,
    interval: 100,
    timeoutMsg: `Appearance runtime did not apply ${appearanceId}`,
  });
}

describe('L0 Appearance', () => {
  it('app should start with an active Appearance runtime', async () => {
    console.log('[L0] Starting Appearance tests...');
    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const root = document.documentElement;
        return document.readyState === 'complete'
          && root.getAttribute('data-openbitfun-appearance-root') === 'true'
          && root.getAttribute('data-openbitfun-appearance') !== null
          && root.getAttribute('data-openbitfun-appearance-mode') !== null;
      });
    }, {
      timeout: 20000,
      interval: 200,
      timeoutMsg: 'Appearance runtime did not become active after app startup',
    });

    const title = await browser.getTitle();
    expect(title).toBeDefined();
  });

  it('should expose the root Appearance contract', async () => {
    const appearance = await browser.execute(() => {
      const root = document.documentElement;
      return {
        id: root.getAttribute('data-openbitfun-appearance'),
        mode: root.getAttribute('data-openbitfun-appearance-mode'),
        revision: root.getAttribute('data-openbitfun-appearance-revision'),
        isRoot: root.getAttribute('data-openbitfun-appearance-root'),
      };
    });

    console.log('[L0] Appearance root contract:', appearance);
    expect(appearance.id).toBeTruthy();
    expect(['dark', 'light']).toContain(appearance.mode);
    expect(appearance.revision).toBeTruthy();
    expect(appearance.isRoot).toBe('true');
  });

  it('should expose compiled Appearance tokens', async () => {
    const appearanceStyles = await browser.execute(() => {
      const styles = window.getComputedStyle(document.documentElement);
      const appearanceVariables = Array.from(styles)
        .filter(property => property.startsWith('--openbitfun-color-'));

      return {
        variableCount: appearanceVariables.length,
        background: styles.getPropertyValue('--openbitfun-color-surface-canvas').trim(),
        text: styles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        accent: styles.getPropertyValue('--openbitfun-color-accent-default').trim(),
      };
    });

    console.log('[L0] Appearance token contract:', appearanceStyles);
    expect(appearanceStyles.variableCount).toBeGreaterThan(0);
    expect(appearanceStyles.background).not.toBe('');
    expect(appearanceStyles.text).not.toBe('');
    expect(appearanceStyles.accent).not.toBe('');
  });

  it('should project the neutral and navy light palette into the native app', async () => {
    await selectAppearance('openbitfun-light');

    const lightNavigation = await browser.execute(() => {
      const styles = window.getComputedStyle(document.documentElement);
      const navPanel = document.querySelector<HTMLElement>('[data-testid="nav-panel"]');
      return {
        primary: styles.getPropertyValue('--openbitfun-color-surface-canvas').trim(),
        scene: styles.getPropertyValue('--openbitfun-color-surface-scene').trim(),
        softSurface: styles.getPropertyValue('--openbitfun-color-action-secondary-background').trim(),
        text: styles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        mutedText: styles.getPropertyValue('--openbitfun-color-content-muted').trim(),
        accent: styles.getPropertyValue('--openbitfun-color-accent-default').trim(),
        primaryButton: styles.getPropertyValue('--openbitfun-color-action-primary-background').trim(),
        successBackground: styles.getPropertyValue('--openbitfun-color-status-success-surface').trim(),
        errorBackground: styles.getPropertyValue('--openbitfun-color-status-danger-surface').trim(),
        border: styles.getPropertyValue('--openbitfun-color-border-default').trim(),
        navBackground: navPanel ? window.getComputedStyle(navPanel).backgroundColor : null,
      };
    });

    expect(lightNavigation).toMatchObject({
      primary: '#fdfdfd',
      scene: '#ffffff',
      softSurface: '#f3f3f5',
      text: '#1c1c1f',
      mutedText: '#6a6a6a',
      accent: '#101a27',
      primaryButton: '#101a27',
      successBackground: '#e1fbe9',
      errorBackground: 'rgba(167, 67, 82, 0.12)',
      border: 'rgba(16, 26, 39, 0.15)',
      navBackground: 'rgb(253, 253, 253)',
    });
  });

  it('should compile inverse new-session hover colors for the light appearance', async () => {
    await selectAppearance('openbitfun-light');

    const hoverContract = await browser.execute(() => {
      const styleRules: CSSStyleRule[] = [];
      const collectStyleRules = (rules: CSSRuleList): void => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) {
            styleRules.push(rule);
          }
          if ('cssRules' in rule) {
            collectStyleRules((rule as CSSGroupingRule).cssRules);
          }
        }
      };

      for (const styleSheet of Array.from(document.styleSheets)) {
        try {
          collectStyleRules(styleSheet.cssRules);
        } catch {
          // Ignore stylesheets that the WebView does not expose through CSSOM.
        }
      }

      const hasSelector = (rule: CSSStyleRule, selector: string): boolean => {
        return rule.selectorText.split(',').some(candidate => candidate.trim() === selector);
      };
      const buttonRule = styleRules.find(rule => hasSelector(
        rule,
        '.openbitfun-nav-panel__utility-action:hover',
      ));
      const iconRule = styleRules.find(rule => hasSelector(
        rule,
        '.openbitfun-nav-panel__utility-action:hover > svg',
      ));
      const rootStyle = window.getComputedStyle(document.documentElement);

      return {
        appearanceMode: document.documentElement.getAttribute('data-openbitfun-appearance-mode'),
        textPrimary: rootStyle.getPropertyValue('--openbitfun-color-content-primary').trim(),
        scene: rootStyle.getPropertyValue('--openbitfun-color-surface-scene').trim(),
        buttonBackground: buttonRule?.style.background ?? null,
        buttonBorder: buttonRule?.style.borderColor ?? null,
        iconColor: iconRule?.style.color ?? null,
        iconStroke: iconRule?.style.stroke ?? null,
      };
    });

    expect(hoverContract).toMatchObject({
      appearanceMode: 'light',
      textPrimary: '#1c1c1f',
      scene: '#ffffff',
      buttonBackground: 'var(--openbitfun-color-content-primary)',
      buttonBorder: 'var(--openbitfun-color-content-primary)',
      iconColor: 'var(--openbitfun-color-surface-scene)',
      iconStroke: 'currentcolor',
    });
  });

  it('should lift only the scene viewport above the light navigation shell', async () => {
    await selectAppearance('openbitfun-light');
    await waitForDisplayed('.openbitfun-workspace-body__scene-area');
    await waitForDisplayed('.openbitfun-scene-viewport');

    const sceneSurface = await browser.execute(() => {
      const workbench = document.querySelector<HTMLElement>('.openbitfun-workspace-body');
      const sceneArea = document.querySelector<HTMLElement>('.openbitfun-workspace-body__scene-area');
      const viewport = document.querySelector<HTMLElement>('.openbitfun-scene-viewport');

      if (!workbench || !sceneArea || !viewport) {
        return null;
      }

      const workbenchStyle = window.getComputedStyle(workbench);
      const sceneStyle = window.getComputedStyle(sceneArea);
      const viewportStyle = window.getComputedStyle(viewport);

      return {
        workbenchBackground: workbenchStyle.backgroundColor,
        sceneBackground: sceneStyle.backgroundColor,
        sceneBorderWidth: sceneStyle.borderTopWidth,
        sceneRadius: sceneStyle.borderTopLeftRadius,
        sceneShadow: sceneStyle.boxShadow,
        viewportBackground: viewportStyle.backgroundColor,
        viewportBorderWidth: viewportStyle.borderTopWidth,
        viewportBorderColor: viewportStyle.borderTopColor,
        viewportRadius: viewportStyle.borderTopLeftRadius,
        viewportShadow: viewportStyle.boxShadow,
      };
    });

    expect(sceneSurface).not.toBeNull();
    expect(sceneSurface).toMatchObject({
      workbenchBackground: 'rgb(253, 253, 253)',
      sceneBackground: 'rgba(0, 0, 0, 0)',
      sceneBorderWidth: '0px',
      sceneRadius: '0px',
      sceneShadow: 'none',
      viewportBackground: 'rgb(255, 255, 255)',
      viewportBorderWidth: '1px',
      viewportRadius: '12px',
    });
    expect(sceneSurface?.viewportBorderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(sceneSurface?.viewportShadow).not.toBe('none');
    await saveStepScreenshot('l0-appearance-light-floating-scene');
  });

  it('should keep Mini Apps and the selected navigation surface visually light', async () => {
    await selectAppearance('openbitfun-light');

    const navBack = await waitForDisplayed(
      '[data-openbitfun-component="nav-bar"][data-openbitfun-part="back"]:not(.is-inactive)',
    );
    await navBack.click();

    const overviewEntry = await waitForDisplayed('[data-testid="nav-personal-overview"]');
    await overviewEntry.click();
    const miniAppsEntry = await waitForDisplayed('[data-testid="personal-overview-more-miniapps"]');
    await miniAppsEntry.click();
    await waitForDisplayed('[data-openbitfun-scene="miniapp-gallery"]');
    await waitForDisplayed('.miniapp-gallery-scene__tabs .openbitfun-tabs__tab--active');
    await waitForDisplayed('[data-openbitfun-component="mini-app-card"]', 20000);

    const miniAppPresentation = await browser.execute(() => {
      const selectedNavigation = document.querySelector<HTMLElement>('[data-testid="nav-personal-overview"]');
      const selectedTab = document.querySelector<HTMLElement>(
        '.miniapp-gallery-scene__tabs .openbitfun-tabs__tab--active',
      );
      const tabsNav = document.querySelector<HTMLElement>(
        '.miniapp-gallery-scene__tabs > .openbitfun-tabs__nav',
      );
      const tabsNavList = tabsNav?.querySelector<HTMLElement>('.openbitfun-tabs__nav-list') ?? null;
      const tabButtons = Array.from(
        tabsNavList?.querySelectorAll<HTMLElement>('.openbitfun-tabs__tab-button') ?? [],
      );
      const tabsContent = document.querySelector<HTMLElement>(
        '.miniapp-gallery-scene__tabs > .openbitfun-tabs__content',
      );
      const tabsContentView = tabsContent?.querySelector<HTMLElement>(
        ':scope > .openbitfun-tabs__content-view',
      ) ?? null;
      const galleryScroller = document.querySelector<HTMLElement>(
        '.miniapp-gallery .gallery-layout__body',
      );
      const scene = document.querySelector<HTMLElement>('[data-openbitfun-scene="miniapp-gallery"]');
      const pageHeader = document.querySelector<HTMLElement>('.miniapp-gallery .gallery-page-header');
      const pageHeaderTitle = pageHeader?.querySelector<HTMLElement>('.gallery-page-header__title') ?? null;
      const pageHeaderActions = pageHeader?.querySelector<HTMLElement>('.gallery-page-header__actions') ?? null;
      const card = document.querySelector<HTMLElement>('[data-openbitfun-component="mini-app-card"]');
      const cardFooter = card?.querySelector<HTMLElement>('.miniapp-card__footer') ?? null;
      const cardIcon = card?.querySelector<HTMLElement>('.miniapp-card__icon-area') ?? null;
      const cardDescription = card?.querySelector<HTMLElement>('.miniapp-card__desc') ?? null;
      const cardTags = card?.querySelector<HTMLElement>('.miniapp-card__tags') ?? null;
      const cardActions = card?.querySelector<HTMLElement>('.miniapp-card__actions') ?? null;
      const cardTagItems = Array.from(card?.querySelectorAll<HTMLElement>('.miniapp-card__tag') ?? []);
      const cardTagOverflowItems = Array.from(
        card?.querySelectorAll<HTMLElement>('.miniapp-card__tag-overflow') ?? [],
      );
      const cardPrimaryAction = card?.querySelector<HTMLElement>('.miniapp-card__action-btn--primary') ?? null;
      const importAction = document.querySelector<HTMLElement>('[data-testid="miniapp-import-action"]');
      const createAction = document.querySelector<HTMLElement>('[data-testid="miniapp-create-action"]');
      const emptyRunningZone = document.querySelector<HTMLElement>(
        '.miniapp-gallery__running-zone.is-empty',
      );

      return {
        selectedNavigation: selectedNavigation
          ? {
              background: window.getComputedStyle(selectedNavigation).backgroundColor,
              border: window.getComputedStyle(selectedNavigation).borderColor,
            }
          : null,
        selectedTabBackground: selectedTab
          ? window.getComputedStyle(selectedTab).backgroundColor
          : null,
        selectedTabColor: selectedTab ? window.getComputedStyle(selectedTab).color : null,
        sceneBackground: scene ? window.getComputedStyle(scene).backgroundColor : null,
        scrollLayout: tabsContent && tabsContentView && galleryScroller
          ? {
              contentHeight: tabsContent.getBoundingClientRect().height,
              contentViewHeight: tabsContentView.getBoundingClientRect().height,
              scrollerHeight: galleryScroller.getBoundingClientRect().height,
              scrollerClientHeight: galleryScroller.clientHeight,
              scrollerScrollHeight: galleryScroller.scrollHeight,
              scrollerOverflowY: window.getComputedStyle(galleryScroller).overflowY,
            }
          : null,
        upperLayout: tabsNav && tabsNavList && pageHeader && pageHeaderTitle && pageHeaderActions && emptyRunningZone
          ? (() => {
              const tabsNavRect = tabsNav.getBoundingClientRect();
              const tabsNavListRect = tabsNavList.getBoundingClientRect();
              const headerRect = pageHeader.getBoundingClientRect();
              const headerTitleRect = pageHeaderTitle.getBoundingClientRect();
              const headerActionsRect = pageHeaderActions.getBoundingClientRect();
              const runningRect = emptyRunningZone.getBoundingClientRect();
              const actionRects = Array.from(pageHeaderActions.children).map(child => (
                (child as HTMLElement).getBoundingClientRect()
              ));
              return {
                navHeight: tabsNavRect.height,
                tabGroupWidth: tabsNavListRect.width,
                tabGroupHeight: tabsNavListRect.height,
                tabButtonHeights: tabButtons.map(button => button.getBoundingClientRect().height),
                headerHeight: headerRect.height,
                headerRunningLeftDelta: Math.abs(headerTitleRect.left - runningRect.left),
                headerRunningRightDelta: Math.abs(headerActionsRect.right - runningRect.right),
                titleActionsTopDelta: Math.abs(headerTitleRect.top - headerActionsRect.top),
                actionHeights: actionRects.map(rect => rect.height),
                runningHeight: runningRect.height,
                navToRunningBottom: runningRect.bottom - tabsNavRect.bottom,
              };
            })()
          : null,
        headerActions: importAction && createAction
          ? {
              importBackground: window.getComputedStyle(importAction).backgroundColor,
              importColor: window.getComputedStyle(importAction).color,
              importLabel: importAction.getAttribute('aria-label'),
              createBackground: window.getComputedStyle(createAction).backgroundColor,
              createColor: window.getComputedStyle(createAction).color,
              createLabel: createAction.getAttribute('aria-label'),
            }
          : null,
        card: card
          ? (() => {
              const cardRect = card.getBoundingClientRect();
              const iconRect = cardIcon?.getBoundingClientRect() ?? null;
              const descriptionRect = cardDescription?.getBoundingClientRect() ?? null;
              const tagsRect = cardTags?.getBoundingClientRect() ?? null;
              const actionsRect = cardActions?.getBoundingClientRect() ?? null;
              const visibleTagItems = [...cardTagItems, ...cardTagOverflowItems].filter(tag => (
                window.getComputedStyle(tag).display !== 'none'
              ));
              const tagRects = visibleTagItems.map(tag => tag.getBoundingClientRect());
              return {
                background: window.getComputedStyle(card).backgroundColor,
                borderStyle: window.getComputedStyle(card).borderStyle,
                footerBackground: cardFooter ? window.getComputedStyle(cardFooter).backgroundColor : null,
                primaryActionBackground: cardPrimaryAction
                  ? window.getComputedStyle(cardPrimaryAction).backgroundColor
                  : null,
                neutralActionBackground: window.getComputedStyle(card)
                  .getPropertyValue('--openbitfun-color-action-neutral-surface')
                  .trim(),
                primaryActionLabel: cardPrimaryAction?.textContent?.trim() ?? '',
                width: cardRect.width,
                height: cardRect.height,
                iconWidth: iconRect?.width ?? null,
                iconHeight: iconRect?.height ?? null,
                descriptionActionGap: descriptionRect && actionsRect
                  ? actionsRect.top - descriptionRect.bottom
                  : null,
                tagsActionsCenterDelta: tagsRect && actionsRect
                  ? Math.abs(
                    tagsRect.top + tagsRect.height / 2 - (actionsRect.top + actionsRect.height / 2),
                  )
                  : null,
                tagCount: cardTagItems.length,
                visibleTagCount: tagRects.length,
                tagLineCount: new Set(tagRects.map(rect => Math.round(rect.top))).size,
                tagsVisible: tagsRect
                  ? cardTags!.scrollWidth <= cardTags!.clientWidth + 1
                    && tagRects.every(rect => (
                      rect.top >= tagsRect.top - 1
                      && rect.right <= tagsRect.right + 1
                      && rect.bottom <= tagsRect.bottom + 1
                      && rect.left >= tagsRect.left - 1
                    ))
                  : null,
                tagsOverlapActions: actionsRect
                  ? tagRects.some(rect => (
                    rect.left < actionsRect.right
                    && rect.right > actionsRect.left
                    && rect.top < actionsRect.bottom
                    && rect.bottom > actionsRect.top
                  ))
                  : null,
                actionsRightGap: actionsRect ? cardRect.right - actionsRect.right : null,
                actionsBottomGap: actionsRect ? cardRect.bottom - actionsRect.bottom : null,
              };
            })()
          : null,
      };
    });

    expect([
      'rgb(243, 243, 245)',
      'rgba(243, 243, 245, 1)',
    ]).toContain(miniAppPresentation.selectedNavigation?.background);
    expect(miniAppPresentation.selectedNavigation?.border).toBe('rgba(0, 0, 0, 0)');
    expect(miniAppPresentation.selectedTabBackground).toBe('rgb(16, 26, 39)');
    expect(miniAppPresentation.selectedTabColor).toBe('rgb(255, 255, 255)');
    expect(miniAppPresentation.sceneBackground).toBe('rgb(255, 255, 255)');
    expect(miniAppPresentation.scrollLayout).not.toBeNull();
    expect(miniAppPresentation.scrollLayout!.scrollerOverflowY).toBe('auto');
    expect(miniAppPresentation.scrollLayout!.contentViewHeight).toBeLessThanOrEqual(
      miniAppPresentation.scrollLayout!.contentHeight + 0.5,
    );
    expect(miniAppPresentation.scrollLayout!.scrollerHeight).toBeLessThanOrEqual(
      miniAppPresentation.scrollLayout!.contentHeight + 0.5,
    );
    expect(Math.abs(
      miniAppPresentation.scrollLayout!.contentViewHeight
      - miniAppPresentation.scrollLayout!.contentHeight,
    )).toBeLessThanOrEqual(0.5);
    expect(miniAppPresentation.upperLayout).not.toBeNull();
    expect(miniAppPresentation.upperLayout!.navHeight).toBeGreaterThanOrEqual(60);
    expect(miniAppPresentation.upperLayout!.navHeight).toBeLessThanOrEqual(80);
    expect(miniAppPresentation.upperLayout!.tabGroupWidth).toBeGreaterThanOrEqual(220);
    expect(miniAppPresentation.upperLayout!.tabGroupWidth).toBeLessThanOrEqual(300);
    expect(miniAppPresentation.upperLayout!.tabGroupHeight).toBeGreaterThanOrEqual(35);
    expect(miniAppPresentation.upperLayout!.tabGroupHeight).toBeLessThanOrEqual(37);
    expect(miniAppPresentation.upperLayout!.tabButtonHeights).toHaveLength(3);
    expect(miniAppPresentation.upperLayout!.tabButtonHeights.every(height => height === 30)).toBe(true);
    expect(miniAppPresentation.upperLayout!.headerHeight).toBeGreaterThanOrEqual(88);
    expect(miniAppPresentation.upperLayout!.headerHeight).toBeLessThanOrEqual(120);
    expect(miniAppPresentation.upperLayout!.headerRunningLeftDelta).toBeLessThanOrEqual(0.5);
    expect(miniAppPresentation.upperLayout!.headerRunningRightDelta).toBeLessThanOrEqual(0.5);
    expect(miniAppPresentation.upperLayout!.titleActionsTopDelta).toBeLessThanOrEqual(8);
    expect(miniAppPresentation.upperLayout!.actionHeights.every(height => (
      height >= 29.5 && height <= 34
    ))).toBe(true);
    expect(miniAppPresentation.upperLayout!.runningHeight).toBeGreaterThanOrEqual(57.5);
    expect(miniAppPresentation.upperLayout!.runningHeight).toBeLessThanOrEqual(60);
    expect(miniAppPresentation.upperLayout!.navToRunningBottom).toBeGreaterThanOrEqual(150);
    expect(miniAppPresentation.upperLayout!.navToRunningBottom).toBeLessThanOrEqual(190);
    expect(miniAppPresentation.headerActions).toMatchObject({
      importBackground: 'rgb(243, 243, 245)',
      createBackground: 'rgb(16, 26, 39)',
      createColor: 'rgb(255, 255, 255)',
    });
    expect(miniAppPresentation.headerActions?.importLabel?.length).toBeGreaterThan(0);
    expect(miniAppPresentation.headerActions?.createLabel?.length).toBeGreaterThan(0);
    expect(miniAppPresentation.headerActions?.importBackground).not.toBe(
      miniAppPresentation.headerActions?.createBackground,
    );
    expect(miniAppPresentation.card).not.toBeNull();
    expect(miniAppPresentation.card).toMatchObject({
      background: 'rgb(255, 255, 255)',
      borderStyle: 'solid',
      footerBackground: 'rgba(0, 0, 0, 0)',
    });
    expect(miniAppPresentation.card!.primaryActionBackground).toBe(
      miniAppPresentation.card!.neutralActionBackground,
    );
    expect(miniAppPresentation.card!.primaryActionBackground).not.toBe('rgb(16, 26, 39)');
    expect(miniAppPresentation.card!.width).toBeGreaterThanOrEqual(279.5);
    expect(miniAppPresentation.card!.width).toBeLessThanOrEqual(400.5);
    expect(miniAppPresentation.card!.height).toBeGreaterThanOrEqual(151.5);
    expect(miniAppPresentation.card!.height).toBeLessThanOrEqual(180);
    expect(miniAppPresentation.card!.iconWidth).toBeGreaterThanOrEqual(55.5);
    expect(miniAppPresentation.card!.iconWidth).toBeLessThanOrEqual(72.5);
    expect(Math.abs(
      miniAppPresentation.card!.iconHeight! - miniAppPresentation.card!.iconWidth!,
    )).toBeLessThanOrEqual(0.1);
    expect(miniAppPresentation.card!.primaryActionLabel.length).toBeGreaterThan(0);
    expect(miniAppPresentation.card!.descriptionActionGap).toBeGreaterThanOrEqual(8);
    expect(miniAppPresentation.card!.descriptionActionGap).toBeLessThanOrEqual(24);
    expect(miniAppPresentation.card!.tagCount).toBeGreaterThan(0);
    expect(miniAppPresentation.card!.visibleTagCount).toBeGreaterThan(0);
    expect(miniAppPresentation.card!.tagLineCount).toBe(1);
    expect(miniAppPresentation.card!.tagsVisible).toBe(true);
    expect(miniAppPresentation.card!.tagsOverlapActions).toBe(false);
    expect(miniAppPresentation.card!.actionsRightGap).toBeGreaterThanOrEqual(12);
    expect(miniAppPresentation.card!.actionsBottomGap).toBeGreaterThanOrEqual(11.5);
    expect(miniAppPresentation.card!.actionsBottomGap).toBeLessThanOrEqual(16.5);

    await saveElementScreenshot(
      '[data-openbitfun-component="mini-app-card"]',
      'l0-appearance-light-miniapp-card',
    );
    await saveElementScreenshot(
      '[data-openbitfun-scene="miniapp-gallery"]',
      'l0-appearance-light-miniapp-upper-layout',
    );
    await saveStepScreenshot('l0-appearance-light-miniapps');

    const originalWindowRect = await readWebDriverWindowRect();
    try {
      await setWebDriverWindowRect({ width: 900, height: 640 });
      await browser.waitUntil(async () => browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(
          '.miniapp-gallery .gallery-layout__body',
        );
        return Boolean(scroller && scroller.scrollHeight > scroller.clientHeight);
      }), {
        timeout: 5000,
        interval: 100,
        timeoutMsg: 'Mini App gallery did not become scrollable after the native window was reduced',
      });

      const miniAppScrollTarget = await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(
          '.miniapp-gallery .gallery-layout__body',
        );
        if (!scroller) return null;
        const rect = scroller.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + Math.min(rect.height / 2, 240)),
          before: scroller.scrollTop,
          maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
        };
      });
      expect(miniAppScrollTarget).not.toBeNull();
      expect(miniAppScrollTarget!.maxScrollTop).toBeGreaterThan(0);

      await performWebDriverWheel(miniAppScrollTarget!.x, miniAppScrollTarget!.y, 360);
      await browser.waitUntil(async () => browser.execute((before: number) => {
        const scroller = document.querySelector<HTMLElement>(
          '.miniapp-gallery .gallery-layout__body',
        );
        return Boolean(scroller && scroller.scrollTop > before);
      }, miniAppScrollTarget!.before), {
        timeout: 3000,
        interval: 50,
        timeoutMsg: 'Native wheel input did not move the Mini App gallery scroll container',
      });

      const miniAppScrollTop = await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(
          '.miniapp-gallery .gallery-layout__body',
        );
        const scrollTop = scroller?.scrollTop ?? 0;
        if (scroller) scroller.scrollTop = 0;
        return scrollTop;
      });
      expect(miniAppScrollTop).toBeGreaterThan(miniAppScrollTarget!.before);
    } finally {
      await setWebDriverWindowRect(originalWindowRect);
    }

    const miniAppHoverContract = await browser.execute(() => {
      const styleRules: CSSStyleRule[] = [];
      const collectStyleRules = (rules: CSSRuleList): void => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) styleRules.push(rule);
          if ('cssRules' in rule) collectStyleRules((rule as CSSGroupingRule).cssRules);
        }
      };

      for (const styleSheet of Array.from(document.styleSheets)) {
        try {
          collectStyleRules(styleSheet.cssRules);
        } catch {
          // Ignore stylesheets that the native WebView does not expose through CSSOM.
        }
      }

      const hasSelector = (rule: CSSStyleRule, selector: string): boolean => (
        rule.selectorText.split(',').some(candidate => candidate.trim() === selector)
      );
      const cardHoverRule = styleRules.find(rule => hasSelector(rule, '.miniapp-card:hover'));
      const actionHoverRule = styleRules.find(rule => hasSelector(
        rule,
        '.miniapp-card__action-btn--primary:hover',
      ));
      const deleteHoverRule = styleRules.find(rule => hasSelector(
        rule,
        '.miniapp-card__action-btn--danger:hover',
      ));
      const lightInverseRule = styleRules.find(rule => (
        rule.selectorText.includes('data-openbitfun-appearance')
        && rule.selectorText.includes('openbitfun-light')
        && rule.selectorText.includes('.miniapp-card')
      ));

      return {
        cardBackground: cardHoverRule?.style.backgroundColor ?? null,
        cardBorder: cardHoverRule?.style.borderColor ?? null,
        cardShadow: cardHoverRule?.style.boxShadow ?? null,
        cardTransform: cardHoverRule?.style.transform ?? null,
        primaryBackground: actionHoverRule?.style.background ?? null,
        primaryColor: actionHoverRule?.style.color ?? null,
        deleteBackground: deleteHoverRule?.style.background ?? null,
        deleteColor: deleteHoverRule?.style.color ?? null,
        lightInverseBackground: lightInverseRule?.style.getPropertyValue('--miniapp-card-inverse-bg') ?? null,
        lightInverseColor: lightInverseRule?.style.getPropertyValue('--miniapp-card-inverse-color') ?? null,
      };
    });
    expect(miniAppHoverContract).toEqual({
      cardBackground: 'var(--openbitfun-color-surface-subtle)',
      cardBorder: 'var(--openbitfun-color-border-default)',
      cardShadow: 'var(--openbitfun-shadow-sm)',
      cardTransform: 'translateY(-3px)',
      primaryBackground: 'var(--miniapp-card-inverse-bg)',
      primaryColor: 'var(--miniapp-card-inverse-color)',
      deleteBackground: 'var(--miniapp-card-inverse-bg)',
      deleteColor: 'var(--miniapp-card-inverse-color)',
      lightInverseBackground: 'var(--openbitfun-color-content-on-light)',
      lightInverseColor: 'var(--openbitfun-color-content-on-dark)',
    });

    const importAction = await $('[data-testid="miniapp-import-action"]');
    await importAction.click();
    const importMenu = await waitForDisplayed('[data-testid="miniapp-import-menu"]');
    expect(await importMenu.getAttribute('role')).toBe('menu');
    expect((await importMenu.$$('.miniapp-gallery__import-menu-item')).length).toBe(2);
    expect(await $('[data-testid="miniapp-import-folder-action"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="miniapp-import-package-action"]').isDisplayed()).toBe(true);
    await saveStepScreenshot('l0-appearance-light-miniapp-import-menu');
    await importAction.click();
    await importMenu.waitForDisplayed({ reverse: true });

    const createAction = await $('[data-testid="miniapp-create-action"]');
    expect(await createAction.isEnabled()).toBe(true);
    expect((await createAction.getAttribute('aria-label'))?.length).toBeGreaterThan(0);
  });

  it('should render monochrome structural chrome against a white workspace', async () => {
    await selectAppearance('openbitfun-monochrome');
    await browser.execute(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await waitForDisplayed('[data-testid="nav-panel"]');
    await waitForDisplayed('[data-testid="settings-nav"]');
    await waitForDisplayed('.openbitfun-scene-bar');
    await waitForDisplayed('.openbitfun-scene-viewport');

    const contrastPresentation = await browser.execute(() => {
      const rootStyles = window.getComputedStyle(document.documentElement);
      const bodyStyles = window.getComputedStyle(document.body);
      const workbench = document.querySelector<HTMLElement>('.openbitfun-workspace-body');
      const navPanel = document.querySelector<HTMLElement>('[data-testid="nav-panel"]');
      const settingsTitle = document.querySelector<HTMLElement>('.openbitfun-settings-nav__title');
      const settingsActiveItem = document.querySelector<HTMLElement>('.openbitfun-settings-nav__item.is-active');
      const settingsSectionBody = document.querySelector<HTMLElement>(
        '[data-testid="appearance-settings-section"] .openbitfun-config-page-section__body',
      );
      const settingsRows = document.querySelectorAll<HTMLElement>(
        '[data-testid="appearance-settings-section"] .openbitfun-config-page-row',
      );
      const settingsRowDivider = settingsRows.item(1);
      const appearanceSelect = document.querySelector<HTMLElement>(
        '[data-testid="appearance-palette-select"]',
      );
      const sceneBar = document.querySelector<HTMLElement>('.openbitfun-scene-bar');
      const viewport = document.querySelector<HTMLElement>('.openbitfun-scene-viewport');

      if (
        !workbench ||
        !navPanel ||
        !settingsTitle ||
        !settingsActiveItem ||
        !settingsSectionBody ||
        !settingsRowDivider ||
        !appearanceSelect ||
        !sceneBar ||
        !viewport
      ) {
        return null;
      }

      const workbenchStyles = window.getComputedStyle(workbench);
      const navStyles = window.getComputedStyle(navPanel);
      const sceneBarStyles = window.getComputedStyle(sceneBar);
      const viewportStyles = window.getComputedStyle(viewport);

      return {
        appearanceId: document.documentElement.getAttribute('data-openbitfun-appearance'),
        appearanceMode: document.documentElement.getAttribute('data-openbitfun-appearance-mode'),
        contentBackgroundToken: rootStyles.getPropertyValue('--openbitfun-color-surface-canvas').trim(),
        contentTextToken: rootStyles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        contentSecondaryTextToken: rootStyles.getPropertyValue('--openbitfun-color-content-secondary').trim(),
        contentBorderToken: rootStyles.getPropertyValue('--openbitfun-color-border-subtle').trim(),
        contentSurfaceToken: rootStyles.getPropertyValue('--openbitfun-color-surface-subtle').trim(),
        configSectionBackgroundToken: rootStyles.getPropertyValue('--openbitfun-component-config-page-section-background').trim(),
        configSectionBorderToken: rootStyles.getPropertyValue('--openbitfun-component-config-page-section-border').trim(),
        configSectionBorderWidthToken: rootStyles.getPropertyValue('--openbitfun-component-config-page-section-border-width').trim(),
        configDividerToken: rootStyles.getPropertyValue('--openbitfun-component-config-page-divider').trim(),
        chromeBackgroundToken: navStyles.getPropertyValue('--openbitfun-color-surface-canvas').trim(),
        chromeTextToken: navStyles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        bodyBackground: bodyStyles.backgroundColor,
        workbenchBackground: workbenchStyles.backgroundColor,
        navBackground: navStyles.backgroundColor,
        navTextToken: navStyles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        settingsTitleColor: window.getComputedStyle(settingsTitle).color,
        settingsActiveItemColor: window.getComputedStyle(settingsActiveItem).color,
        settingsSectionBackground: window.getComputedStyle(settingsSectionBody).backgroundColor,
        settingsSectionBorder: window.getComputedStyle(settingsSectionBody).borderTopColor,
        settingsSectionBorderWidth: window.getComputedStyle(settingsSectionBody).borderTopWidth,
        settingsSectionShadow: window.getComputedStyle(settingsSectionBody).boxShadow,
        settingsRowDivider: window.getComputedStyle(settingsRowDivider).borderTopColor,
        appearanceSelectBorder: window.getComputedStyle(appearanceSelect).borderTopColor,
        sceneBarTextToken: sceneBarStyles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        viewportBackground: viewportStyles.backgroundColor,
        viewportTextToken: viewportStyles.getPropertyValue('--openbitfun-color-content-primary').trim(),
        viewportRadius: viewportStyles.borderTopLeftRadius,
      };
    });

    expect(contrastPresentation).toEqual({
      appearanceId: 'openbitfun-monochrome',
      appearanceMode: 'light',
      contentBackgroundToken: '#ffffff',
      contentTextToken: '#1c1c1f',
      contentSecondaryTextToken: '#555555',
      contentBorderToken: 'rgba(16, 26, 39, 0.08)',
      contentSurfaceToken: 'rgba(16, 26, 39, 0.03)',
      configSectionBackgroundToken: '#f3f3f5',
      configSectionBorderToken: 'transparent',
      configSectionBorderWidthToken: '0',
      configDividerToken: 'rgba(16, 26, 39, 0.08)',
      chromeBackgroundToken: '#1c1c1f',
      chromeTextToken: '#f3f3f5',
      bodyBackground: 'rgb(28, 28, 31)',
      workbenchBackground: 'rgb(28, 28, 31)',
      navBackground: 'rgb(28, 28, 31)',
      navTextToken: '#f3f3f5',
      settingsTitleColor: 'rgb(243, 243, 245)',
      settingsActiveItemColor: 'rgb(243, 243, 245)',
      settingsSectionBackground: 'rgb(243, 243, 245)',
      settingsSectionBorder: 'rgba(0, 0, 0, 0)',
      settingsSectionBorderWidth: '0px',
      settingsSectionShadow: 'none',
      settingsRowDivider: 'rgba(16, 26, 39, 0.08)',
      appearanceSelectBorder: 'rgba(16, 26, 39, 0.15)',
      sceneBarTextToken: '#f3f3f5',
      viewportBackground: 'rgb(255, 255, 255)',
      viewportTextToken: '#1c1c1f',
      viewportRadius: '12px',
    });
    await saveStepScreenshot('l0-appearance-monochrome-contrast');
  });

  it('should expose the Appearance selector in settings', async () => {
    await openAppearanceSettings();

    const section = await $('[data-testid="appearance-settings-section"]');
    const picker = await $('[data-testid="appearance-palette-select"]');
    expect(await section.isDisplayed()).toBe(true);
    expect(await picker.isDisplayed()).toBe(true);
  });

  it('should keep the Skin market and appearance package import entry points hidden', async () => {
    await openAppearanceSettings();
    await waitForDisplayed('[data-openbitfun-part="packageSection"]');

    const packageEntryPoints = await browser.execute(() => ({
      actionButtons: Array.from(document.querySelectorAll<HTMLElement>(
        '[data-openbitfun-part="packageActions"] [data-openbitfun-component="button"]',
      )).map(button => button.textContent?.trim() ?? ''),
      fileInputs: document.querySelectorAll('.appearance-package-config__file-input').length,
    }));

    expect(packageEntryPoints.actionButtons).toEqual([]);
    expect(packageEntryPoints.fileInputs).toBe(0);

    await saveElementScreenshot(
      '[data-openbitfun-part="packageSection"]',
      'l0-appearance-package-entry-points-hidden',
    );
  });

  it('should switch to another built-in Appearance', async () => {
    await openAppearanceSettings();

    const before = await browser.execute(() => ({
      id: document.documentElement.getAttribute('data-openbitfun-appearance'),
      revision: document.documentElement.getAttribute('data-openbitfun-appearance-revision'),
    }));

    const picker = await $('[data-testid="appearance-palette-select"]');
    await picker.click();

    await browser.waitUntil(async () => {
      const options = await $$('[data-testid="appearance-palette-option"]');
      return await options.length >= 2;
    }, {
      timeout: 10000,
      interval: 100,
      timeoutMsg: 'Appearance options did not open',
    });

    const options = await $$('[data-testid="appearance-palette-option"]');
    let targetId: string | null = null;
    for (const option of options) {
      const optionId = await option.getAttribute('data-appearance-id');
      if (optionId && optionId !== 'system' && optionId !== before.id) {
        targetId = optionId;
        await option.click();
        break;
      }
    }

    expect(targetId).toBeTruthy();
    await browser.waitUntil(async () => {
      return browser.execute((expectedId: string) => {
        return document.documentElement.getAttribute('data-openbitfun-appearance') === expectedId;
      }, targetId!);
    }, {
      timeout: 10000,
      interval: 100,
      timeoutMsg: `Appearance runtime did not apply ${targetId}`,
    });

    const after = await browser.execute(() => {
      const root = document.documentElement;
      const styles = window.getComputedStyle(root);
      return {
        id: root.getAttribute('data-openbitfun-appearance'),
        mode: root.getAttribute('data-openbitfun-appearance-mode'),
        revision: root.getAttribute('data-openbitfun-appearance-revision'),
        background: styles.getPropertyValue('--openbitfun-color-surface-canvas').trim(),
      };
    });

    console.log('[L0] Appearance switched:', { before, after });
    expect(after.id).toBe(targetId);
    expect(['dark', 'light']).toContain(after.mode);
    expect(after.revision).toBeTruthy();
    expect(after.background).not.toBe('');
  });

  after(() => {
    console.log('[L0] Appearance tests complete');
  });
});
