import { useEditorDocument } from '../services/EditorDocument';
import { standaloneEditorFileAccess } from '../services/editorFileAccess';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Scan, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Icon, IconButton, Input, Select, Toolbar, ToolbarGroup, ToolbarSeparator, Tooltip } from '@openbitfun/ui';
import {
  GlobalWorkerOptions,
  PermissionFlag,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import './PdfViewer.scss';
import { PdfReviewLayer, type PdfReviewInteraction } from '../pdf-review/PdfReviewLayer';
import type { PageViewport } from 'pdfjs-dist';

const log = createLogger('PdfViewer');
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;
const WHEEL_ZOOM_STEP = 10;
const WHEEL_ZOOM_DELTA_THRESHOLD = 100;
const ZOOM_PRESET_LEVELS = [50, 75, 100, 125, 150, 200, 300, 400] as const;
const MAX_OUTPUT_SCALE = 2;
const PAGE_SIZE_CONCURRENCY = 8;
const NEARBY_PAGE_DISTANCE = 2;
const RENDER_ROOT_MARGIN = '150% 0px';
const PDFJS_FONT_HEIGHT_PROPERTY = ['--font', 'height'].join('-');
const PDF_GLYPH_HEIGHT_PROPERTY = '--openbitfun-pdf-glyph-height';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PageSize {
  width: number;
  height: number;
}

interface ReadingAnchor {
  pageNumber: number;
  viewportX: number;
  viewportY: number;
  xRatio: number;
  yRatio: number;
}

interface ReadingAnchorPoint {
  clientX: number;
  clientY: number;
  pageNumber?: number;
}

interface PdfPageCanvasProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  pageLabel: string;
  copyAllowed: boolean;
  rotation: number;
  shouldRender: boolean;
  size: PageSize;
  zoom: number;
  onElementChange: (pageNumber: number, element: HTMLDivElement | null) => void;
  onRenderError: (pageNumber: number, error: unknown) => void;
  review?: PdfReviewInteraction;
}

export interface PdfViewerProps {
  isActiveTab?: boolean;
  filePath: string;
  /** Owning workspace ID for viewers rendered without an EditorDocument. */
  workspaceId?: string;
  fileName?: string;
  className?: string;
  /** An in-memory build artifact for editors that keep preview output off disk. */
  pdfBase64?: string;
  review?: PdfReviewInteraction;
  onDocumentLoaded?: (document: PDFDocumentProxy) => void;
  requestedPage?: number;
}

function decodePdfBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof RenderingCancelledException || (
    error instanceof Error && error.name === 'RenderingCancelledException'
  );
}

function displayedPageSize(size: PageSize, zoom: number, rotation: number): PageSize {
  const scale = zoom / 100;
  const swapsDimensions = Math.abs(rotation / 90) % 2 === 1;
  return {
    width: (swapsDimensions ? size.height : size.width) * scale,
    height: (swapsDimensions ? size.width : size.height) * scale,
  };
}

function normalizedWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * (WHEEL_ZOOM_DELTA_THRESHOLD / 3);
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * WHEEL_ZOOM_DELTA_THRESHOLD;
  }
  return event.deltaY;
}

