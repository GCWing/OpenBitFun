import { useState, type FocusEvent } from 'react';

interface UsageSeriesIdentity { key: string; parentKey?: string; share?: number }

/** Shared chart/legend interaction for the compact overview and detailed report. */
export function useUsageSeriesHighlight<T extends UsageSeriesIdentity>(rows: T[]) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const activeKey = [hoveredKey, focusedKey].find(key => (
    rows.some(row => row.key === key && (row.share ?? 0) > 0)
  ));
  const activeRow = rows.find(row => row.key === activeKey);
  const highlight = (row: UsageSeriesIdentity) => {
    const hasSegment = (row.share ?? 0) > 0;
    const isActive = activeRow !== undefined && (activeKey === row.key
      || row.parentKey === activeKey || activeRow.parentKey === row.key);
    return {
      'data-usage-active': isActive || undefined,
      'data-usage-muted': activeRow !== undefined && !isActive || undefined,
      onMouseEnter: hasSegment ? () => setHoveredKey(row.key) : undefined,
      onMouseLeave: hasSegment ? () => setHoveredKey(null) : undefined,
      onFocus: hasSegment ? () => setFocusedKey(row.key) : undefined,
      onBlur: hasSegment ? (event: FocusEvent<Element>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
      } : undefined,
    };
  };
  return { activeRow, highlight };
}
