pub(super) fn script() -> &'static str {
    r####"
    const findScrollableTarget = (target, doc, deltaX, deltaY) => {
      let current = target;
      while (current && current !== doc.body && current !== doc.documentElement) {
        if (isElementLike(current)) {
          const style = getOwnerWindow(current).getComputedStyle(current);
          const wheelScrollable = (overflow) => ["auto", "scroll", "overlay"].includes(overflow);
          // overflow:hidden can be scrolled by script, but never by a user wheel.
          if (
            (deltaX && current.scrollWidth > current.clientWidth && wheelScrollable(style.overflowX)) ||
            (deltaY && current.scrollHeight > current.clientHeight && wheelScrollable(style.overflowY))
          ) {
            return current;
          }
        }
        current = current.parentElement;
      }
      const viewport = doc.scrollingElement || doc.documentElement || doc.body;
      if (!viewport) {
        return null;
      }
      const ownerWindow = doc.defaultView || window;
      const style = ownerWindow.getComputedStyle(viewport);
      const bodyStyle = doc.body ? ownerWindow.getComputedStyle(doc.body) : style;
      // Root overflow:visible propagates the body's overflow to the viewport.
      const overflowX = style.overflowX === "visible" ? bodyStyle.overflowX : style.overflowX;
      const overflowY = style.overflowY === "visible" ? bodyStyle.overflowY : style.overflowY;
      const wheelScrollable = (overflow) => overflow !== "hidden" && overflow !== "clip";
      return (
        (deltaX && viewport.scrollWidth > viewport.clientWidth && wheelScrollable(overflowX)) ||
        (deltaY && viewport.scrollHeight > viewport.clientHeight && wheelScrollable(overflowY))
      ) ? viewport : null;
    };

    const applyWheelScroll = (target, deltaX, deltaY, frameContext = currentFrameContext) => {
      const doc = getCurrentDocument(frameContext);
      const scrollTarget = findScrollableTarget(target, doc, deltaX, deltaY);
      if (!scrollTarget) {
        return;
      }
      if (scrollTarget === doc.body || scrollTarget === doc.documentElement || scrollTarget === doc.scrollingElement) {
        const ownerWindow = doc.defaultView || window;
        ownerWindow.scrollBy(deltaX, deltaY);
        return;
      }
      scrollTarget.scrollLeft += deltaX;
      scrollTarget.scrollTop += deltaY;
    };
"####
}
