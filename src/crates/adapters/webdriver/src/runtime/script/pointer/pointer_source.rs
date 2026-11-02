pub(super) fn script() -> &'static str {
    r####"
    const performPointerSourceActions = async (runtime, source, frameContext = currentFrameContext) => {
      for (const action of source.actions) {
        if (action.type === "pause") {
          if (action.duration) {
            await sleep(action.duration);
          }
          continue;
        }

        if (action.type === "pointerMove") {
          if (action.duration) {
            await sleep(action.duration);
          }
          const origin = Object.prototype.hasOwnProperty.call(action, "origin") ? action.origin : "viewport";
          const resolved = resolveActionOrigin(origin, action, frameContext);
          const target = updatePointerTarget(frameContext, resolved.x, resolved.y, resolved.target);
          if (target) {
            dispatchMouseEvent(target, "mousemove", runtime.pointer.x, runtime.pointer.y, 0, runtime.pointer.buttons, frameContext);
          }
          continue;
        }

        const target =
          runtime.pointer.target ||
          updatePointerTarget(frameContext, runtime.pointer.x, runtime.pointer.y, getActiveTarget(frameContext));
        const button = Number(action.button || 0);
        const buttonMask = pointerButtonMask(button);
        if (!target) {
          throw new Error("Pointer target not found");
        }

        if (action.type === "pointerDown") {
          if (action.duration) {
            await sleep(action.duration);
          }
          focusWithoutScroll(target);
          runtime.pointer.buttons |= buttonMask;
          dispatchMouseEvent(target, "mousedown", runtime.pointer.x, runtime.pointer.y, button, runtime.pointer.buttons, frameContext);
          continue;
        }

        if (action.type === "pointerUp") {
          if (action.duration) {
            await sleep(action.duration);
          }
          runtime.pointer.buttons &= ~buttonMask;
          dispatchMouseEvent(target, "mouseup", runtime.pointer.x, runtime.pointer.y, button, runtime.pointer.buttons, frameContext);
          maybeDispatchClick(target, runtime.pointer.x, runtime.pointer.y, button, frameContext);
        }
      }
    };
"####
}
