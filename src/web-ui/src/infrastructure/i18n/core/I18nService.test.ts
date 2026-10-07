import { describe, expect, it, vi } from 'vitest';

import { I18nService } from './I18nService';
import { DEFAULT_LOCALE, WEB_UI_BOOTSTRAP_NAMESPACES } from '../presets';

describe('I18nService shared namespace contract', () => {
  it('keeps bootstrap translations available synchronously after construction', () => {
    const service = new I18nService();

    expect(service.t('common:actions.copy')).not.toBe('common:actions.copy');
  });

  it('keeps shared terms explicit so surface namespaces retain priority', () => {
    const service = new I18nService();
    const i18n = service.getI18nInstance();
    const locale = service.getCurrentLocale();

    i18n.addResource(locale, 'common', 'overrideProbe', 'surface label');
    i18n.addResource(locale, 'shared', 'overrideProbe', 'shared label');
    i18n.addResource(locale, 'shared', 'sharedOnlyProbe', 'shared-only label');

    expect(service.t('overrideProbe')).toBe('surface label');
    expect(service.t('shared:overrideProbe')).toBe('shared label');
    expect(service.t('sharedOnlyProbe')).toBe('sharedOnlyProbe');
    expect(service.t('shared:sharedOnlyProbe')).toBe('shared-only label');
  });

  it('uses the generated locale fallback chain before the global fallback locale', async () => {
    const service = new I18nService();
    const i18n = service.getI18nInstance();

    i18n.addResource('zh-CN', 'common', 'fallbackProbe', 'simplified fallback');
    i18n.addResource('en-US', 'common', 'fallbackProbe', 'english fallback');
    await i18n.changeLanguage('zh-TW');

    expect(service.t('fallbackProbe')).toBe('simplified fallback');
  });

  it('keeps non-bootstrap web-ui namespaces out of the startup resource bundle', async () => {
    const service = new I18nService();
    const i18n = service.getI18nInstance();

    for (const namespace of WEB_UI_BOOTSTRAP_NAMESPACES) {
      expect(i18n.hasResourceBundle(DEFAULT_LOCALE, namespace)).toBe(true);
    }
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, 'settings/application')).toBe(false);

    await service.loadNamespace('settings/application');

    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, 'settings/application')).toBe(true);
  });

  it('applies an externally persisted locale without persisting it again', async () => {
    vi.stubGlobal('document', {
      documentElement: { setAttribute: vi.fn() },
    });
    const service = new I18nService();
    const saveCurrentLocale = vi.spyOn(
      service as unknown as { saveCurrentLocale(locale: string): Promise<void> },
      'saveCurrentLocale',
    ).mockResolvedValue(undefined);

    await service.applyPersistedLanguage('zh-TW');

    expect(service.getCurrentLocale()).toBe('zh-TW');
    expect(saveCurrentLocale).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('commits a user language change before applying the local presentation fallback', async () => {
    vi.stubGlobal('document', {
      documentElement: { setAttribute: vi.fn() },
    });
    const service = new I18nService();
    const initialLocale = service.getCurrentLocale();
    const saveCurrentLocale = vi.spyOn(
      service as unknown as { saveCurrentLocale(locale: string): Promise<void> },
      'saveCurrentLocale',
    ).mockImplementation(async () => {
      expect(service.getCurrentLocale()).toBe(initialLocale);
    });

    await service.changeLanguage('zh-TW');

    expect(saveCurrentLocale).toHaveBeenCalledWith('zh-TW');
    expect(service.getCurrentLocale()).toBe('zh-TW');
    vi.unstubAllGlobals();
  });

  it('does not change the visible language when ProductControl persistence fails', async () => {
    vi.stubGlobal('document', {
      documentElement: { setAttribute: vi.fn() },
    });
    const service = new I18nService();
    const initialLocale = service.getCurrentLocale();
    vi.spyOn(
      service as unknown as { saveCurrentLocale(locale: string): Promise<void> },
      'saveCurrentLocale',
    ).mockRejectedValue(new Error('ProductControl transaction rejected'));

    await expect(service.changeLanguage('zh-TW')).rejects.toThrow(
      'ProductControl transaction rejected',
    );
    expect(service.getCurrentLocale()).toBe(initialLocale);
    vi.unstubAllGlobals();
  });

  it('reuses equivalent date and number formatters', () => {
    const service = new I18nService();
    const createDateTimeFormatter = (
      service as unknown as {
        createDateTimeFormatter(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat;
      }
    ).createDateTimeFormatter.bind(service);

    const dateFormatter = createDateTimeFormatter({ year: 'numeric', month: '2-digit' });
    expect(createDateTimeFormatter({ month: '2-digit', year: 'numeric' })).toBe(dateFormatter);

    const firstNumber = service.formatNumber(1234.5, { style: 'decimal', useGrouping: true });
    const secondNumber = service.formatNumber(1234.5, { useGrouping: true, style: 'decimal' });
    expect(secondNumber).toBe(firstNumber);
  });

  it('does not cache options with custom prototypes', () => {
    const service = new I18nService();
    const createDateTimeFormatter = (
      service as unknown as {
        createDateTimeFormatter(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat;
      }
    ).createDateTimeFormatter.bind(service);
    const options = Object.create({ dateStyle: 'medium' }) as Intl.DateTimeFormatOptions;

    expect(createDateTimeFormatter(options)).not.toBe(createDateTimeFormatter(options));
  });
});
