pub(super) fn script() -> &'static str {
    r####"
    const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
    const SHADOW_KEY = "shadow-6066-11e4-a52e-4f735466cecf";
    const STORE_KEY = "__openbitfunWdElements";
    const LOG_KEY = "__openbitfunWdLogs";
    const consolePatchedKey = "__openbitfunWdConsolePatched";
    let currentFrameContext = [];

    const ensureLogs = () => {
      if (!window[LOG_KEY]) {
        window[LOG_KEY] = [];
      }
      return window[LOG_KEY];
    };

    const safeStringify = (value) => {
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    };

    const shouldIgnoreLogMessage = (message) => {
      return /^JSON error: missing field `cmd` at line 1 column \d+$/.test(message);
    };

    const setFrameContext = (frameContext) => {
      currentFrameContext = Array.isArray(frameContext) ? frameContext : [];
    };

    const getFrameContext = () => currentFrameContext;

    const ensureRuntimeState = () => {
      if (!window.__openbitfunWdRuntimeState) {
        window.__openbitfunWdRuntimeState = {
          pointer: {
            x: 0,
            y: 0,
            target: null,
            buttons: 0,
            lastClickAt: 0,
            lastClickTargetId: null,
            lastClickButton: null
          },
          modifiers: {
            ctrl: false,
            shift: false,
            alt: false,
            meta: false
          }
        };
      }
      return window.__openbitfunWdRuntimeState;
    };

    const patchConsole = () => {
      if (window[consolePatchedKey]) {
        return;
      }
      window[consolePatchedKey] = true;
      ["log", "info", "warn", "error", "debug"].forEach((level) => {
        const original = console[level];
        console[level] = (...args) => {
          try {
            const message = args.map((item) => safeStringify(item)).join(" ");
            if (!shouldIgnoreLogMessage(message)) {
              ensureLogs().push({
                level: level === "warn" ? "WARNING" : level === "error" ? "SEVERE" : "INFO",
                message,
                timestamp: Date.now()
              });
            }
            if (ensureLogs().length > 200) {
              ensureLogs().splice(0, ensureLogs().length - 200);
            }
          } catch (_error) {}
          return original.apply(console, args);
        };
      });
    };

    const ensureAlertState = (targetWindow = window) => {
      if (!targetWindow.__openbitfunWdAlertState) {
        targetWindow.__openbitfunWdAlertState = {
          open: false,
          type: null,
          text: "",
          defaultValue: null,
          promptText: null
        };
      }
      return targetWindow.__openbitfunWdAlertState;
    };

    const patchDialogs = (targetWindow = window) => {
      const patchedKey = "__openbitfunWdDialogsPatched";
      if (targetWindow[patchedKey]) {
        return;
      }
      targetWindow[patchedKey] = true;

      const state = ensureAlertState(targetWindow);
      targetWindow.alert = (message) => {
        state.open = true;
        state.type = "alert";
        state.text = String(message ?? "");
        state.defaultValue = null;
        state.promptText = null;
      };
      targetWindow.confirm = (message) => {
        state.open = true;
        state.type = "confirm";
        state.text = String(message ?? "");
        state.defaultValue = null;
        state.promptText = null;
        return false;
      };
      targetWindow.prompt = (message, defaultValue = "") => {
        state.open = true;
        state.type = "prompt";
        state.text = String(message ?? "");
        state.defaultValue = defaultValue == null ? null : String(defaultValue);
        state.promptText = defaultValue == null ? null : String(defaultValue);
        return null;
      };
    };

"####
}
