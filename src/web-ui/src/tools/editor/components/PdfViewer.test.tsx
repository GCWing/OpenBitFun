// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfViewer } from './PdfViewer';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  readFileContent: vi.fn(),
  textLayerInstances: [] as Array<{
    cancel: ReturnType<typeof vi.fn>;
    options: {
      container: HTMLElement;
      textContentSource: unknown;
      viewport: unknown;
    };
    render: ReturnType<typeof vi.fn>;
    textDivs: HTMLElement[];
  }>,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  PermissionFlag: { COPY: 16 },
  RenderingCancelledException: class RenderingCancelledException extends Error {},
  TextLayer: class TextLayer {
    readonly cancel = vi.fn();
    readonly textDivs: HTMLElement[] = [];
    readonly render = vi.fn(async () => {
      const text = document.createElement('span');
      text.textContent = 'Selectable PDF text';
      text.style.setProperty(['--font', 'height'].join('-'), '12px');
      this.textDivs.push(text);
      this.options.container.append(text);
    });

    constructor(readonly options: {
      container: HTMLElement;
      textContentSource: unknown;
      viewport: unknown;
    }) {
      mocks.textLayerInstances.push(this);
    }
  },
  getDocument: (...args: unknown[]) => mocks.getDocument(...args),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.min.mjs',
}));

vi.mock('@/infrastructure/api', () => ({
  workspaceAPI: {
    // Standalone viewers read through the owning workspace ID, never a bare path.
    readWorkspaceFile: (...args: unknown[]) => mocks.readFileContent(...args),
  },
}));

vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string, options?: Record<string, string>) => {
    if (key === 'editor.pdfViewer.pageCount') {
      return `Page ${options?.current} of ${options?.total}`;
    }
    return key;
  };
  const formatNumber = (value: number) => String(value);
  return {
    useI18n: () => ({ t, formatNumber }),
  };
});

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
  }),
}));

vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  IconButton: ({ icon: _icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props} />
  ),
  Icon: ({ name }: { name: string }) => <span data-openbitfun-name={name} />,
  Input: ({
    onValueChange,
    size: _size,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    onValueChange?: (value: string) => void;
    size?: 'sm' | 'md' | 'lg';
  }) => (
    <input
      {...props}
      onChange={event => {
        props.onChange?.(event);
        onValueChange?.(event.currentTarget.value);
      }}
    />
  ),
  Select: ({
    onValueChange,
    options,
    size: _size,
    ...props
  }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
    onValueChange?: (value: string | number) => void;
    options: readonly Array<{ label: string; value: string | number }>;
    size?: 'sm' | 'md' | 'lg';
  }) => (
    <select
      {...props}
      onChange={event => {
        props.onChange?.(event);
        const option = options.find(candidate => String(candidate.value) === event.currentTarget.value);
        if (option) {
          onValueChange?.(option.value);
        }
      }}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
  Toolbar: ({ leading, trailing, className }: { leading?: React.ReactNode; trailing?: React.ReactNode; className?: string }) => (
    <div className={className}>{leading}{trailing}</div>
  ),
  ToolbarGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ToolbarSeparator: () => <span />,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface IntersectionObserverMockInstance {
  callback: IntersectionObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  root: Element | Document | null;
  rootMargin: string;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createPdfDocument(pageCount = 5, permissions: number[] | null = null) {
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const width = 600 + index * 10;
    const height = 800 + index * 10;
    return {
      rotate: 0,
      cleanup: vi.fn(),
      getViewport: vi.fn(({ scale = 1, rotation = 0 }: { scale?: number; rotation?: number }) => {
        const swapsDimensions = Math.abs(rotation / 90) % 2 === 1;
        return {
          width: (swapsDimensions ? height : width) * scale,
          height: (swapsDimensions ? width : height) * scale,
          scale,
          userUnit: 1,
        };
      }),
      streamTextContent: vi.fn(() => ({ pageNumber: index + 1 })),
      render: vi.fn(() => ({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      })),
    };
  });
  const document = {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
    getPermissions: vi.fn(async () => permissions),
  };
  const loadingTask = {
    promise: Promise.resolve(document),
    destroy: vi.fn(async () => undefined),
  };
  return { document, loadingTask, pages };
}

