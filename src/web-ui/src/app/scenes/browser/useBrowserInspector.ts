import { useCallback, useEffect, useRef, useState } from 'react';
import { useContextStore } from '@/shared/context-system';
import type { WebElementContext } from '@/shared/types/context';
import { createLogger } from '@/shared/utils/logger';
import { createInspectorScript, CANCEL_INSPECTOR_SCRIPT } from './browserInspectorScript';
import type { useEmbeddedBrowserWebview } from './useEmbeddedBrowserWebview';

const log = createLogger('BrowserInspector');
type ElementData = Pick<WebElementContext, 'tagName' | 'path' | 'attributes' | 'textContent' | 'outerHTML'>;
type Inspection = { label: string; unlisten: (() => void)[]; injected: boolean };

export function useBrowserInspector(browser: ReturnType<typeof useEmbeddedBrowserWebview>, active: boolean) {
  const { currentUrl, evalInWebview, getCurrentUrl, getWebviewLabel, hasWebview, isTauri } = browser;
  const addContext = useContextStore(state => state.addContext);
  const inspection = useRef<Inspection | null>(null);
  const [isInspectorActive, setIsInspectorActive] = useState(false);

  const stopInspector = useCallback(() => {
    const current = inspection.current;
    if (!current) return;
    inspection.current = null;
    current.unlisten.forEach(unlisten => unlisten());
    if (current.injected && current.label === getWebviewLabel()) {
      void evalInWebview(CANCEL_INSPECTOR_SCRIPT).catch(() => {});
    }
    setIsInspectorActive(false);
  }, [evalInWebview, getWebviewLabel]);

  useEffect(() => {
    return stopInspector;
  }, [currentUrl, stopInspector]);

  useEffect(() => {
    if (!active) stopInspector();
  }, [active, stopInspector]);

  const handleInspector = useCallback(async () => {
    if (inspection.current) {
      stopInspector();
      return;
    }
    const label = getWebviewLabel();
    if (!active || !isTauri || !hasWebview() || !label) return;

    const current: Inspection = { label, unlisten: [], injected: false };
    inspection.current = current;
    const register = (unlisten: () => void) => {
      if (inspection.current !== current) {
        unlisten();
        return false;
      }
      current.unlisten.push(unlisten);
      return true;
    };
    try {
      const { listen } = await import('@tauri-apps/api/event');
      if (inspection.current !== current) return;
      if (!register(await listen<ElementData>(`browser-inspector-element-selected-${label}`, ({ payload }) => {
        if (inspection.current !== current || getWebviewLabel() !== label) return;
        const timestamp = Date.now();
        const context: WebElementContext = {
          tagName: payload.tagName,
          path: payload.path,
          attributes: payload.attributes,
          textContent: payload.textContent,
          outerHTML: payload.outerHTML,
          id: `web-element-${timestamp}`,
          type: 'web-element',
          timestamp,
          sourceUrl: getCurrentUrl(),
        };
        addContext(context);
        window.dispatchEvent(new CustomEvent('insert-context-tag', { detail: { context } }));
      }))) return;
      if (!register(await listen(`browser-inspector-cancelled-${label}`, () => {
        if (inspection.current !== current) return;
        current.injected = false;
        stopInspector();
      }))) return;

      current.injected = true;
      await evalInWebview(createInspectorScript(label));
      if (inspection.current === current) setIsInspectorActive(true);
    } catch (error) {
      log.warn('Start browser inspector failed', error);
      if (inspection.current === current) stopInspector();
    }
  }, [active, addContext, evalInWebview, getCurrentUrl, getWebviewLabel, hasWebview, isTauri, stopInspector]);

  return { isInspectorActive, handleInspector, stopInspector };
}