async function measurePdfPages(document: PDFDocumentProxy): Promise<PageSize[]> {
  const firstPage = await document.getPage(1);
  let firstPageSize: PageSize;
  try {
    const viewport = firstPage.getViewport({ scale: 1 });
    firstPageSize = { width: viewport.width, height: viewport.height };
  } finally {
    firstPage.cleanup();
  }

  const sizes = Array.from({ length: document.numPages }, () => firstPageSize);
  let nextPageNumber = 2;
  const measureNextPage = async () => {
    while (nextPageNumber <= document.numPages) {
      const pageNumber = nextPageNumber;
      nextPageNumber += 1;
      let page: PDFPageProxy | undefined;
      try {
        page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        sizes[pageNumber - 1] = { width: viewport.width, height: viewport.height };
      } catch (error) {
        log.error('Failed to measure PDF page', { pageNumber, error });
      } finally {
        page?.cleanup();
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(PAGE_SIZE_CONCURRENCY, Math.max(0, document.numPages - 1)) },
      () => measureNextPage(),
    ),
  );
  return sizes;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({
  document,
  pageNumber,
  pageLabel,
  copyAllowed,
  rotation,
  shouldRender,
  size,
  zoom,
  onElementChange,
  onRenderError,
  review,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerContainerRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const [rendering, setRendering] = useState(false);
  const [reviewViewport, setReviewViewport] = useState<PageViewport>();
  const displaySize = displayedPageSize(size, zoom, rotation);
  const setPageElement = useCallback((element: HTMLDivElement | null) => {
    onElementChange(pageNumber, element);
  }, [onElementChange, pageNumber]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current || !textLayerContainerRef.current) {
      setRendering(false);
      return;
    }

    let disposed = false;
    let page: PDFPageProxy | undefined;
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerContainerRef.current;

    const renderPage = async () => {
      setRendering(true);
      try {
        page = await document.getPage(pageNumber);
        if (disposed) {
          page.cleanup();
          return;
        }

        const viewport = page.getViewport({
          scale: zoom / 100,
          rotation: (page.rotate + rotation) % 360,
        });
        const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
        const stagingCanvas = globalThis.document.createElement('canvas');
        stagingCanvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        stagingCanvas.height = Math.max(1, Math.floor(viewport.height * outputScale));

        const renderTask = page.render({
          canvas: stagingCanvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTaskRef.current = renderTask;
        const stagingTextLayerContainer = globalThis.document.createElement('div');
        stagingTextLayerContainer.dataset.pageNumber = String(pageNumber);
        stagingTextLayerContainer.style.setProperty('--scale-factor', `${viewport.scale}`);
        stagingTextLayerContainer.style.setProperty('--user-unit', `${viewport.userUnit}`);
        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent({
            includeMarkedContent: true,
            disableNormalization: true,
          }),
          container: stagingTextLayerContainer,
          viewport,
        });
        textLayerRef.current = textLayer;
        await Promise.all([renderTask.promise, textLayer.render()]);
        for (const textDiv of textLayer.textDivs) {
          const fontHeight = textDiv.style.getPropertyValue(PDFJS_FONT_HEIGHT_PROPERTY);
          if (fontHeight) {
            textDiv.style.setProperty(PDF_GLYPH_HEIGHT_PROPERTY, fontHeight);
            textDiv.style.removeProperty(PDFJS_FONT_HEIGHT_PROPERTY);
          }
        }
        if (disposed) {
          return;
        }

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
          throw new Error('Failed to create PDF page canvas context');
        }
        canvas.width = stagingCanvas.width;
        canvas.height = stagingCanvas.height;
        context.drawImage(stagingCanvas, 0, 0);
        textLayerContainer.style.cssText = stagingTextLayerContainer.style.cssText;
        textLayerContainer.setAttribute(
          'data-main-rotation',
          stagingTextLayerContainer.getAttribute('data-main-rotation') ?? '0',
        );
        textLayerContainer.replaceChildren(...stagingTextLayerContainer.childNodes);
        setReviewViewport(viewport);
        setRendering(false);
      } catch (error) {
        if (disposed || isRenderingCancelled(error)) {
          return;
        }
        setRendering(false);
        onRenderError(pageNumber, error);
      }
    };

    void renderPage();
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
      page?.cleanup();
    };
  }, [document, onRenderError, pageNumber, rotation, shouldRender, zoom]);

  return (
    <div
      ref={setPageElement}
      className="openbitfun-pdf-viewer__page"
      data-openbitfun-component="pdf-viewer"
      data-openbitfun-part="page"
      data-openbitfun-state={rendering ? 'rendering' : undefined}
      data-page-number={pageNumber}
      style={{ width: displaySize.width, height: displaySize.height }}
    >
      {shouldRender && (
        <>
          <canvas
            ref={canvasRef}
            aria-label={pageLabel}
            style={{ width: displaySize.width, height: displaySize.height }}
          />
          <div
            ref={textLayerContainerRef}
            className="openbitfun-pdf-viewer__text-layer"
            data-openbitfun-component="pdf-viewer"
            data-openbitfun-part="textLayer"
            onCopy={copyAllowed ? undefined : event => event.preventDefault()}
          />
          {review && reviewViewport && <PdfReviewLayer viewport={reviewViewport} pageNumber={pageNumber} review={review} />}
        </>
      )}
    </div>
  );
};

