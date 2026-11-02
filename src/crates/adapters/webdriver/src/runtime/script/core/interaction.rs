pub(super) fn script() -> &'static str {
    r####"
    // Reveal an offscreen target with minimal movement. Centering also scrolls
    // overflow:hidden ancestors, which can displace the surrounding app chrome.
    const scrollElementIntoView = (element) => {
      element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    };

    // Positioning belongs to the caller; focus must not move it again, especially
    // after pointer coordinates have already been resolved.
    const focusWithoutScroll = (element) => {
      if (typeof element.focus === "function") {
        element.focus({ preventScroll: true });
      }
    };

    // A large target can remain only partly visible after nearest scrolling.
    // Use its visible center rather than a point outside the viewport.
    const getInViewCenter = (element) => {
      const rect = element.getClientRects()[0] || element.getBoundingClientRect();
      const ownerWindow = element.ownerDocument.defaultView || window;
      return {
        x: (Math.max(0, rect.left) + Math.min(ownerWindow.innerWidth, rect.right)) / 2,
        y: (Math.max(0, rect.top) + Math.min(ownerWindow.innerHeight, rect.bottom)) / 2
      };
    };
"####
}
