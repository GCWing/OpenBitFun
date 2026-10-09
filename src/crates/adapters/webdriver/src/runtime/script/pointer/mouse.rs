pub(super) fn script() -> &'static str {
    r####"
    const POINTER_BUTTON_MASK = {
      0: 1,
      1: 4,
      2: 2,
      3: 8,
      4: 16
    };

    const pointerButtonMask = (button) => POINTER_BUTTON_MASK[Number(button)] || 0;

    const getElementFromPoint = (frameContext, x, y) => {
      const doc = getCurrentDocument(frameContext);
      return doc.elementFromPoint(Number(x) || 0, Number(y) || 0);
    };

    const updatePointerTarget = (frameContext, x, y, fallbackTarget = null) => {
      const runtime = ensureRuntimeState();
      runtime.pointer.x = Number(x) || 0;
      runtime.pointer.y = Number(y) || 0;
      runtime.pointer.target =
        getElementFromPoint(frameContext, runtime.pointer.x, runtime.pointer.y) ||
        fallbackTarget ||
        runtime.pointer.target ||
        getActiveTarget(frameContext);
      return runtime.pointer.target;
    };

    const resolveActionOrigin = (origin, action, frameContext = currentFrameContext) => {
      const runtime = ensureRuntimeState();
      if (origin === "pointer") {
        return {
          x: runtime.pointer.x + (Number(action?.x) || 0),
          y: runtime.pointer.y + (Number(action?.y) || 0),
          target: null
        };
      }

      // Script arguments have already deserialized wire element references.
      if (isElementLike(origin) || (origin && typeof origin === "object" && typeof origin[ELEMENT_KEY] === "string")) {
        const element = isElementLike(origin) ? origin : getElement(origin[ELEMENT_KEY]);
        if (!element) {
          throw new Error("Element not found");
        }
        const { x, y } = getInViewCenter(element);
        return {
          x: x + (Number(action?.x) || 0),
          y: y + (Number(action?.y) || 0),
          target: element
        };
      }

      return {
        x: Number(action?.x) || 0,
        y: Number(action?.y) || 0,
        target: null
      };
    };

    const dispatchMouseEvent = (target, type, x, y, button, buttons, frameContext = currentFrameContext) => {
      if (!target) {
        return false;
      }
      const ownerWindow = getOwnerWindow(target, frameContext);
      const runtime = ensureRuntimeState();
      return target.dispatchEvent(
        new ownerWindow.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button,
          buttons,
          ctrlKey: !!runtime.modifiers.ctrl,
          shiftKey: !!runtime.modifiers.shift,
          altKey: !!runtime.modifiers.alt,
          metaKey: !!runtime.modifiers.meta
        })
      );
    };

    const maybeDispatchClick = (target, x, y, button, frameContext = currentFrameContext) => {
      if (!target) {
        return;
      }
      if (button === 2) {
        dispatchMouseEvent(target, "contextmenu", x, y, button, 0, frameContext);
        return;
      }
      dispatchMouseEvent(target, "click", x, y, button, 0, frameContext);
      const runtime = ensureRuntimeState();
      const clickTargetId = storeElement(target)?.[ELEMENT_KEY] || null;
      const now = Date.now();
      if (
        button === 0 &&
        runtime.pointer.lastClickButton === button &&
        runtime.pointer.lastClickTargetId === clickTargetId &&
        now - runtime.pointer.lastClickAt < 500
      ) {
        dispatchMouseEvent(target, "dblclick", x, y, button, 0, frameContext);
      }
      runtime.pointer.lastClickAt = now;
      runtime.pointer.lastClickButton = button;
      runtime.pointer.lastClickTargetId = clickTargetId;
    };

    const dispatchPointerClick = (element, button, doubleClick) => {
      if (!element) {
        throw new Error("Element not found");
      }
      scrollElementIntoView(element);
      focusWithoutScroll(element);
      const { x, y } = getInViewCenter(element);
      updatePointerTarget(getFrameContext(), x, y, element);
      const runtime = ensureRuntimeState();
      const buttonMask = pointerButtonMask(button);
      dispatchMouseEvent(element, "mouseover", x, y, button, runtime.pointer.buttons, getFrameContext());
      dispatchMouseEvent(element, "mousemove", x, y, button, runtime.pointer.buttons, getFrameContext());
      runtime.pointer.buttons |= buttonMask;
      dispatchMouseEvent(element, "mousedown", x, y, button, runtime.pointer.buttons, getFrameContext());
      runtime.pointer.buttons &= ~buttonMask;
      dispatchMouseEvent(element, "mouseup", x, y, button, runtime.pointer.buttons, getFrameContext());
      maybeDispatchClick(element, x, y, button, getFrameContext());
      if (doubleClick && button === 0) {
        dispatchMouseEvent(element, "dblclick", x, y, button, runtime.pointer.buttons, getFrameContext());
      }
    };
"####
}
