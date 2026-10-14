import { browser, $ } from '@wdio/globals';
import { BasePage } from './BasePage';

export class MiniAppsPage extends BasePage {
  private appAttribute(appId: string): string {
    return `[data-miniapp-id="${appId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  }

  private installedCard(appId: string): string {
    return `[data-openbitfun-component="mini-app-card"]${this.appAttribute(appId)}`;
  }

  private runningCard(appId: string): string {
    return `[data-testid="miniapp-running-zone"] ${this.installedCard(appId)}`;
  }

  private runner(appId: string): string {
    return `[data-openbitfun-scene="miniapp"]${this.appAttribute(appId)}`;
  }

  private detailDialog(): string {
    return '[data-testid="miniapp-detail-dialog"]';
  }

  private detailRoot(appId: string): string {
    return `${this.detailDialog()} ${this.appAttribute(appId)}`;
  }

  private overviewActivity(appId: string): string {
    return `[data-testid="personal-overview-miniapp-activity"]${this.appAttribute(appId)}`;
  }

  private async ensureGlobalNavigation(): Promise<void> {
    const overviewEntry = await $('[data-testid="nav-personal-overview"]');
    if (await overviewEntry.isDisplayed()) return;

    const sessionTab = await this.waitForElement('[role="tab"][data-scene-id="session"]', 10000);
    await sessionTab.waitForClickable({ timeout: 10000 });
    await sessionTab.click();
    await overviewEntry.waitForDisplayed({ timeout: 10000 });
  }

  async openOverview(): Promise<void> {
    await this.ensureGlobalNavigation();
    await this.clickByTestId('nav-personal-overview', 20000);
    await this.waitForElement('[data-openbitfun-scene="personal-overview"][data-openbitfun-part="miniApps"][data-catalog-status="ready"]', 20000);
  }

  async openGallery(): Promise<void> {
    await this.openOverview();
    await this.clickByTestId('personal-overview-more-miniapps', 20000);
    await this.waitForElement('[data-openbitfun-scene="miniapp-gallery"]', 20000);
    await this.waitForElement('[data-testid="miniapp-running-zone"]', 20000);
  }

  async startApp(appId: string): Promise<void> {
    const card = await this.waitForElement(this.installedCard(appId), 30000);
    const start = await card.$('.miniapp-card__action-btn--primary');
    await start.waitForClickable({ timeout: 10000 });
    await start.click();
    await this.waitForElement(this.runner(appId), 20000);
  }

  async openDetails(appId: string): Promise<WebdriverIO.Element> {
    const card = await this.waitForElement(this.installedCard(appId), 30000);
    await card.waitForClickable({ timeout: 10000 });
    await card.click();
    await this.waitForElement(this.detailRoot(appId), 10000);
    return this.waitForElement(this.detailDialog(), 10000);
  }

  async closeDetails(): Promise<void> {
    const close = await this.waitForTestId('miniapp-detail-close', 10000);
    await close.waitForClickable({ timeout: 10000 });
    await close.click();
    await close.waitForDisplayed({ reverse: true, timeout: 10000 });
  }

  async getDetailCapabilityKinds(): Promise<string[]> {
    const capabilities = await browser.$$('[data-testid="miniapp-detail-capability"][data-capability]');
    const kinds: string[] = [];
    const count = await capabilities.length;
    for (let index = 0; index < count; index += 1) {
      const kind = await capabilities[index].getAttribute('data-capability');
      if (!kind) {
        throw new Error('MiniApp detail capability is missing data-capability');
      }
      kinds.push(kind);
    }
    return kinds;
  }

  async startFromDetails(appId: string): Promise<void> {
    await this.waitForElement(this.detailRoot(appId), 10000);
    const detail = await this.waitForElement(this.detailDialog(), 10000);
    const start = await detail.$('[data-testid="miniapp-detail-primary-action"]');
    await start.waitForClickable({ timeout: 10000 });
    await start.click();
    await this.waitForElement(this.runner(appId), 20000);
  }

  async waitForOverviewActivity(appId: string): Promise<WebdriverIO.Element> {
    await this.openOverview();
    return this.waitForElement(this.overviewActivity(appId), 10000);
  }

  async getOverviewActivityIds(): Promise<string[]> {
    await this.openOverview();
    const items = await browser.$$('[data-testid="personal-overview-miniapp-activity"]');
    const ids: string[] = [];
    const count = await items.length;
    for (let index = 0; index < count; index += 1) {
      const appId = await items[index].getAttribute('data-miniapp-id');
      if (!appId) {
        throw new Error('MiniApp activity item is missing data-miniapp-id');
      }
      ids.push(appId);
    }
    return ids;
  }

  async getOverviewActivityHorizontalBounds(): Promise<Array<{ x: number; width: number }>> {
    const items = await browser.$$('[data-testid="personal-overview-miniapp-activity"]');
    const bounds: Array<{ x: number; width: number }> = [];
    const count = await items.length;
    for (let index = 0; index < count; index += 1) {
      bounds.push({
        x: await items[index].getLocation('x'),
        width: await items[index].getSize('width'),
      });
    }
    return bounds;
  }

  async returnToGallery(): Promise<void> {
    await this.openGallery();
  }

  async waitForRunningCard(appId: string): Promise<WebdriverIO.Element> {
    return this.waitForElement(this.runningCard(appId), 10000);
  }

  async getRunningCardIds(): Promise<string[]> {
    const cards = await browser.$$(
      '[data-testid="miniapp-running-zone"] [data-openbitfun-component="mini-app-card"][data-miniapp-id]',
    );
    const ids: string[] = [];
    const count = await cards.length;
    for (let index = 0; index < count; index += 1) {
      const appId = await cards[index].getAttribute('data-miniapp-id');
      if (!appId) {
        throw new Error('Running MiniApp card is missing data-miniapp-id');
      }
      ids.push(appId);
    }
    return ids;
  }

  async stopApp(appId: string): Promise<void> {
    const card = await this.waitForRunningCard(appId);
    const stop = await card.$('.miniapp-card__action-btn--stop');
    await stop.waitForClickable({ timeout: 10000 });
    await stop.click();
  }

  async ensureAppStopped(appId: string): Promise<void> {
    await this.openGallery();
    const card = await $(this.runningCard(appId));
    if (!await card.isDisplayed()) return;
    await this.stopApp(appId);
    await this.waitForStopped(appId);
  }

  async waitForStopped(appId: string): Promise<void> {
    const selectors = [this.runner(appId), this.runningCard(appId)];
    await browser.waitUntil(async () => {
      const states = await Promise.all(selectors.map(async (selector) => {
        const element = await $(selector);
        return element.isExisting();
      }));
      return states.every((exists) => !exists);
    }, {
      timeout: 10000,
      interval: 100,
      timeoutMsg: `MiniApp ${appId} remained active after Stop`,
    });
    await this.openOverview();
    const overviewActivity = await $(this.overviewActivity(appId));
    await overviewActivity.waitForExist({ reverse: true, timeout: 10000 });
  }
}

export default MiniAppsPage;
