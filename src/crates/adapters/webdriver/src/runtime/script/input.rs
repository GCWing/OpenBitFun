pub(super) fn script() -> &'static str {
    r####"
    const setSelectionRange = (element, start, end) => {
      if (typeof element.setSelectionRange === "function") {
        element.setSelectionRange(start, end);
      }
    };

    const getElementValue = (element) => {
      if (!element || !("value" in element)) {
        return "";
      }
      return element.value;
    };

    const getNativeValueDescriptor = (element) => {
      const ownerWindow = element?.ownerDocument?.defaultView || window;
      if (element instanceof ownerWindow.HTMLInputElement) {
        return Object.getOwnPropertyDescriptor(ownerWindow.HTMLInputElement.prototype, "value");
      }
      if (element instanceof ownerWindow.HTMLTextAreaElement) {
        return Object.getOwnPropertyDescriptor(ownerWindow.HTMLTextAreaElement.prototype, "value");
      }
      return null;
    };

    const setElementValue = (element, nextValue) => {
      if (!element || !("value" in element)) {
        return;
      }
      const descriptor = getNativeValueDescriptor(element);
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(element, nextValue);
        return;
      }
      element.value = nextValue;
    };

    const dispatchBeforeInputEvent = (element, inputType, data = null) => {
      const ownerWindow = element?.ownerDocument?.defaultView || window;
      if (typeof ownerWindow.InputEvent === "function") {
        return element.dispatchEvent(new ownerWindow.InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType,
          data,
        }));
      }
      return element.dispatchEvent(new ownerWindow.Event("beforeinput", {
        bubbles: true,
        cancelable: true,
      }));
    };

    const emitInputEvents = (element, inputType = "insertText", data = null) => {
      const ownerWindow = element?.ownerDocument?.defaultView || window;
      if (typeof ownerWindow.InputEvent === "function") {
        element.dispatchEvent(new ownerWindow.InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType,
          data,
        }));
      } else {
        element.dispatchEvent(new ownerWindow.Event("input", { bubbles: true }));
      }
      element.dispatchEvent(new ownerWindow.Event("change", { bubbles: true }));
    };

    const clearElement = (element) => {
      if (!element) {
        return;
      }
      if ("value" in element || element.isContentEditable) {
        scrollElementIntoView(element);
        focusWithoutScroll(element);
      }
      if ("value" in element) {
        if (!dispatchBeforeInputEvent(element, "deleteContentBackward", null)) {
          return;
        }
        setElementValue(element, "");
        emitInputEvents(element, "deleteContentBackward", null);
        return;
      }
      if (element.isContentEditable) {
        element.textContent = "";
        emitInputEvents(element, "deleteContentBackward", null);
      }
    };

    const insertText = (element, text) => {
      if (!element) {
        return;
      }
      if ("value" in element) {
        const currentValue = String(getElementValue(element) || "");
        const start = typeof element.selectionStart === "number" ? element.selectionStart : currentValue.length;
        const end = typeof element.selectionEnd === "number" ? element.selectionEnd : currentValue.length;
        const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
        if (!dispatchBeforeInputEvent(element, "insertText", text)) {
          return;
        }
        setElementValue(element, nextValue);
        const caret = start + text.length;
        setSelectionRange(element, caret, caret);
        emitInputEvents(element, "insertText", text);
        return;
      }
      if (element.isContentEditable) {
        const ownerWindow = element.ownerDocument?.defaultView || window;
        if (!dispatchBeforeInputEvent(element, "insertText", text)) {
          return;
        }
        const selection = ownerWindow.getSelection();
        focusWithoutScroll(element);
        if (selection && selection.rangeCount > 0) {
          selection.deleteFromDocument();
          selection.getRangeAt(0).insertNode(element.ownerDocument.createTextNode(text));
          selection.collapseToEnd();
        } else {
          element.appendChild(element.ownerDocument.createTextNode(text));
        }
        emitInputEvents(element, "insertText", text);
      }
    };

    const setElementText = (element, text) => {
      clearElement(element);
      insertText(element, text);
    };
"####
}
