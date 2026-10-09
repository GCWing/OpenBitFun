import React from 'react';

interface Props {
  itemKeys: readonly string[];
  scrollerRef: React.RefObject<HTMLElement | null>;
  canRepair: () => boolean;
  shift: (delta: number) => boolean;
  onRepaired?: () => void;
  /** The viewport may retain a leading block or its surviving group header. */
  snapshotAnchor?: () => { key: string; offset: number } | null;
  children: React.ReactNode;
  rowSelector?: string;
}
interface Snapshot { key: string; offset: number; scrollTop: number }

/** Layout transactions preserve a surviving reading block before the next paint. */
export class TimelineMutationBoundary extends React.Component<Props, object, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { itemKeys, scrollerRef, canRepair } = this.props;
    const scroller = scrollerRef.current;
    if (!scroller || !scroller.clientHeight || !canRepair() || previous.itemKeys === itemKeys) return null;
    // Existing history-prepend compensation remains the sole owner of prepends.
    if (itemKeys[0] !== previous.itemKeys[0]) return null;
    if (itemKeys.length === previous.itemKeys.length && itemKeys.every((key, index) => key === previous.itemKeys[index])) return null;
    const leading = this.props.snapshotAnchor?.();
    if (leading) return { ...leading, scrollTop: scroller.scrollTop };
    const surviving = new Set(itemKeys);
    const top = scroller.getBoundingClientRect().top;
    const row = [...scroller.querySelectorAll<HTMLElement>(this.props.rowSelector ?? '.virtual-item-wrapper')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > top && rect.top < top + scroller.clientHeight && surviving.has(element.dataset.virtualItemKey!);
    });
    return row ? { key: row.dataset.virtualItemKey!, offset: row.getBoundingClientRect().top - top, scrollTop: scroller.scrollTop } : null;
  }
  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    const { scrollerRef, canRepair, shift, onRepaired } = this.props;
    const scroller = scrollerRef.current;
    if (!snapshot || !scroller || !canRepair()) return;
    const row = [...scroller.querySelectorAll<HTMLElement>(this.props.rowSelector ?? '.virtual-item-wrapper')]
      .find(element => element.dataset.virtualItemKey === snapshot.key);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - snapshot.offset;
    // Measure the remaining error, not total height change. Measurements may
    // already have repaired some or all of it during child layout effects.
    if (Math.abs(delta) > 0.5 && shift(delta)) onRepaired?.();
  }
  render() { return this.props.children; }
}
