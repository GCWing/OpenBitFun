import React from 'react';
import { readFlowChatScrollTop } from './flowChatScrollCoordinates';

interface Props {
  endOrigin: boolean;
  scrollerRef: React.RefObject<HTMLElement | null>;
  write: (top: number) => boolean;
  children: React.ReactNode;
}
interface Snapshot { element: HTMLElement | null; top: number; offset: number }

/** A history-to-live handoff changes the coordinate convention once. History
 * pages and reflows never enter this transaction or write the viewport. */
export class FlowChatScrollOriginBoundary extends React.Component<Props, object, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.endOrigin === this.props.endOrigin) return null;
    const scroller = this.props.scrollerRef.current;
    if (!scroller) return null;
    const viewportTop = scroller.getBoundingClientRect().top;
    const element = [...scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper')]
      .find(row => {
        const rect = row.getBoundingClientRect();
        return row.closest('[data-flowchat-scroller]') === scroller
          && rect.bottom > viewportTop && rect.top < viewportTop + scroller.clientHeight;
      }) ?? null;
    return { element, top: element?.getBoundingClientRect().top ?? 0, offset: readFlowChatScrollTop(scroller) };
  }
  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    const scroller = this.props.scrollerRef.current;
    if (!snapshot || !scroller) return;
    const top = snapshot.element?.isConnected
      ? readFlowChatScrollTop(scroller) + snapshot.element.getBoundingClientRect().top - snapshot.top
      : snapshot.offset;
    this.props.write(top);
  }
  render() { return this.props.children; }
}
