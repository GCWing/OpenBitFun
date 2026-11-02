pub(super) fn script() -> &'static str {
    r####"
    const toFunction = (script, targetWindow) => {
      const trimmed = String(script || "").trim();
      if (!trimmed) {
        return () => null;
      }

      try {
        return targetWindow.eval(`(${trimmed})`);
      } catch (_error) {
        return targetWindow.Function(trimmed);
      }
    };

    const execute = async (script, args, asyncMode, frameContext) => {
      patchConsole();
      try {
        setFrameContext(frameContext);
        const targetWindow = getCurrentWindow(frameContext);
        patchDialogs(targetWindow);
        const fn = toFunction(script, targetWindow);
        const resolvedArgs = deserialize(args);
        let value;
        if (asyncMode) {
          value = await new Promise((resolve, reject) => {
            const callback = (result) => resolve(result);
            try {
              fn.apply(targetWindow, [...resolvedArgs, callback]);
            } catch (error) {
              reject(error);
            }
          });
        } else {
          value = await fn.apply(targetWindow, resolvedArgs);
        }
        return {
          ok: true,
          value: serialize(value)
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            name: error && error.name ? error.name : "Error",
            message: error && error.message ? error.message : String(error),
            stack: error && error.stack ? error.stack : null
          }
        };
      }
    };

    const run = async (requestId, script, args, asyncMode, frameContext) => {
      const response = await execute(script, args, asyncMode, frameContext);
      await emitResult({
        requestId,
        ok: response.ok,
        value: response.value,
        error: response.error
      });
    };

    const takeLogs = () => {
      const logs = ensureLogs().slice();
      ensureLogs().length = 0;
      return logs;
    };

    patchConsole();

    return {
      getElement,
      getCurrentWindow,
      getCurrentDocument,
      findElements,
      findElementsFromShadow,
      validateFrameByIndex,
      validateFrameElement,
      getShadowRoot,
      isDisplayed,
      scrollElementIntoView,
      focusWithoutScroll,
      clearElement,
      insertText,
      setElementText,
      dispatchPointerClick,
      performActions,
      releaseActions,
      getAllCookies,
      getCookie,
      addCookie,
      deleteCookie,
      deleteAllCookies,
      getAlertText,
      sendAlertText,
      closeAlert,
      takeLogs,
      execute,
      run
    };
"####
}
