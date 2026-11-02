pub(super) fn script() -> &'static str {
    r####"
    const ensureStore = () => {
      if (!window[STORE_KEY]) {
        window[STORE_KEY] = Object.create(null);
      }
      return window[STORE_KEY];
    };

    const nextElementId = () => {
      window.__openbitfunWdElementCounter = (window.__openbitfunWdElementCounter || 0) + 1;
      return `openbitfun-el-${window.__openbitfunWdElementCounter}`;
    };

    const storeElement = (element) => {
      if (!element || typeof element !== "object") {
        return null;
      }
      const store = ensureStore();
      const existing = Object.entries(store).find(([, candidate]) => candidate === element);
      const id = existing ? existing[0] : nextElementId();
      store[id] = element;
      return { [ELEMENT_KEY]: id, ELEMENT: id };
    };

    const storeShadowRoot = (shadowRoot) => {
      if (!shadowRoot || typeof shadowRoot !== "object") {
        return null;
      }
      const store = ensureStore();
      const existing = Object.entries(store).find(([, candidate]) => candidate === shadowRoot);
      const id = existing ? existing[0] : nextElementId();
      store[id] = shadowRoot;
      return { [SHADOW_KEY]: id };
    };

    const getElement = (elementId) => {
      if (!elementId) {
        return null;
      }
      return ensureStore()[elementId] || null;
    };

    const serialize = (value, seen = new WeakSet()) => {
      if (value === undefined || value === null) {
        return value ?? null;
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      if (isElementLike(value)) {
        return storeElement(value);
      }
      // A page result may have a numeric `length` field (for example article
      // text metadata). Only native collections have array serialization.
      const collectionTag = Object.prototype.toString.call(value);
      if (Array.isArray(value) || ["[object NodeList]", "[object HTMLCollection]", "[object HTMLAllCollection]", "[object HTMLFormControlsCollection]", "[object HTMLOptionsCollection]"].includes(collectionTag)
        || (ArrayBuffer.isView(value) && typeof value.length === "number")) {
        return Array.from(value).map((item) => serialize(item, seen));
      }
      if (value && typeof value === "object" && "x" in value && "y" in value && "width" in value && "height" in value && "top" in value && "left" in value) {
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          left: value.left
        };
      }
      if (value && typeof value === "object" && "message" in value && "stack" in value) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack
        };
      }
      if (typeof value === "object") {
        if (seen.has(value)) {
          return null;
        }
        seen.add(value);
        const out = {};
        Object.keys(value).forEach((key) => {
          out[key] = serialize(value[key], seen);
        });
        return out;
      }
      return String(value);
    };

    const deserialize = (value) => {
      if (Array.isArray(value)) {
        return value.map(deserialize);
      }
      if (value && typeof value === "object") {
        if (typeof value[ELEMENT_KEY] === "string") {
          return getElement(value[ELEMENT_KEY]);
        }
        if (typeof value[SHADOW_KEY] === "string") {
          return getElement(value[SHADOW_KEY]);
        }
        const out = {};
        Object.keys(value).forEach((key) => {
          out[key] = deserialize(value[key]);
        });
        return out;
      }
      return value;
    };
"####
}