export const PdfViewer: React.FC<PdfViewerProps> = ({ isActiveTab = true,
  filePath,
  workspaceId,
  className = '',
  pdfBase64,
  review,
  onDocumentLoaded,
  requestedPage,
}) => {
  const onDocumentLoadedRef = useRef(onDocumentLoaded);
  onDocumentLoadedRef.current = onDocumentLoaded;
  const documentSession = useEditorDocument();
  const standaloneFiles = useMemo(() => standaloneEditorFileAccess(workspaceId), [workspaceId]);
  const documentFiles = documentSession?.files ?? standaloneFiles;
  const [retryKey, setRetryKey] = useState(0);
  const { t, formatNumber } = useI18n('tools');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const pageIntersectionAreasRef = useRef(new Map<number, number>());
  const loadEpochRef = useRef(0);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const readingAnchorRef = useRef<ReadingAnchor | null>(null);
  const wheelZoomDeltaRef = useRef(0);
  const fitWidthRef = useRef(!!pdfBase64);
  const loadedPathRef = useRef<string>();
  const viewRef = useRef({ page: 1, zoom: 100, rotation: 0 });
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageNumberInput, setPageNumberInput] = useState('1');
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [copyAllowed, setCopyAllowed] = useState(true);
  const [intersectingRenderPages, setIntersectingRenderPages] = useState<Set<number>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageCount = pageSizes.length;
  viewRef.current = { page: pageNumber, zoom, rotation };

  const loadDocument = useCallback(async () => {
    const loadEpoch = ++loadEpochRef.current;
    const previousLoadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    void previousLoadingTask?.destroy().catch(() => undefined);

    if (!filePath) {
      setDocument(null);
      setPageSizes([]);
      setError(t('editor.pdfViewer.filePathEmpty'));
      setLoading(false);
      return;
    }

    const previousView = loadedPathRef.current === filePath ? viewRef.current : undefined;
    setDocument(null);
    setPageSizes([]);
    if (!previousView) {
      setPageNumber(1); setPageNumberInput('1'); setZoom(100); setRotation(0);
    }
    setCopyAllowed(true);
    setIntersectingRenderPages(new Set());
    pageElementsRef.current.clear();
    pageIntersectionAreasRef.current.clear();
    readingAnchorRef.current = null;
    wheelZoomDeltaRef.current = 0;
    setError(null);
    setLoading(true);

    try {
      const encoded = pdfBase64 ?? await documentFiles.readFileContent(filePath, 'base64');
      if (loadEpochRef.current !== loadEpoch) {
        return;
      }

      const pdfBytes = decodePdfBase64(encoded);
      const loadingTask = getDocument({
        data: pdfBytes,
        enableXfa: false,
        isEvalSupported: false,
      });
      loadingTaskRef.current = loadingTask;
      const loadedDocument = await loadingTask.promise;

      if (loadEpochRef.current !== loadEpoch || loadingTaskRef.current !== loadingTask) {
        await loadingTask.destroy();
        return;
      }

      const [measuredPageSizes, permissions] = await Promise.all([
        measurePdfPages(loadedDocument),
        loadedDocument.getPermissions(),
      ]);
      if (loadEpochRef.current !== loadEpoch || loadingTaskRef.current !== loadingTask) {
        await loadingTask.destroy();
        return;
      }

      onDocumentLoadedRef.current?.(loadedDocument);
      setDocument(loadedDocument);
      setPageSizes(measuredPageSizes);
      loadedPathRef.current = filePath;
      if (previousView) setPageNumber(Math.min(previousView.page, loadedDocument.numPages));
      if (!previousView && pdfBase64 && containerRef.current?.clientWidth && measuredPageSizes[0]) {
        const container = containerRef.current;
        const styles = window.getComputedStyle(container);
        const width = container.clientWidth - (parseFloat(styles.paddingLeft) || 0) - (parseFloat(styles.paddingRight) || 0);
        setZoom(Math.max(MIN_ZOOM, Math.min(100, Math.floor(100 * width / measuredPageSizes[0].width))));
      }
      setCopyAllowed(!permissions || permissions.includes(PermissionFlag.COPY));
      setLoading(false);
    } catch (loadError) {
      if (loadEpochRef.current !== loadEpoch) {
        return;
      }
      log.error('Failed to load PDF', { filePath, error: loadError });
      setError(t('editor.pdfViewer.loadFailedWithMessage', { message: errorMessage(loadError) }));
      setLoading(false);
    }
  }, [documentFiles, filePath, pdfBase64, t]);

  useEffect(() => {
    if (isActiveTab && error && documentSession?.isCurrent()) setRetryKey(key => key + 1);
  }, [documentSession, error, isActiveTab]);

  useEffect(() => {
    void loadDocument();
    return () => {
      loadEpochRef.current += 1;
      const loadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [loadDocument, retryKey]);

  const handlePageElementChange = useCallback((number: number, element: HTMLDivElement | null) => {
    if (element) {
      pageElementsRef.current.set(number, element);
    } else {
      pageElementsRef.current.delete(number);
      pageIntersectionAreasRef.current.delete(number);
    }
  }, []);

  useEffect(() => {
    const root = containerRef.current;
    if (!document || pageSizes.length === 0 || !root || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const pageIntersectionAreas = pageIntersectionAreasRef.current;

    const renderObserver = new IntersectionObserver(entries => {
      setIntersectingRenderPages(current => {
        const next = new Set(current);
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (entry.isIntersecting) {
            next.add(number);
          } else {
            next.delete(number);
          }
        }
        if (next.size === current.size && [...next].every(number => current.has(number))) {
          return current;
        }
        return next;
      });
    }, { root, rootMargin: RENDER_ROOT_MARGIN });

    const currentPageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset.pageNumber);
        const area = entry.isIntersecting
          ? entry.intersectionRect.width * entry.intersectionRect.height
          : 0;
        pageIntersectionAreas.set(number, area);
      }

      let largestPage = 0;
      let largestArea = 0;
      for (const [number, area] of pageIntersectionAreas) {
        if (area > largestArea) {
          largestPage = number;
          largestArea = area;
        }
      }
      if (largestPage > 0) {
        setPageNumber(largestPage);
      }
    }, {
      root,
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });

    for (const element of pageElementsRef.current.values()) {
      renderObserver.observe(element);
      currentPageObserver.observe(element);
    }
    return () => {
      renderObserver.disconnect();
      currentPageObserver.disconnect();
      pageIntersectionAreas.clear();
    };
  }, [document, pageSizes]);

  const captureReadingAnchor = useCallback((point?: ReadingAnchorPoint) => {
    const container = containerRef.current;
    const anchorPageNumber = point?.pageNumber ?? pageNumber;
    const page = pageElementsRef.current.get(anchorPageNumber);
    if (!container || !page) {
      readingAnchorRef.current = null;
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
      readingAnchorRef.current = null;
      return;
    }

    const viewportX = point
      ? Math.min(container.clientWidth, Math.max(0, point.clientX - containerRect.left))
      : container.clientWidth / 2;
    const viewportY = point
      ? Math.min(container.clientHeight, Math.max(0, point.clientY - containerRect.top))
      : container.clientHeight / 2;
    readingAnchorRef.current = {
      pageNumber: anchorPageNumber,
      viewportX,
      viewportY,
      xRatio: Math.min(1, Math.max(0, (containerRect.left + viewportX - pageRect.left) / pageRect.width)),
      yRatio: Math.min(1, Math.max(0, (containerRect.top + viewportY - pageRect.top) / pageRect.height)),
    };
  }, [pageNumber]);

  useLayoutEffect(() => {
    const anchor = readingAnchorRef.current;
    const container = containerRef.current;
    const page = anchor ? pageElementsRef.current.get(anchor.pageNumber) : undefined;
    if (!anchor || !container || !page) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const anchorX = pageRect.left + pageRect.width * anchor.xRatio;
    const anchorY = pageRect.top + pageRect.height * anchor.yRatio;
    container.scrollLeft += anchorX - (containerRect.left + anchor.viewportX);
    container.scrollTop += anchorY - (containerRect.top + anchor.viewportY);
    readingAnchorRef.current = null;
  }, [rotation, zoom]);

  const renderedPages = useMemo(() => {
    const pages = new Set(intersectingRenderPages);
    for (
      let number = Math.max(1, pageNumber - NEARBY_PAGE_DISTANCE);
      number <= Math.min(pageCount, pageNumber + NEARBY_PAGE_DISTANCE);
      number += 1
    ) {
      pages.add(number);
    }
    return pages;
  }, [intersectingRenderPages, pageCount, pageNumber]);

  const scrollToPage = useCallback((targetPageNumber: number) => {
    const boundedPageNumber = Math.min(pageCount, Math.max(1, targetPageNumber));
    setPageNumber(boundedPageNumber);
    pageElementsRef.current.get(boundedPageNumber)?.scrollIntoView({
      behavior: 'auto',
      block: 'start',
      inline: 'nearest',
    });
  }, [pageCount]);

  useEffect(() => {
    if (requestedPage && document) scrollToPage(requestedPage);
  }, [requestedPage, document, scrollToPage]);

  useEffect(() => {
    setPageNumberInput(String(pageNumber));
  }, [pageNumber]);

  const submitPageNumber = useCallback(() => {
    if (!/^\d+$/.test(pageNumberInput)) {
      setPageNumberInput(String(pageNumber));
      return;
    }
    const targetPageNumber = Number(pageNumberInput);
    if (!Number.isSafeInteger(targetPageNumber) || targetPageNumber < 1 || targetPageNumber > pageCount) {
      setPageNumberInput(String(pageNumber));
      return;
    }
    setPageNumberInput(String(targetPageNumber));
    scrollToPage(targetPageNumber);
  }, [pageCount, pageNumber, pageNumberInput, scrollToPage]);

  const handleWheelZoom = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    if (loading || !document || error || event.deltaY === 0) {
      return;
    }

    const delta = normalizedWheelDelta(event);
    if (
      wheelZoomDeltaRef.current !== 0
      && Math.sign(wheelZoomDeltaRef.current) !== Math.sign(delta)
    ) {
      wheelZoomDeltaRef.current = 0;
    }
    wheelZoomDeltaRef.current += delta;
    const stepCount = Math.trunc(
      Math.abs(wheelZoomDeltaRef.current) / WHEEL_ZOOM_DELTA_THRESHOLD,
    );
    if (stepCount === 0) {
      return;
    }

    fitWidthRef.current = false;
    const direction = wheelZoomDeltaRef.current < 0 ? 1 : -1;
    wheelZoomDeltaRef.current -= Math.sign(wheelZoomDeltaRef.current)
      * stepCount
      * WHEEL_ZOOM_DELTA_THRESHOLD;
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, zoom + direction * stepCount * WHEEL_ZOOM_STEP),
    );
    if (nextZoom === zoom) {
      return;
    }

    const eventTarget = event.target instanceof Element ? event.target : null;
    const hoveredPage = eventTarget?.closest<HTMLElement>('[data-page-number]');
    const hoveredPageNumber = Number(hoveredPage?.dataset.pageNumber);
    captureReadingAnchor({
      clientX: event.clientX,
      clientY: event.clientY,
      pageNumber: Number.isSafeInteger(hoveredPageNumber) ? hoveredPageNumber : pageNumber,
    });
    setZoom(nextZoom);
  }, [captureReadingAnchor, document, error, loading, pageNumber, zoom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.addEventListener('wheel', handleWheelZoom, { passive: false });
    return () => container.removeEventListener('wheel', handleWheelZoom);
  }, [handleWheelZoom]);

  const zoomOut = useCallback(() => {
    fitWidthRef.current = false;
    captureReadingAnchor();
    setZoom(current => Math.max(MIN_ZOOM, current - ZOOM_STEP));
  }, [captureReadingAnchor]);

  const zoomIn = useCallback(() => {
    fitWidthRef.current = false;
    captureReadingAnchor();
    setZoom(current => Math.min(MAX_ZOOM, current + ZOOM_STEP));
  }, [captureReadingAnchor]);

  const selectZoom = useCallback((value: string | number) => {
    fitWidthRef.current = false;
    const nextZoom = Number(value);
    if (!Number.isFinite(nextZoom) || nextZoom === zoom) {
      return;
    }
    captureReadingAnchor();
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom)));
  }, [captureReadingAnchor, zoom]);

  const fitWidth = useCallback(() => {
    const container = containerRef.current;
    const page = pageSizes[Math.max(0, pageNumber - 1)];
    if (!container || !page || container.clientWidth <= 0) return;
    const styles = window.getComputedStyle(container);
    const available = container.clientWidth - (parseFloat(styles.paddingLeft) || 0) - (parseFloat(styles.paddingRight) || 0);
    const width = rotation % 180 === 0 ? page.width : page.height;
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(100 * available / width))));
  }, [pageNumber, pageSizes, rotation]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !document) return;
    const measure = () => { if (fitWidthRef.current) fitWidth(); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, [document, fitWidth]);

  const rotateClockwise = useCallback(() => {
    captureReadingAnchor();
    setRotation(current => (current + 90) % 360);
  }, [captureReadingAnchor]);

  const handleRenderError = useCallback((failedPageNumber: number, renderError: unknown) => {
    log.error('Failed to render PDF page', {
      filePath,
      pageNumber: failedPageNumber,
      error: renderError,
    });
    setError(t('editor.pdfViewer.renderFailedWithMessage', { message: errorMessage(renderError) }));
  }, [filePath, t]);

  const pageLabel = t('editor.pdfViewer.pageCount', {
    current: formatNumber(pageNumber),
    total: formatNumber(pageCount),
  });
  const zoomOptions = useMemo(() => (
    Array.from(new Set<number>([...ZOOM_PRESET_LEVELS, zoom]))
      .sort((left, right) => left - right)
      .map(value => ({
        label: formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 0 }),
        value,
      }))
  ), [formatNumber, zoom]);

  return (
    <div
      className={`openbitfun-pdf-viewer ${className}`}
      data-openbitfun-component="pdf-viewer"
      data-openbitfun-part="root"
    >
      <Toolbar
        className="openbitfun-pdf-viewer__toolbar"
        leading={
          <div className="openbitfun-pdf-viewer__info" data-openbitfun-component="pdf-viewer" data-openbitfun-part="info">
            {pageCount > 0 && (
              <span className="openbitfun-pdf-viewer__page-label">
                <Input
                  aria-label={t('editor.pdfViewer.currentPage')}
                  className="openbitfun-pdf-viewer__page-input"
                  disabled={loading}
                  inputMode="numeric"
                  onBlur={() => setPageNumberInput(String(pageNumber))}
                  onFocus={event => event.currentTarget.select()}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      submitPageNumber();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setPageNumberInput(String(pageNumber));
                      event.currentTarget.blur();
                    }
                  }}
                  onValueChange={value => {
                    if (/^\d*$/.test(value)) {
                      setPageNumberInput(value);
                    }
                  }}
                  size="sm"
                  value={pageNumberInput}
                />
                <span aria-hidden="true">/</span>
                <span className="openbitfun-pdf-viewer__page-total">{formatNumber(pageCount)}</span>
                <span className="sr-only" aria-live="polite">{pageLabel}</span>
              </span>
            )}
          </div>
        }
        trailing={
          <>
            <ToolbarGroup>
              <Tooltip content={t('editor.pdfViewer.previousPage')} placement="top">
                <IconButton
                  aria-label={t('editor.pdfViewer.previousPage')}
                  size="sm"
                  variant="quiet"
                  icon={<Icon name="chevron-left" size="sm" />}
                  onClick={() => scrollToPage(pageNumber - 1)}
                  disabled={loading || pageNumber <= 1}
                />
              </Tooltip>
              <Tooltip content={t('editor.pdfViewer.nextPage')} placement="top">
                <IconButton
                  aria-label={t('editor.pdfViewer.nextPage')}
                  size="sm"
                  variant="quiet"
                  icon={<Icon name="chevron-right" size="sm" />}
                  onClick={() => scrollToPage(pageNumber + 1)}
                  disabled={loading || pageNumber >= pageCount}
                />
              </Tooltip>
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup>
              <Select
                aria-label={t('editor.pdfViewer.zoomLevel')}
                className="openbitfun-pdf-viewer__zoom-display"
                disabled={loading}
                onValueChange={selectZoom}
                options={zoomOptions}
                size="sm"
                value={zoom}
              />
              <Tooltip content={t('editor.pdfViewer.zoomOut')} placement="top">
                <IconButton
                  aria-label={t('editor.pdfViewer.zoomOut')}
                  size="sm"
                  variant="quiet"
                  icon={<ZoomOut size={14} />}
                  onClick={zoomOut}
                  disabled={loading || zoom <= MIN_ZOOM}
                />
              </Tooltip>
              <Tooltip content={t('editor.pdfViewer.zoomIn')} placement="top">
                <IconButton
                  aria-label={t('editor.pdfViewer.zoomIn')}
                  size="sm"
                  variant="quiet"
                  icon={<ZoomIn size={14} />}
                  onClick={zoomIn}
                  disabled={loading || zoom >= MAX_ZOOM}
                />
              </Tooltip>
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup>
              <Tooltip content={t('editor.pdfViewer.fitWidth')} placement="top"><IconButton size="sm" variant="quiet"
                icon={<Scan size={14} />} aria-label={t('editor.pdfViewer.fitWidth')} disabled={loading}
                onClick={() => { fitWidthRef.current = true; fitWidth(); }} /></Tooltip>
              <Tooltip content={t('editor.pdfViewer.rotate90')} placement="top">
                <IconButton
                  aria-label={t('editor.pdfViewer.rotate90')}
                  size="sm"
                  variant="quiet"
                  icon={<RotateCw size={14} />}
                  onClick={rotateClockwise}
                  disabled={loading}
                />
              </Tooltip>
            </ToolbarGroup>
          </>
        }
      />

      <div
        ref={containerRef}
        className="openbitfun-pdf-viewer__container"
        data-openbitfun-component="pdf-viewer"
        data-openbitfun-part="container"
      >
        {loading && (
          <div className="openbitfun-pdf-viewer__status" data-openbitfun-component="pdf-viewer" data-openbitfun-part="loading">
            <div className="openbitfun-pdf-viewer__spinner" />
            <p>{t('editor.pdfViewer.loading')}</p>
          </div>
        )}

        {error && (
          <div className="openbitfun-pdf-viewer__status openbitfun-pdf-viewer__status--error" data-openbitfun-component="pdf-viewer" data-openbitfun-part="error">
            <p>{error}</p>
            <p className="openbitfun-pdf-viewer__error-path">{filePath}</p>
            <Button variant="outline" size="sm" onClick={() => void loadDocument()}>
              {t('editor.common.retry')}
            </Button>
          </div>
        )}

        {!loading && !error && document && (
          <div className="openbitfun-pdf-viewer__pages">
            {pageSizes.map((size, index) => {
              const number = index + 1;
              const label = t('editor.pdfViewer.pageCount', {
                current: formatNumber(number),
                total: formatNumber(pageCount),
              });
              return (
                <PdfPageCanvas
                  key={number}
                  document={document}
                  copyAllowed={copyAllowed}
                  pageNumber={number}
                  pageLabel={label}
                  rotation={rotation}
                  shouldRender={renderedPages.has(number)}
                  size={size}
                  zoom={zoom}
                  onElementChange={handlePageElementChange}
                  onRenderError={handleRenderError}
                  review={review}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default PdfViewer;
