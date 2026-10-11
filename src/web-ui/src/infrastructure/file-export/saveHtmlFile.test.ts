// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeHtmlFileName, saveHtmlFile } from './saveHtmlFile';

const mocks = vi.hoisted(() => ({ save: vi.fn(), writeFile: vi.fn(), download: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.writeFile }));
vi.mock('@/shared/utils/browserDownload', () => ({ downloadTextFileInBrowser: mocks.download }));

const options = { html: '<!DOCTYPE html><p>你好</p>', title: 'Chart / 比较', dialogTitle: 'Export HTML' };
beforeEach(() => vi.resetAllMocks());
afterEach(() => { Reflect.deleteProperty(window, '__TAURI__'); });

describe('HTML file export on the viewing device', () => {
  it('uses portable filenames, including reserved Windows names and empty titles', () => {
    expect(safeHtmlFileName(' Chart / 比较.htm ')).toBe('Chart - 比较.html');
    expect(safeHtmlFileName('CON')).toBe('_CON.html');
    expect(safeHtmlFileName('A... ')).toBe('A.html');
    expect(safeHtmlFileName('.html')).toBe('OpenBitFun.html');
  });

  it('downloads in the browser without invoking a desktop filesystem or dialog', async () => {
    expect(await saveHtmlFile(options)).toBe(true);
    expect(mocks.download).toHaveBeenCalledWith('Chart - 比较.html', options.html, 'text/html;charset=utf-8');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('saves UTF-8 through the controller desktop plugins', async () => {
    Reflect.set(window, '__TAURI__', {});
    mocks.save.mockResolvedValue('E:/tmp/chart.html');
    expect(await saveHtmlFile(options)).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith({
      title: 'Export HTML', defaultPath: 'Chart - 比较.html',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
    expect(mocks.writeFile).toHaveBeenCalledWith('E:/tmp/chart.html', new TextEncoder().encode(options.html));
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('treats a cancelled save dialog as cancellation without writing a file', async () => {
    Reflect.set(window, '__TAURI__', {});
    mocks.save.mockResolvedValue(null);
    expect(await saveHtmlFile(options)).toBe(false);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('propagates save failures without falling back to another destination', async () => {
    Reflect.set(window, '__TAURI__', {});
    mocks.save.mockResolvedValue('E:/tmp/chart.html');
    mocks.writeFile.mockRejectedValue(new Error('Write failed'));
    await expect(saveHtmlFile(options)).rejects.toThrow('Write failed');
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
