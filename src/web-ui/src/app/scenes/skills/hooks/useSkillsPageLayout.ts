import { useLayoutEffect, useState, type RefObject } from 'react';

const MAX_ROWS = 5;

interface SkillsPageLayoutOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  gridRef: RefObject<HTMLDivElement | null>;
  total: number;
  hasMore?: boolean;
  enabled: boolean;
}

export function useSkillsPageLayout({
  viewportRef, contentRef, gridRef, total, hasMore = false, enabled,
}: SkillsPageLayoutOptions) {
  const [layout, setLayout] = useState({ rows: MAX_ROWS, columns: 2 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const grid = gridRef.current;
    if (!enabled || !viewport || !content || !grid) return;

    const measure = () => {
      const card = grid.firstElementChild;
      const rowHeight = card?.getBoundingClientRect().height ?? 0;
      if (viewport.clientHeight <= 0 || rowHeight <= 0) return;

      const gridStyle = getComputedStyle(grid);
      const columns = gridStyle.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      if (columns === 0) return;
      const gap = parseFloat(gridStyle.rowGap) || 0;
      const bottomPadding = parseFloat(getComputedStyle(content).paddingBottom) || 0;
      // Measure from the start of the scroll content, independent of scroll position.
      const gridTop = grid.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        - viewport.clientTop + viewport.scrollTop;
      const available = viewport.clientHeight - gridTop - bottomPadding;
      const fitRows = (height: number) => Math.max(1, Math.min(MAX_ROWS,
        Math.floor((height + gap) / (rowHeight + gap)),
      ));

      // Decide whether pagination is needed before subtracting its height. This
      // prevents the pager appearing/disappearing from oscillating the page size.
      const needsPager = hasMore || total > fitRows(available) * columns;
      const pager = grid.parentElement?.querySelector<HTMLElement>('.skills-pagination');
      let pagerHeight = 0;
      if (needsPager && pager) {
        const pagerStyle = getComputedStyle(pager);
        pagerHeight = pager.getBoundingClientRect().height
          + (parseFloat(pagerStyle.marginTop) || 0)
          + (parseFloat(pagerStyle.marginBottom) || 0);
      }
      const rows = fitRows(available - pagerHeight);
      setLayout(previous => previous.rows === rows && previous.columns === columns
        ? previous
        : { rows, columns });
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    // Content observes heading, toolbar, font, and pager height changes as well.
    for (const element of [viewport, content, grid]) observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [viewportRef, contentRef, gridRef, enabled, total, hasMore, layout]);

  return { rows: layout.rows, pageSize: layout.rows * layout.columns };
}
