import React from 'react';

interface Props {
  itemKeys: readonly string[];
  scrollerRef: React.RefObject<HTMLElement | null>;
  snapshotRef: React.MutableRefObject<{ firstKey: string; scrollHeight: number } | null>;
  children: React.ReactNode;
}

/** Read the old DOM only when history is actually inserted before its head.
 * A height saved after the previous commit can become stale as images or fonts
 * settle between commits. Capture immediately before mutation instead; the
 * viewport owner still decides and bounds compensation after mutation.
 */
export class FlowChatPrependSnapshot extends React.Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): null {
    this.props.snapshotRef.current = null;
    const firstKey = previous.itemKeys[0];
    if (firstKey && this.props.itemKeys[0] !== firstKey
      && this.props.itemKeys.indexOf(firstKey) > 0) {
      const scroller = this.props.scrollerRef.current;
      if (scroller) this.props.snapshotRef.current = { firstKey, scrollHeight: scroller.scrollHeight };
    }
    return null;
  }

  // React requires this lifecycle with getSnapshotBeforeUpdate. The parent
  // consumes the ref in its layout effect, after DOM mutation and before paint.
  componentDidUpdate(): void {}

  render() { return this.props.children; }
}