function intersectionEntry(
  target: Element,
  { isIntersecting, width = 0, height = 0 }: {
    isIntersecting: boolean;
    width?: number;
    height?: number;
  },
): IntersectionObserverEntry {
  return {
    boundingClientRect: {} as DOMRectReadOnly,
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: { width, height } as DOMRectReadOnly,
    isIntersecting,
    rootBounds: null,
    target,
    time: 0,
  };
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('PdfViewer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observerInstances: IntersectionObserverMockInstance[];
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let canvasDrawImageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    observerInstances = [];
    vi.stubGlobal('IntersectionObserver', class IntersectionObserverMock {
      readonly root: Element | Document | null;
      readonly rootMargin: string;
      readonly thresholds: readonly number[];
      readonly callback: IntersectionObserverCallback;
      readonly disconnect = vi.fn();
      readonly observe = vi.fn();
      readonly takeRecords = () => [];
      readonly unobserve = vi.fn();

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.callback = callback;
        this.root = options?.root ?? null;
        this.rootMargin = options?.rootMargin ?? '0px';
        this.thresholds = Array.isArray(options?.threshold)
          ? options.threshold
          : [options?.threshold ?? 0];
        observerInstances.push(this);
      }
    });

    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    scrollIntoViewSpy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    });
    canvasDrawImageSpy = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      drawImage: canvasDrawImageSpy,
    }) as unknown as CanvasRenderingContext2D);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getDocument.mockReset();
    mocks.readFileContent.mockReset();
    mocks.textLayerInstances.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (Element.prototype as Element & { scrollIntoView?: unknown }).scrollIntoView;
    }
    vi.clearAllMocks();
  });

  it('loads base64 data, lays out every page, and initially renders only nearby pages', async () => {
    const pdf = createPdfDocument(6);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" fileName="report.pdf" />));
    await flushAsyncWork();

    expect(mocks.readFileContent).toHaveBeenCalledWith('workspace-remote', '/remote/report.pdf', 'base64');
    expect(container.textContent).not.toContain('report.pdf');
    expect(mocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: new Uint8Array([1, 2, 3]),
      enableXfa: false,
      isEvalSupported: false,
    }));
    expect(pdf.document.getPage).toHaveBeenCalledWith(1);
    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(6);
    expect(pdf.pages[0].render).toHaveBeenCalledOnce();
    expect(pdf.pages[1].render).toHaveBeenCalledOnce();
    expect(pdf.pages[2].render).toHaveBeenCalledOnce();
    expect(pdf.pages[3].render).not.toHaveBeenCalled();
    expect(pdf.pages[4].render).not.toHaveBeenCalled();
    expect(pdf.pages[5].render).not.toHaveBeenCalled();
    expect(mocks.textLayerInstances).toHaveLength(3);
    expect(mocks.textLayerInstances.every(instance => instance.render.mock.calls.length === 1)).toBe(true);
    expect(container.querySelectorAll('.openbitfun-pdf-viewer__text-layer span')).toHaveLength(3);
    expect(
      container.querySelector<HTMLElement>('.openbitfun-pdf-viewer__text-layer span')
        ?.style.getPropertyValue('--openbitfun-pdf-glyph-height'),
    ).toBe('12px');
  });

  it('renders a distant page when it approaches the viewport and unloads it after it leaves', async () => {
    const pdf = createPdfDocument(6);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const renderObserver = observerInstances.find(instance => instance.rootMargin === '150% 0px');
    const sixthPage = container.querySelector('[data-page-number="6"]');
    expect(renderObserver).toBeDefined();
    expect(sixthPage).not.toBeNull();

    act(() => {
      renderObserver?.callback(
        [intersectionEntry(sixthPage!, { isIntersecting: true, width: 600, height: 800 })],
        renderObserver as unknown as IntersectionObserver,
      );
    });
    await flushAsyncWork();
    expect(pdf.pages[5].render).toHaveBeenCalledOnce();
    expect(sixthPage?.querySelector('canvas')).not.toBeNull();
    const sixthPageTextLayer = mocks.textLayerInstances.find(
      instance => instance.options.container.dataset.pageNumber === '6',
    );
    expect(sixthPageTextLayer?.render).toHaveBeenCalledOnce();

    act(() => {
      renderObserver?.callback(
        [intersectionEntry(sixthPage!, { isIntersecting: false })],
        renderObserver as unknown as IntersectionObserver,
      );
    });
    await flushAsyncWork();
    expect(sixthPage?.querySelector('canvas')).toBeNull();
    expect(sixthPageTextLayer?.cancel).toHaveBeenCalledOnce();
    expect(pdf.pages[5].cleanup).toHaveBeenCalledTimes(2);
  });

  it('prevents copying when the PDF permissions disallow it', async () => {
    const pdf = createPdfDocument(3, []);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/restricted.pdf" />));
    await flushAsyncWork();

    const textLayer = container.querySelector('.openbitfun-pdf-viewer__text-layer');
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    act(() => textLayer?.dispatchEvent(copyEvent));

    expect(copyEvent.defaultPrevented).toBe(true);
  });

  it('tracks the page with the largest visible area', async () => {
    const pdf = createPdfDocument(5);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const currentPageObserver = observerInstances.find(instance => instance.rootMargin === '0px');
    const firstPage = container.querySelector('[data-page-number="1"]');
    const fourthPage = container.querySelector('[data-page-number="4"]');
    act(() => {
      currentPageObserver?.callback([
        intersectionEntry(firstPage!, { isIntersecting: true, width: 100, height: 100 }),
        intersectionEntry(fourthPage!, { isIntersecting: true, width: 300, height: 400 }),
      ], currentPageObserver as unknown as IntersectionObserver);
    });
    await flushAsyncWork();

    expect(container.textContent).toContain('Page 4 of 5');
    expect(pdf.pages[3].render).toHaveBeenCalledOnce();
    expect(pdf.pages[4].render).toHaveBeenCalledOnce();
  });

  it('uses immediate scrolling for toolbar page navigation', async () => {
    const pdf = createPdfDocument(4);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const nextPage = container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfViewer.nextPage"]');
    expect(nextPage).not.toBeNull();
    act(() => nextPage?.click());

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
      inline: 'nearest',
    });
    expect(container.textContent).toContain('Page 2 of 4');
  });

  it('changes pages only after an entered page number is submitted with Enter', async () => {
    const pdf = createPdfDocument(4);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const pageInput = container.querySelector<HTMLInputElement>(
      '[aria-label="editor.pdfViewer.currentPage"]',
    );
    expect(pageInput?.value).toBe('1');

    act(() => setInputValue(pageInput!, '3'));
    expect(pageInput?.value).toBe('3');
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Page 1 of 4');

    act(() => {
      pageInput?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      }));
    });

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
      inline: 'nearest',
    });
    expect(container.textContent).toContain('Page 3 of 4');
  });

  it('zooms with the primary modifier while keeping the pointer anchor stable', async () => {
    const pdf = createPdfDocument(4);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const scrollContainer = container.querySelector<HTMLElement>('.openbitfun-pdf-viewer__container');
    const firstPage = container.querySelector<HTMLElement>('[data-page-number="1"]');
    expect(scrollContainer).not.toBeNull();
    expect(firstPage).not.toBeNull();
    Object.defineProperties(scrollContainer!, {
      clientHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 400 },
    });
    vi.spyOn(scrollContainer!, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 400, 500));
    vi.spyOn(firstPage!, 'getBoundingClientRect').mockImplementation(() => domRect(
      20,
      30,
      Number.parseFloat(firstPage!.style.width),
      Number.parseFloat(firstPage!.style.height),
    ));

    const plainWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 170,
      clientY: 230,
      deltaY: -100,
    });
    act(() => firstPage?.dispatchEvent(plainWheel));
    expect(plainWheel.defaultPrevented).toBe(false);
    expect(firstPage?.style.width).toBe('600px');

    const zoomWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 170,
      clientY: 230,
      ctrlKey: true,
      deltaY: -100,
    });
    act(() => firstPage?.dispatchEvent(zoomWheel));
    await flushAsyncWork();

    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(Number.parseFloat(firstPage?.style.width ?? '')).toBeCloseTo(660);
    expect(Number.parseFloat(firstPage?.style.height ?? '')).toBeCloseTo(880);
    expect(scrollContainer?.scrollLeft).toBeCloseTo(15);
    expect(scrollContainer?.scrollTop).toBeCloseTo(20);
    const zoomLevel = container.querySelector<HTMLSelectElement>(
      '[aria-label="editor.pdfViewer.zoomLevel"]',
    );
    expect(zoomLevel?.value).toBe('110');
    expect(Array.from(zoomLevel?.options ?? []).map(option => option.value)).toContain('110');
  });

  it('offers common zoom levels and applies a selected level', async () => {
    const pdf = createPdfDocument(3);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const zoomLevel = container.querySelector<HTMLSelectElement>(
      '[aria-label="editor.pdfViewer.zoomLevel"]',
    );
    expect(Array.from(zoomLevel?.options ?? []).map(option => option.value)).toEqual([
      '50',
      '75',
      '100',
      '125',
      '150',
      '200',
      '300',
      '400',
    ]);

    act(() => {
      zoomLevel!.value = '200';
      zoomLevel?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushAsyncWork();

    const firstPage = container.querySelector<HTMLElement>('[data-page-number="1"]');
    expect(zoomLevel?.value).toBe('200');
    expect(firstPage?.style.width).toBe('1200px');
  });

  it('keeps the previous canvas and text layer visible until a zoom render is complete', async () => {
    const pdf = createPdfDocument(3);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/report.pdf" />));
    await flushAsyncWork();

    const firstPage = container.querySelector<HTMLElement>('[data-page-number="1"]');
    const canvas = firstPage?.querySelector<HTMLCanvasElement>('canvas');
    const textLayer = firstPage?.querySelector<HTMLElement>('.openbitfun-pdf-viewer__text-layer');
    const previousText = textLayer?.querySelector('span');
    expect(canvas?.width).toBe(600);
    expect(canvas?.style.width).toBe('600px');
    expect(previousText).not.toBeNull();

    const zoomRender = deferred<void>();
    pdf.pages[0].render.mockImplementationOnce(() => ({
      promise: zoomRender.promise,
      cancel: vi.fn(),
    }));
    const zoomIn = container.querySelector<HTMLButtonElement>(
      '[aria-label="editor.pdfViewer.zoomIn"]',
    );
    act(() => zoomIn?.click());
    await flushAsyncWork();

    expect(canvas?.style.width).toBe('750px');
    expect(canvas?.width).toBe(600);
    expect(previousText?.isConnected).toBe(true);

    zoomRender.resolve();
    await flushAsyncWork();

    expect(canvas?.width).toBe(750);
    expect(previousText?.isConnected).toBe(false);
    expect(textLayer?.querySelector('span')?.textContent).toBe('Selectable PDF text');
    expect(canvasDrawImageSpy).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0);
  });

  it('ignores a stale file read when the selected file changes', async () => {
    const firstRead = deferred<string>();
    const secondPdf = createPdfDocument(3);
    mocks.readFileContent
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce('BAUG');
    mocks.getDocument.mockReturnValue(secondPdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/old.pdf" />));
    await flushAsyncWork();
    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="/remote/new.pdf" />));
    await flushAsyncWork();

    firstRead.resolve('AQID');
    await flushAsyncWork();

    expect(mocks.getDocument).toHaveBeenCalledOnce();
    expect(mocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: new Uint8Array([4, 5, 6]),
    }));
    expect(container.textContent).toContain('Page 1 of 3');
  });

  it('destroys the PDF.js loading task and page renders when unmounted', async () => {
    const pdf = createPdfDocument(3);
    mocks.readFileContent.mockResolvedValue('AQID');
    mocks.getDocument.mockReturnValue(pdf.loadingTask);

    act(() => root.render(<PdfViewer workspaceId="workspace-remote" filePath="C:\\docs\\report.pdf" />));
    await flushAsyncWork();
    const scrollContainer = container.querySelector<HTMLElement>('.openbitfun-pdf-viewer__container');
    const removeEventListenerSpy = vi.spyOn(scrollContainer!, 'removeEventListener');
    act(() => root.unmount());
    root = createRoot(container);

    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
    expect(removeEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
    for (const page of pdf.pages) {
      expect(page.cleanup).toHaveBeenCalledTimes(2);
    }
  });
});
