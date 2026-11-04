import React from 'react';

export interface FlowChatPrependGeometrySnapshot {
  firstKey: string;
  scrollHeight: number;
  anchor?: { key: string; offsetPx: number };
}

interface Props {
  enabled?: boolean;
  itemKeys: readonly string[];
  scrollerRef: React.RefObject<HTMLElement | null>;
  snapshotRef: React.MutableRefObject<FlowChatPrependGeometrySnapshot | null>;
  captureAnchor?: (displacedKeys: ReadonlySet<string>) => FlowChatPrependGeometrySnapshot['anchor'];
  children: React.ReactNode;
}

/** Read the old DOM only when history is inserted before existing content.
 * Record pages can also fill earlier blocks inside an already loaded Turn.
 * A height saved after the previous commit can become stale as images or fonts
 * settle between commits. Capture immediately before mutation instead; the
 * viewport owner still decides and bounds compensation after mutation.
 */
export class FlowChatPrependSnapshot extends React.Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): null {
    this.props.snapshotRef.current = null;
    if (this.props.enabled === false) return null;
    // Streaming and tail appends leave every existing index unchanged.
    if (previous.itemKeys === this.props.itemKeys
      || previous.itemKeys.every((key, index) => this.props.itemKeys[index] === key)) return null;
    const firstKey = previous.itemKeys[0];
    const nextIndexes = new Map(this.props.itemKeys.map((key, index) => [key, index]));
    const displacedKeys = new Set(previous.itemKeys.filter((key, index) => (nextIndexes.get(key) ?? -1) > index));
    if (firstKey && displacedKeys.size > 0) {
      const scroller = this.props.scrollerRef.current;
      if (scroller) {
        const anchor = this.props.captureAnchor?.(displacedKeys);
        this.props.snapshotRef.current = {
          firstKey, scrollHeight: scroller.scrollHeight, ...(anchor ? { anchor } : {}),
        };
      }
    }
    return null;
  }

  // React requires this lifecycle with getSnapshotBeforeUpdate. The parent
  // consumes the ref in its layout effect, after DOM mutation and before paint.
  componentDidUpdate(): void {}

  render() { return this.props.children; }
}
